// Real PostgreSQL regression for card Copy destination authorization and atomic
// list deletion. Run only against a disposable, fully migrated sandbox DB:
//   CHIMEDECK_TEST_SANDBOX=1 DATABASE_URL=postgres://.../chimedeck_preflight \
//     bun run tests/db/copyDestinationAndListDelete.ts
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
const { cardRouter } = await import('../../server/extensions/card/api/index');
const { listRouter } = await import('../../server/extensions/list/api/index');

const shortId = () => randomUUID().slice(0, 8);
const workspaceId = randomUUID();
const otherWorkspaceId = randomUUID();
const ownerId = randomUUID();
const memberId = randomUUID();
const guestId = randomUUID();
const userIds = [ownerId, memberId, guestId];
const boards = {
  source: randomUUID(),
  allowed: randomUUID(),
  privateNoAccess: randomUUID(),
  archived: randomUUID(),
  guestViewer: randomUUID(),
  otherWorkspace: randomUUID(),
};
const boardIds = Object.values(boards);
const lists = Object.fromEntries(Object.keys(boards).map((key) => [key, randomUUID()])) as Record<keyof typeof boards, string>;
const deleteLists = { empty: randomUUID(), withCard: randomUUID(), race: randomUUID(), relocated: randomUUID() };
const relocatedListId = randomUUID();
const sourceCardId = randomUUID();
const tokens = Object.fromEntries(userIds.map((id) => [id, { id: randomUUID(), token: `hf_${randomUUID()}` }]));

function authorized(userId: string, path: string, init: RequestInit): Request {
  const headers = { authorization: `Bearer ${tokens[userId]?.token}`, 'content-type': 'application/json' };
  return new Request(`http://localhost${path}`, { ...init, headers });
}

async function copyTo(userId: string, targetListId: string): Promise<Response> {
  const path = `/api/v1/cards/${sourceCardId}/copy`;
  const response = await cardRouter(authorized(userId, path, { method: 'POST', body: JSON.stringify({ targetListId }) }), path);
  assert.ok(response, 'card router did not handle copy');
  return response;
}

async function deleteList(listId: string, body?: unknown): Promise<Response> {
  const path = `/api/v1/lists/${listId}`;
  const init: RequestInit = { method: 'DELETE', ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
  const response = await listRouter(authorized(ownerId, path, init), path);
  assert.ok(response, 'list router did not handle delete');
  return response;
}

async function cardCount(listId: string): Promise<number> {
  const row = await db('cards').where({ list_id: listId }).count<{ count: string }[]>('id as count').first();
  return Number(row?.count ?? 0);
}

async function errorCode(response: Response): Promise<string | undefined> {
  return ((await response.json()) as { error?: { code?: string } }).error?.code;
}

// Pending = still waiting after the handler had ample time to finish an uncontended request.
async function isPending(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol('pending');
  return (await Promise.race([promise.then(() => null, () => null), Bun.sleep(500).then(() => marker)])) === marker;
}

async function cleanup(): Promise<void> {
  await db('api_tokens').whereIn('id', Object.values(tokens).map((token) => token.id)).delete();
  await db('events').whereIn('board_id', boardIds).delete();
  await db('boards').whereIn('id', boardIds).delete();
  await db('memberships').whereIn('workspace_id', [workspaceId, otherWorkspaceId]).delete();
  await db('workspaces').whereIn('id', [workspaceId, otherWorkspaceId]).delete();
  await db('users').whereIn('id', userIds).delete();
}

try {
  await db('users').insert(userIds.map((id) => ({ id, email: `${id}@example.test`, name: 'Fixture user', email_verified: true })));
  await db('workspaces').insert([
    { id: workspaceId, name: `copy-delete-${shortId()}`, owner_id: ownerId },
    { id: otherWorkspaceId, name: `copy-delete-other-${shortId()}`, owner_id: ownerId },
  ]);
  await db('memberships').insert([
    { workspace_id: workspaceId, user_id: ownerId, role: 'OWNER' },
    { workspace_id: workspaceId, user_id: memberId, role: 'MEMBER' },
    { workspace_id: workspaceId, user_id: guestId, role: 'GUEST' },
    { workspace_id: otherWorkspaceId, user_id: ownerId, role: 'OWNER' },
  ]);
  await db('boards').insert([
    { id: boards.source, workspace_id: workspaceId, title: 'Source', visibility: 'PRIVATE', short_id: shortId() },
    { id: boards.allowed, workspace_id: workspaceId, title: 'Allowed', visibility: 'WORKSPACE', short_id: shortId() },
    { id: boards.privateNoAccess, workspace_id: workspaceId, title: 'Private', visibility: 'PRIVATE', short_id: shortId() },
    { id: boards.archived, workspace_id: workspaceId, title: 'Archived', visibility: 'WORKSPACE', state: 'ARCHIVED', short_id: shortId() },
    { id: boards.guestViewer, workspace_id: workspaceId, title: 'Guest viewer', visibility: 'PRIVATE', short_id: shortId() },
    { id: boards.otherWorkspace, workspace_id: otherWorkspaceId, title: 'Other workspace', visibility: 'WORKSPACE', short_id: shortId() },
  ]);
  await db('board_members').insert({ id: randomUUID(), board_id: boards.source, user_id: memberId, role: 'MEMBER' });
  await db('board_guest_access').insert([
    { id: randomUUID(), board_id: boards.source, user_id: guestId, granted_by: ownerId, guest_type: 'MEMBER' },
    { id: randomUUID(), board_id: boards.guestViewer, user_id: guestId, granted_by: ownerId, guest_type: 'VIEWER' },
  ]);
  await db('lists').insert([
    ...Object.entries(lists).map(([key, id]) => ({ id, board_id: boards[key as keyof typeof boards], title: key, short_id: shortId(), position: 'a0' })),
    ...Object.entries(deleteLists).map(([key, id], index) => ({ id, board_id: boards.allowed, title: `delete-${key}`, short_id: shortId(), position: `b${index}` })),
    { id: relocatedListId, board_id: boards.allowed, title: 'relocated', short_id: shortId(), position: 'c0' },
  ]);
  await db('cards').insert([
    { id: sourceCardId, list_id: lists.source, title: 'Fixture', short_id: shortId(), position: 'a0', archived: false },
    { id: randomUUID(), list_id: deleteLists.withCard, title: 'Keep me', short_id: shortId(), position: 'a0', archived: false },
    { id: randomUUID(), list_id: deleteLists.relocated, title: 'Keep me too', short_id: shortId(), position: 'a0', archived: false },
  ]);
  await db('api_tokens').insert(Object.entries(tokens).map(([userId, { id, token }]) => ({
    id, user_id: userId, name: 'Disposable copy/delete integration token',
    token_hash: createHash('sha256').update(token).digest('hex'), token_prefix: token.slice(0, 10),
  })));

  // Copy: each unauthorized destination is rejected before any card row is inserted.
  const deniedCopies: Array<[string, string, keyof typeof boards, number, string]> = [
    ['another workspace', memberId, 'otherWorkspace', 403, 'cross-workspace-copy-forbidden'],
    ['a PRIVATE board without access', memberId, 'privateNoAccess', 403, 'board-access-denied'],
    ['an ARCHIVED board', memberId, 'archived', 403, 'board-is-archived'],
    ['a board where a source guest-MEMBER is only VIEWER', guestId, 'guestViewer', 403, 'insufficient-role'],
  ];
  for (const [label, userId, target, status, code] of deniedCopies) {
    const response = await copyTo(userId, lists[target]);
    assert.equal(response.status, status, label);
    assert.equal(await errorCode(response), code, label);
    assert.equal(await cardCount(lists[target]), 0, `${label}: no card inserted`);
    console.info(`PASS Copy into ${label} is rejected with ${code} and inserts nothing`);
  }

  const copied = await copyTo(memberId, lists.allowed);
  assert.equal(copied.status, 201);
  assert.equal(await cardCount(lists.allowed), 1);
  const sameBoard = await copyTo(guestId, lists.source);
  assert.equal(sameBoard.status, 201);
  console.info('PASS Copy into an authorized board (and within the source board) still succeeds');

  // Race: the authorized destination list is relocated to another workspace's board while
  // the copy is in flight (as PUT /lists/:id/idBoard does). The copy must wait for the
  // relocation, see the new board and refuse, instead of landing in the other workspace.
  const relocating = await db.transaction();
  let pendingCopy: Promise<Response> | undefined;
  try {
    await relocating('lists').where({ id: relocatedListId }).update({ board_id: boards.otherWorkspace });
    pendingCopy = copyTo(memberId, relocatedListId);
    assert.equal(await isPending(pendingCopy), true, 'copy must wait for the in-flight list relocation');
    await relocating.commit();
  } catch (error) {
    await relocating.rollback();
    if (pendingCopy) await pendingCopy.catch(() => {});
    throw error;
  }
  const racedCopy = await pendingCopy;
  assert.equal(racedCopy.status, 409);
  assert.equal(await errorCode(racedCopy), 'target-list-changed');
  assert.equal(await cardCount(relocatedListId), 0);
  console.info('PASS Copy waits for a destination list relocation and refuses with no card inserted');

  // Delete: unchanged contract for empty, unconfirmed and confirmed deletes.
  assert.equal((await deleteList(deleteLists.empty)).status, 204);
  assert.equal(await db('lists').where({ id: deleteLists.empty }).first(), undefined);
  const unconfirmed = await deleteList(deleteLists.withCard);
  assert.equal(unconfirmed.status, 409);
  assert.deepEqual(await unconfirmed.json(), { name: 'delete-requires-confirmation', data: { cardCount: 1 } });
  assert.equal(await cardCount(deleteLists.withCard), 1);
  assert.equal((await deleteList(deleteLists.withCard, { confirm: true })).status, 204);
  assert.equal(await cardCount(deleteLists.withCard), 0);
  console.info('PASS List delete keeps its empty/409/confirm contract');

  // Race 1: a card insert is in flight (uncommitted, holding the FK KEY SHARE lock on
  // the list row). An unconfirmed delete must wait for it, then see the card and 409.
  const inserting = await db.transaction();
  let pendingDelete: Promise<Response> | undefined;
  const racedCardId = randomUUID();
  try {
    await inserting('cards').insert({ id: racedCardId, list_id: deleteLists.race, title: 'Raced', short_id: shortId(), position: 'a0', archived: false });
    pendingDelete = deleteList(deleteLists.race);
    assert.equal(await isPending(pendingDelete), true, 'delete must wait for the in-flight card insert');
    await inserting.commit();
  } catch (error) {
    await inserting.rollback();
    if (pendingDelete) await pendingDelete.catch(() => {});
    throw error;
  }
  const racedDelete = await pendingDelete;
  assert.equal(racedDelete.status, 409);
  assert.equal(await cardCount(deleteLists.race), 1);
  console.info('PASS Unconfirmed delete waits for an in-flight card insert and refuses');

  // Race 2: while a delete holds FOR UPDATE on the list, a card insert must block, then
  // fail on the FK once the delete commits, instead of being silently cascaded away.
  await db('cards').where({ id: racedCardId }).delete();
  const deleting = await db.transaction();
  let pendingInsert: Promise<unknown> | undefined;
  try {
    await deleting('lists').where({ id: deleteLists.race }).forUpdate().first();
    pendingInsert = db('cards').insert({ id: randomUUID(), list_id: deleteLists.race, title: 'Late', short_id: shortId(), position: 'a0', archived: false });
    assert.equal(await isPending(pendingInsert), true, 'card insert must wait for the list row lock');
    await deleting('lists').where({ id: deleteLists.race }).del();
    await deleting.commit();
  } catch (error) {
    await deleting.rollback();
    if (pendingInsert) await pendingInsert.catch(() => {});
    throw error;
  }
  await assert.rejects(pendingInsert, (error: { code?: string }) => error.code === '23503');
  console.info('PASS Card insert blocks on the delete row lock and fails on the FK after commit');

  // Race 3: the list is relocated to another workspace's board while a confirmed delete is
  // in flight. The delete must wait, see the new board and refuse, keeping the list and cards.
  const relocatingList = await db.transaction();
  let pendingRelocatedDelete: Promise<Response> | undefined;
  try {
    await relocatingList('lists').where({ id: deleteLists.relocated }).update({ board_id: boards.otherWorkspace });
    pendingRelocatedDelete = deleteList(deleteLists.relocated, { confirm: true });
    assert.equal(await isPending(pendingRelocatedDelete), true, 'delete must wait for the in-flight list relocation');
    await relocatingList.commit();
  } catch (error) {
    await relocatingList.rollback();
    if (pendingRelocatedDelete) await pendingRelocatedDelete.catch(() => {});
    throw error;
  }
  const relocatedDelete = await pendingRelocatedDelete;
  assert.equal(relocatedDelete.status, 409);
  assert.equal(await errorCode(relocatedDelete), 'target-list-changed');
  assert.ok(await db('lists').where({ id: deleteLists.relocated }).first(), 'relocated list must survive');
  assert.equal(await cardCount(deleteLists.relocated), 1);
  console.info('PASS Confirmed delete waits for a list relocation and refuses, keeping the list and its cards');
} finally {
  try { await cleanup(); } finally { await db.destroy(); }
}
