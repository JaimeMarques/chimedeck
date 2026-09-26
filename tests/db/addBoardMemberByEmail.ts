// Email-identified board-member adds against real PostgreSQL.
//
//   DATABASE_URL=postgres://... bun run tests/db/addBoardMemberByEmail.ts
//
// The fake-DB fixture models the lookup in TypeScript; this exercises the
// actual SQL — LOWER(u.email), the memberships join, and DISTINCT across
// case-variant accounts, which is the collision the review flagged. Every
// assertion is read back out of the database.
//
// Creates its own workspace/board/users and removes them at the end.
import { randomUUID } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { db } from '../../server/common/db';
import { handleAddBoardMember } from '../../server/extensions/board/api/members/create';
import { lockWorkspaceMembershipMutations } from '../../server/extensions/workspace/api/members/lock';

const ws = `ws-${randomUUID()}`;
const boardId = `board-${randomUUID()}`;
const actor = `user-${randomUUID()}`;
const plain = `user-${randomUUID()}`;
const twin = `user-${randomUUID()}`;
const outsider = `user-${randomUUID()}`;
const guest = `user-${randomUUID()}`;

const localPart = `case-${randomUUID().slice(0, 8)}`;
const lowerEmail = `${localPart}@example.test`;
const upperEmail = `${localPart.toUpperCase()}@Example.test`;
const soloEmail = `solo-${randomUUID().slice(0, 8)}@example.test`;
const outsiderEmail = `out-${randomUUID().slice(0, 8)}@example.test`;
const guestEmail = `guest-${randomUUID().slice(0, 8)}@example.test`;

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.info(
    `${ok ? 'PASS' : 'FAIL'}  ${label} — got ${String(actual)}, want ${String(expected)}`
  );
}

function request(body: unknown): Request {
  const r = new Request(`https://example.test/api/v1/boards/${boardId}/members`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  return Object.assign(r, {
    currentUser: { id: actor },
    workspaceId: ws,
    callerRole: 'ADMIN',
    board: { id: boardId, workspace_id: ws, visibility: 'PRIVATE' },
  }) as Request;
}

async function boardMemberIds(): Promise<string[]> {
  const rows = await db('board_members').where({ board_id: boardId }).select('user_id');
  return (rows as Array<{ user_id: string }>).map((r) => r.user_id).sort();
}

async function resetBoard(): Promise<void> {
  await db('board_members').where({ board_id: boardId }).delete();
  await db('board_members').insert({
    id: `bm-${randomUUID()}`,
    board_id: boardId,
    user_id: actor,
    role: 'ADMIN',
  });
}

try {
  await db('users').insert([
    { id: actor, email: `actor-${randomUUID()}@example.test`, name: 'Actor', email_verified: true },
    { id: plain, email: soloEmail, name: 'Solo', email_verified: true },
    { id: twin, email: upperEmail, name: 'Twin Upper', email_verified: true },
    { id: outsider, email: outsiderEmail, name: 'Outsider', email_verified: true },
    { id: guest, email: guestEmail, name: 'Guest', email_verified: true },
  ]);
  await db('workspaces').insert({ id: ws, name: 'email-lookup', owner_id: actor });
  await db('memberships').insert([
    { user_id: actor, workspace_id: ws, role: 'ADMIN' },
    { user_id: plain, workspace_id: ws, role: 'MEMBER' },
    { user_id: twin, workspace_id: ws, role: 'MEMBER' },
    { user_id: guest, workspace_id: ws, role: 'GUEST' },
    // `outsider` deliberately has no membership in this workspace.
  ]);
  await db('boards').insert({
    id: boardId,
    workspace_id: ws,
    title: 'email-lookup',
    visibility: 'PRIVATE',
    short_id: randomUUID().slice(0, 8),
  });

  // 1. A single eligible account is found case-insensitively by real SQL.
  await resetBoard();
  let res = await handleAddBoardMember(request({ email: soloEmail.toUpperCase() }), boardId);
  check('add by upper-cased email -> 201', res.status, 201);
  check('  the member row exists in SQL', (await boardMemberIds()).includes(plain), true);

  await resetBoard();
  res = await handleAddBoardMember(request({ email: `  ${lowerEmail}  ` }), boardId);
  check('stored mixed-case account -> 201', res.status, 201);
  check('  the mixed-case account was added', (await boardMemberIds()).includes(twin), true);

  // 2. THE COLLISION. A second account differing only by case is inserted, so
  //    two rows now satisfy LOWER(u.email) = ?. Picking either could grant
  //    board ADMIN to the wrong person, so the route must refuse.
  await db('users').insert({
    id: `user-${randomUUID()}`,
    email: lowerEmail,
    name: 'Twin Lower',
    email_verified: true,
  });
  const lowerRow = await db('users').where({ email: lowerEmail }).first<{ id: string }>();
  assert.ok(lowerRow);
  const twinLower = lowerRow.id;
  await db('memberships').insert({ user_id: twinLower, workspace_id: ws, role: 'MEMBER' });

  const normalized = await db('users')
    .whereRaw('LOWER(email) = ?', [lowerEmail.toLowerCase()])
    .count('id as c')
    .first<{ c: string } | undefined>();
  check('two accounts share the normalized address', Number(normalized?.c ?? 0), 2);

  await resetBoard();
  res = await handleAddBoardMember(request({ email: lowerEmail, role: 'ADMIN' }), boardId);
  check('ambiguous email -> 409', res.status, 409);
  check('  error name', ((await res.json()) as { name?: string }).name, 'ambiguous-email');
  check('  nobody was added in SQL', (await boardMemberIds()).join(','), actor);

  // 3. Naming the account explicitly still works while the twin exists.
  await resetBoard();
  res = await handleAddBoardMember(
    request({ userId: twin, email: soloEmail, role: 'ADMIN' }),
    boardId
  );
  check('explicit userId -> 201', res.status, 201);
  check('  the named account was added', (await boardMemberIds()).includes(twin), true);

  res = await handleAddBoardMember(request({ userId: twin }), boardId);
  check('duplicate -> 409', res.status, 409);
  const existing = await db('board_members')
    .where({ board_id: boardId, user_id: twin })
    .first<{ role: string } | undefined>();
  check('duplicate preserves ADMIN', existing?.role, 'ADMIN');

  // A newly eligible case twin must be seen after the workspace lock, not
  // resolved before waiting and then accidentally granted ADMIN by cached ID.
  await resetBoard();
  await db('memberships').where({ workspace_id: ws, user_id: twinLower }).delete();
  const barrier = await db.transaction();
  let pending: Promise<Response> | undefined;
  try {
    await lockWorkspaceMembershipMutations(barrier, ws);
    pending = handleAddBoardMember(request({ email: lowerEmail, role: 'ADMIN' }), boardId);
    const deadline = Date.now() + 10_000;
    for (;;) {
      const waiting = await db.raw<{ rows: Array<{ n: string }> }>(`
        SELECT count(*) AS n FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
      `);
      if (Number(waiting.rows[0]?.n) > 0) break;
      assert.ok(Date.now() < deadline, 'email add must reach the workspace lock');
      await Bun.sleep(20);
    }
    await barrier('memberships').insert({ user_id: twinLower, workspace_id: ws, role: 'MEMBER' });
    await barrier.commit();
  } finally {
    if (!barrier.isCompleted()) await barrier.rollback();
    if (pending) await Promise.allSettled([pending]);
  }
  assert.ok(pending);
  res = await pending;
  check('queued email add rechecks ambiguity -> 409', res.status, 409);
  check('queued ambiguous add writes nobody', (await boardMemberIds()).join(','), actor);

  // 4. An account outside the workspace and a workspace GUEST are both
  //    ineligible, and indistinguishable from an unknown address.
  await resetBoard();
  res = await handleAddBoardMember(request({ email: outsiderEmail }), boardId);
  const outsiderBody = await res.text();
  check('outsider -> 422', res.status, 422);

  await resetBoard();
  res = await handleAddBoardMember(request({ email: guestEmail }), boardId);
  check('workspace GUEST -> 422', res.status, 422);
  check('  identical guest body to outsider', await res.text(), outsiderBody);

  await resetBoard();
  res = await handleAddBoardMember(
    request({ email: `nobody-${randomUUID()}@example.test` }),
    boardId
  );
  check('unknown address -> 422', res.status, 422);
  check('  identical body to the outsider case', await res.text(), outsiderBody);

  res = await handleAddBoardMember(request({}), boardId);
  check('missing identifiers -> 400', res.status, 400);
  check(
    '  missing identifier error',
    ((await res.json()) as { name?: string }).name,
    'missing-user-id'
  );
} finally {
  await db('board_members').where({ board_id: boardId }).delete();
  await db('boards').where({ id: boardId }).delete();
  await db('memberships').where({ workspace_id: ws }).delete();
  await db('workspaces').where({ id: ws }).delete();
  await db('users')
    .whereIn('email', [soloEmail, upperEmail, lowerEmail, outsiderEmail, guestEmail])
    .delete();
  await db('users').where({ id: actor }).delete();
  await db.destroy();
}

console.info(
  failures === 0 ? '\nALL EMAIL-LOOKUP CHECKS PASSED' : `\n${String(failures)} EMAIL-LOOKUP CHECK(S) FAILED`
);
process.exit(failures === 0 ? 0 : 1);
