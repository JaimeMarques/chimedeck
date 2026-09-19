// Last-board-admin invariant against real PostgreSQL, including concurrency.
//
//   DATABASE_URL=postgres://... bun run tests/db/lastBoardAdminInvariant.ts
//
// Fake-DB handler tests cannot establish this property: the failure mode is two
// requests interleaving between the admin-count read and the write, and the fix
// relies on a real transaction plus a per-board advisory lock. Every assertion
// below is read back out of SQL.
//
// Creates its own workspace/boards/users and removes them at the end.
import { randomUUID } from 'node:crypto';
import { db } from '../../server/common/db';
import { handleUpdateBoardMember } from '../../server/extensions/board/api/members/update';
import { handleRemoveBoardMember } from '../../server/extensions/board/api/members/remove';
import { boardsRouter } from '../../server/extensions/trelloCompat/api/boards/index';
import { handleAddMember } from '../../server/extensions/workspace/api/members/add';
import { issueAccessToken } from '../../server/extensions/auth/mods/token/issue';

const ws = `ws-${randomUUID()}`;
const boardId = `board-${randomUUID()}`;
const adminA = `user-${randomUUID()}`;
const adminB = `user-${randomUUID()}`;
const actor = `user-${randomUUID()}`;
const guestEmail = `guest-${randomUUID()}@example.test`;
const guestId = `user-${randomUUID()}`;

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.info(`${ok ? 'PASS' : 'FAIL'}  ${label} — got ${String(actual)}, want ${String(expected)}`);
}

async function adminCount(board = boardId): Promise<number> {
  const row = await db('board_members')
    .where({ board_id: board, role: 'ADMIN' })
    .count('id as c')
    .first<{ c: string }>();
  return Number(row?.c ?? 0);
}

function nativeReq(method: string, body?: unknown): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  const r = new Request(`https://example.test/api/v1/boards/${boardId}/members`, init);
  return Object.assign(r, {
    currentUser: { id: actor },
    workspaceId: ws,
    callerRole: 'ADMIN',
    board: { id: boardId, workspace_id: ws, visibility: 'PRIVATE' },
  }) as Request;
}

function trelloReq(method: string): Request {
  const r = new Request(`https://example.test/1/boards/${boardId}/members/x`, { method });
  return Object.assign(r, { currentUser: { id: actor } }) as Request;
}

async function resetBoard(admins: string[]): Promise<void> {
  await db('board_members').where({ board_id: boardId }).delete();
  for (const id of admins) {
    await db('board_members').insert({
      id: `bm-${randomUUID()}`,
      board_id: boardId,
      user_id: id,
      role: 'ADMIN',
    });
  }
}

async function seed(): Promise<void> {
  await db('users').insert([
    { id: adminA, email: `a-${randomUUID()}@example.test`, name: 'A', email_verified: true },
    { id: adminB, email: `b-${randomUUID()}@example.test`, name: 'B', email_verified: true },
    { id: actor, email: `actor-${randomUUID()}@example.test`, name: 'Actor', email_verified: true },
    { id: guestId, email: guestEmail, name: 'Guest', email_verified: true },
  ]);
  await db('workspaces').insert({ id: ws, name: 'invariant', owner_id: actor });
  await db('memberships').insert([
    { user_id: actor, workspace_id: ws, role: 'ADMIN' },
    { user_id: adminA, workspace_id: ws, role: 'MEMBER' },
    { user_id: adminB, workspace_id: ws, role: 'MEMBER' },
    { user_id: guestId, workspace_id: ws, role: 'GUEST' },
  ]);
  await db('boards').insert({
    id: boardId,
    workspace_id: ws,
    title: 'invariant',
    visibility: 'PRIVATE',
    short_id: randomUUID().slice(0, 8),
  });
}

try {
  await seed();

  // 1. THE CONCURRENCY CASE. Two admins, each demoted at the same moment.
  //    Without a shared transaction and lock both observe count = 2 and both
  //    proceed, emptying the admin set.
  await resetBoard([adminA, adminB]);
  check('two admins before the race', await adminCount(), 2);

  const [resA, resB] = await Promise.all([
    handleUpdateBoardMember(nativeReq('PATCH', { role: 'MEMBER' }), boardId, adminA),
    handleUpdateBoardMember(nativeReq('PATCH', { role: 'MEMBER' }), boardId, adminB),
  ]);
  const statuses = [resA.status, resB.status].sort((a, b) => a - b);
  check('one demotion succeeds', statuses[0], 200);
  check('the other is refused', statuses[1], 409);
  check('the board still has an admin in SQL', await adminCount(), 1);

  // 2. Same race through DELETE.
  await resetBoard([adminA, adminB]);
  const [delA, delB] = await Promise.all([
    handleRemoveBoardMember(nativeReq('DELETE'), boardId, adminA),
    handleRemoveBoardMember(nativeReq('DELETE'), boardId, adminB),
  ]);
  const delStatuses = [delA.status, delB.status].sort((a, b) => a - b);
  check('one removal succeeds', delStatuses[0], 200);
  check('the other is refused', delStatuses[1], 409);
  check('an admin remains in SQL', await adminCount(), 1);

  // 3. Mixed writers racing: a native demote against a Trello-compat delete.
  await resetBoard([adminA, adminB]);
  const [mixedNative, mixedTrello] = await Promise.all([
    handleUpdateBoardMember(nativeReq('PATCH', { role: 'MEMBER' }), boardId, adminA),
    boardsRouter(trelloReq('DELETE') as never, `/boards/${boardId}/members/${adminB}`),
  ]);
  const mixed = [mixedNative.status, (mixedTrello as Response).status].sort((a, b) => a - b);
  check('one of the mixed pair succeeds', mixed[0], 200);
  check('the other is refused', mixed[1], 409);
  check('an admin remains in SQL', await adminCount(), 1);

  // 4. The sequential guards still hold on the sole admin.
  await resetBoard([adminA]);
  const sole = await handleUpdateBoardMember(nativeReq('PATCH', { role: 'MEMBER' }), boardId, adminA);
  check('sole admin cannot be demoted', sole.status, 409);
  check('still an admin in SQL', await adminCount(), 1);

  // 5. THE FIFTH WRITER. Promoting a workspace GUEST bulk-upserts board_members
  //    across every board, which would overwrite a sole board ADMIN with MEMBER.
  await resetBoard([guestId]);
  check('the guest is the board\'s only admin', await adminCount(), 1);

  // handleAddMember runs the real authenticate(), so mint a real signed token.
  const actorRow = await db('users').where({ id: actor }).first<{ email: string }>();
  const actorToken = await issueAccessToken({ sub: actor, email: actorRow!.email });
  const promoteReq = Object.assign(
    new Request(`https://example.test/api/v1/workspaces/${ws}/members`, {
      method: 'POST',
      body: JSON.stringify({ email: guestEmail, role: 'MEMBER' }),
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${actorToken}` },
    }),
    { workspaceId: ws, callerRole: 'ADMIN' },
  ) as Request;

  const promoted = await handleAddMember(promoteReq, ws);
  check('the workspace promotion still succeeds', promoted.status < 400, true);

  const membership = await db('memberships')
    .where({ workspace_id: ws, user_id: guestId })
    .first<{ role: string }>();
  check('the guest is now a workspace MEMBER', membership?.role, 'MEMBER');
  check('but the board still has an admin in SQL', await adminCount(), 1);

  const boardRow = await db('board_members')
    .where({ board_id: boardId, user_id: guestId })
    .first<{ role: string }>();
  check('and they were not downgraded on that board', boardRow?.role, 'ADMIN');
} finally {
  await db('board_members').where({ board_id: boardId }).delete();
  await db('board_guest_access').where({ board_id: boardId }).delete();
  await db('boards').where({ id: boardId }).delete();
  await db('memberships').where({ workspace_id: ws }).delete();
  await db('workspaces').where({ id: ws }).delete();
  await db('users').whereIn('id', [adminA, adminB, actor, guestId]).delete();
  await db.destroy();
}

console.info(
  failures === 0 ? '\nALL INVARIANT CHECKS PASSED' : `\n${failures} INVARIANT CHECK(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
