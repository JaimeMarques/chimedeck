// Real PostgreSQL integration regression for the *actual* Move handler.
// Run only against a disposable, fully migrated sandbox DB (through 0123):
//   CHIMEDECK_TEST_SANDBOX=1 DATABASE_URL=postgres://.../chimedeck_preflight \
//     bun run tests/db/moveAuthorizationConcurrency.ts
// Never import the app's shared DB before validating the target: this script writes fixtures.
import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';

const databaseUrl = Bun.env.DATABASE_URL;
assert.equal(Bun.env.CHIMEDECK_TEST_SANDBOX, '1', 'Explicit CHIMEDECK_TEST_SANDBOX=1 opt-in required');
assert.ok(databaseUrl, 'DATABASE_URL must point to a disposable PostgreSQL database');
const url = new URL(databaseUrl);
const databaseName = decodeURIComponent(url.pathname.slice(1));
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'PostgreSQL URL required');
assert.match(databaseName, /(?:^|[_-])(test|preflight|scratch|sandbox)(?:$|[_-])/i, 'Refusing to write to a database without a test/preflight/scratch/sandbox name');
assert.ok(['localhost', '127.0.0.1', 'postgres', 'db'].includes(url.hostname), 'Refusing non-local PostgreSQL host');

const { db } = await import('../../server/common/db');
const { handleMoveCard } = await import('../../server/extensions/card/api/move');
const { lockWorkspaceMembershipMutations } = await import('../../server/extensions/workspace/api/members/lock');
const { lockBoardMemberMutations } = await import('../../server/extensions/board/api/members/lock');

const workspaceId = randomUUID();
const ownerId = randomUUID();
const moverId = randomUUID();
const sourceBoardId = randomUUID();
const targetBoardId = randomUUID();
const sourceListId = randomUUID();
const targetListId = randomUUID();
const cardId = randomUUID();
const tokenId = randomUUID();
const token = `hf_${randomUUID()}`;
const shortId = () => randomUUID().slice(0, 8);

function move(): Promise<Response> {
  const request = new Request(`http://localhost/api/v1/cards/${cardId}/move`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ targetListId }),
  });
  return handleMoveCard(request, cardId);
}

// Observes the handler's actual advisory wait, rather than relying on timing or
// an arbitrary sleep. The workspace UUID gives this test a unique lock key.
async function waitForMoveOnWorkspaceLock(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await db.raw<{ rows: Array<{ waiting: string }> }>(`
      SELECT count(*) AS waiting FROM pg_locks
       WHERE locktype = 'advisory' AND NOT granted
         AND classid::bigint = ((hashtext(?)::bigint >> 32) & 4294967295)
         AND objid::bigint = (hashtext(?)::bigint & 4294967295)
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
    `, [`workspace-memberships:${workspaceId}`, `workspace-memberships:${workspaceId}`]);
    if (Number(result.rows[0]?.waiting) > 0) return;
    await Bun.sleep(20);
  }
  throw new Error('Move never reached the workspace advisory lock after preflight');
}

async function cleanup(): Promise<void> {
  await db('api_tokens').where({ id: tokenId }).delete();
  await db('board_state_transitions').whereIn('board_id', [sourceBoardId, targetBoardId]).delete();
  await db('card_members').where({ card_id: cardId }).delete();
  await db('card_labels').where({ card_id: cardId }).delete();
  await db('cards').where({ id: cardId }).delete();
  await db('board_members').whereIn('board_id', [sourceBoardId, targetBoardId]).delete();
  await db('board_guest_access').whereIn('board_id', [sourceBoardId, targetBoardId]).delete();
  await db('lists').whereIn('id', [sourceListId, targetListId]).delete();
  await db('boards').whereIn('id', [sourceBoardId, targetBoardId]).delete();
  await db('memberships').where({ workspace_id: workspaceId }).delete();
  await db('workspaces').where({ id: workspaceId }).delete();
  await db('users').whereIn('id', [ownerId, moverId]).delete();
}

try {
  // Check the connected DB, not just the URL. In particular, require the 0123
  // transition writer trigger used by the second interleaving.
  const identity = await db.raw<{ rows: Array<{ name: string; trigger: boolean }> }>(`
    SELECT current_database() AS name, EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgname = 'state_transition_write_locks'
        AND tgrelid = 'board_state_transitions'::regclass AND NOT tgisinternal
    ) AS trigger
  `);
  assert.equal(identity.rows[0]?.name, databaseName);
  assert.equal(identity.rows[0]?.trigger, true, 'Migration 0123 must be applied to the sandbox DB');

  await db('users').insert([
    { id: ownerId, email: `${ownerId}@example.test`, name: 'Fixture owner', email_verified: true },
    { id: moverId, email: `${moverId}@example.test`, name: 'Fixture mover', email_verified: true },
  ]);
  await db('workspaces').insert({ id: workspaceId, name: `move-lock-${shortId()}`, owner_id: ownerId });
  await db('memberships').insert([
    { workspace_id: workspaceId, user_id: ownerId, role: 'OWNER' },
    { workspace_id: workspaceId, user_id: moverId, role: 'MEMBER' },
  ]);
  await db('boards').insert([
    { id: sourceBoardId, workspace_id: workspaceId, title: 'Source', visibility: 'PRIVATE', short_id: shortId() },
    { id: targetBoardId, workspace_id: workspaceId, title: 'Destination', visibility: 'PRIVATE', short_id: shortId() },
  ]);
  await db('board_members').insert([
    { id: randomUUID(), board_id: sourceBoardId, user_id: moverId, role: 'MEMBER' },
    { id: randomUUID(), board_id: targetBoardId, user_id: moverId, role: 'MEMBER' },
  ]);
  await db('lists').insert([
    { id: sourceListId, board_id: sourceBoardId, title: 'Source', short_id: shortId(), position: 'a0' },
    { id: targetListId, board_id: targetBoardId, title: 'Destination', short_id: shortId(), position: 'a0' },
  ]);
  await db('cards').insert({ id: cardId, list_id: sourceListId, title: 'Fixture', short_id: shortId(), position: 'a0', archived: false });
  await db('api_tokens').insert({
    id: tokenId, user_id: moverId, name: 'Disposable Move integration token',
    token_hash: createHash('sha256').update(token).digest('hex'), token_prefix: token.slice(0, 10),
  });

  // Preflight sees the destination grant, but Move waits for the workspace lock.
  // Commit revocation before Move acquires the lock; its fresh authorization must
  // reject the stale middleware snapshot, with no card location change.
  const revocation = await db.transaction();
  let firstMove: Promise<Response> | undefined;
  try {
    await lockWorkspaceMembershipMutations(revocation, workspaceId);
    firstMove = move();
    await waitForMoveOnWorkspaceLock();
    await lockBoardMemberMutations(revocation, targetBoardId);
    assert.equal(await revocation('board_members').where({ board_id: targetBoardId, user_id: moverId }).delete(), 1);
    await revocation.commit();
  } catch (error) {
    await revocation.rollback();
    if (firstMove) await firstMove.catch(() => {});
    throw error;
  }
  assert.ok(firstMove);
  const deniedMove = await firstMove;
  assert.equal(deniedMove.status, 403);
  assert.equal((await deniedMove.json() as { error: { code: string } }).error.code, 'board-access-denied');
  assert.equal((await db('cards').where({ id: cardId }).first<{ list_id: string }>())?.list_id, sourceListId);
  console.info('PASS Move rejects a destination grant revoked while its transaction waits');

  await db('board_members').insert({ id: randomUUID(), board_id: targetBoardId, user_id: moverId, role: 'MEMBER' });
  await db('board_state_transitions').insert({ id: randomUUID(), board_id: sourceBoardId, enabled: false });

  // The transition writer and Move contend on the *same* workspace lock. Its
  // trigger runs inside this transaction; the freshly enabled rule commits while
  // Move is queued, so Move must observe it and refuse cross-board movement.
  const enabling = await db.transaction();
  let secondMove: Promise<Response> | undefined;
  try {
    await lockWorkspaceMembershipMutations(enabling, workspaceId);
    secondMove = move();
    await waitForMoveOnWorkspaceLock();
    assert.equal(await enabling('board_state_transitions').where({ board_id: sourceBoardId }).update({ enabled: true }), 1);
    await enabling.commit();
  } catch (error) {
    await enabling.rollback();
    if (secondMove) await secondMove.catch(() => {});
    throw error;
  }
  assert.ok(secondMove);
  const blockedMove = await secondMove;
  assert.equal(blockedMove.status, 422);
  assert.equal((await blockedMove.json() as { error: { code: string } }).error.code, 'cross-board-transition-unsupported');
  assert.equal((await db('cards').where({ id: cardId }).first<{ list_id: string }>())?.list_id, sourceListId);
  console.info('PASS Move observes the transition update committed while its transaction waits');
} finally {
  try { await cleanup(); } finally { await db.destroy(); }
}
