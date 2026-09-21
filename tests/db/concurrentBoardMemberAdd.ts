// Concurrency regression for POST /boards/:id/members against real PostgreSQL.
//
//   DATABASE_URL=postgres://... bun run tests/db/concurrentBoardMemberAdd.ts
//
// Sequential fake-DB tests cannot show this: the failure mode is two requests
// interleaving between the read and the insert. board_members carries
// UNIQUE (board_id, user_id) (migration 0040), so the losing writer must be
// reported as 409 rather than surfacing PostgreSQL 23505 as a 500.
//
// Creates its own workspace/board/users and removes them at the end.
import { randomUUID } from 'node:crypto';
import { db } from '../../server/common/db';
import { handleAddBoardMember } from '../../server/extensions/board/api/members/create';

const ws = `ws-${randomUUID()}`;
const boardId = `board-${randomUUID()}`;
const adminId = `user-${randomUUID()}`;
const targetId = `user-${randomUUID()}`;

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.info(`${ok ? 'PASS' : 'FAIL'}  ${label} — got ${String(actual)}, want ${String(expected)}`);
}

function addRequest(role: string): Request {
  const req = new Request(`https://example.test/api/v1/boards/${boardId}/members`, {
    method: 'POST',
    body: JSON.stringify({ userId: targetId, role }),
    headers: { 'content-type': 'application/json' },
  });
  return Object.assign(req, {
    currentUser: { id: adminId },
    workspaceId: ws,
    callerRole: 'ADMIN',
    board: { id: boardId, workspace_id: ws, visibility: 'PRIVATE' },
  }) as Request;
}

async function seed(): Promise<void> {
  await db('users').insert([
    { id: adminId, email: `admin-${randomUUID()}@example.test`, name: 'Admin', email_verified: true },
    { id: targetId, email: `target-${randomUUID()}@example.test`, name: 'Target', email_verified: true },
  ]);
  await db('workspaces').insert({ id: ws, name: 'concurrency', owner_id: adminId });
  await db('memberships').insert([
    { user_id: adminId, workspace_id: ws, role: 'ADMIN' },
    { user_id: targetId, workspace_id: ws, role: 'MEMBER' },
  ]);
  await db('boards').insert({
    id: boardId,
    workspace_id: ws,
    title: 'concurrency',
    visibility: 'PRIVATE',
    short_id: randomUUID().slice(0, 8),
  });
  await db('board_members').insert({
    id: `bm-${randomUUID()}`,
    board_id: boardId,
    user_id: adminId,
    role: 'ADMIN',
  });
}

try {
  await seed();

  // SHARE permits SELECT but blocks INSERT's RowExclusiveLock. Hold it until
  // both writers are visibly waiting in PostgreSQL: any old read-then-insert
  // implementation must therefore finish BOTH absence checks before either
  // insert can run. Promise.all alone does not guarantee that interleaving.
  const barrier = await db.transaction();
  let pending: Promise<PromiseSettledResult<Response>[]> | undefined;
  let outcomes: PromiseSettledResult<Response>[] = [];
  try {
    await barrier.raw('LOCK TABLE board_members IN SHARE MODE');
    pending = Promise.allSettled([
      handleAddBoardMember(addRequest('MEMBER'), boardId),
      handleAddBoardMember(addRequest('ADMIN'), boardId),
    ]);
    const deadline = Date.now() + 10000;
    let waitingCount = 0;
    for (;;) {
      const waiting = await barrier.raw<{ rows: Array<{ count: string }> }>(`
        SELECT count(*) FROM pg_locks
        WHERE relation = 'board_members'::regclass
          AND mode = 'RowExclusiveLock' AND NOT granted
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
      `);
      waitingCount = Number(waiting.rows[0]?.count);
      if (waitingCount === 2) break;
      if (Date.now() >= deadline) throw new Error('Both inserts did not reach the database barrier');
      await Bun.sleep(20);
    }
    check('both inserts reached the barrier', waitingCount, 2);
  } finally {
    await barrier.rollback();
    // Drain both requests even if orchestration fails, before deleting fixtures.
    if (pending) outcomes = await pending;
  }
  const responses = outcomes.map((outcome) => {
    if (outcome.status === 'rejected') throw outcome.reason;
    return outcome.value;
  });

  const statuses = responses.map((r) => r.status).sort((a, b) => a - b);
  check('one add succeeds', statuses[0], 201);
  check('the other is a conflict, not a 500', statuses[1], 409);

  const rows = await db<{ role: string }>('board_members').where({ board_id: boardId, user_id: targetId });
  check('exactly one membership row exists', rows.length, 1);

  // A second, strictly sequential duplicate must behave the same way.
  const sequential = await handleAddBoardMember(addRequest(rows[0]?.role === 'ADMIN' ? 'MEMBER' : 'ADMIN'), boardId);
  check('sequential duplicate -> 409', sequential.status, 409);

  const after = await db<{ role: string }>('board_members').where({ board_id: boardId, user_id: targetId }).first();
  check('the duplicate did not rewrite the role', after?.role, rows[0]?.role);
} finally {
  await db('board_members').where({ board_id: boardId }).delete();
  await db('boards').where({ id: boardId }).delete();
  await db('memberships').where({ workspace_id: ws }).delete();
  await db('workspaces').where({ id: ws }).delete();
  await db('users').whereIn('id', [adminId, targetId]).delete();
  await db.destroy();
}

console.info(failures === 0 ? '\nALL CONCURRENCY CHECKS PASSED' : `\n${String(failures)} CONCURRENCY CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
