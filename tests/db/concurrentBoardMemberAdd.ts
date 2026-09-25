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
import { handleJoinBoard } from '../../server/extensions/board/api/members/join';
import { lockWorkspaceMembershipMutations } from '../../server/extensions/workspace/api/members/lock';

const ws = `ws-${randomUUID()}`;
const boardId = `board-${randomUUID()}`;
const adminId = `user-${randomUUID()}`;
const targetId = `user-${randomUUID()}`;
const joinerId = `user-${randomUUID()}`;

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.info(
    `${ok ? 'PASS' : 'FAIL'}  ${label} — got ${String(actual)}, want ${String(expected)}`
  );
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
  });
}

function joinRequest(): Request {
  const req = new Request(`https://example.test/api/v1/boards/${boardId}/members/join`, {
    method: 'POST',
  });
  return Object.assign(req, {
    currentUser: { id: joinerId },
    workspaceId: ws,
    callerRole: 'MEMBER',
    board: { id: boardId, workspace_id: ws, visibility: 'WORKSPACE' },
  });
}

async function seed(): Promise<void> {
  await db('users').insert([
    {
      id: adminId,
      email: `admin-${randomUUID()}@example.test`,
      name: 'Admin',
      email_verified: true,
    },
    {
      id: targetId,
      email: `target-${randomUUID()}@example.test`,
      name: 'Target',
      email_verified: true,
    },
    {
      id: joinerId,
      email: `joiner-${randomUUID()}@example.test`,
      name: 'Joiner',
      email_verified: true,
    },
  ]);
  await db('workspaces').insert({ id: ws, name: 'concurrency', owner_id: adminId });
  await db('memberships').insert([
    { user_id: adminId, workspace_id: ws, role: 'ADMIN' },
    { user_id: targetId, workspace_id: ws, role: 'MEMBER' },
    { user_id: joinerId, workspace_id: ws, role: 'MEMBER' },
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
    await lockWorkspaceMembershipMutations(barrier, ws);
    await barrier.raw('LOCK TABLE board_members IN SHARE MODE');
    pending = Promise.allSettled([
      handleAddBoardMember(addRequest('MEMBER'), boardId),
      handleAddBoardMember(addRequest('ADMIN'), boardId),
    ]);
    const deadline = Date.now() + 10000;
    let waitingCount = 0;
    for (;;) {
      const waiting = await barrier.raw<{
        rows: Array<{ advisory_waiters: string; table_waiters: string }>;
      }>(`
        SELECT
          count(*) FILTER (WHERE locktype = 'advisory' AND NOT granted) AS advisory_waiters,
          count(*) FILTER (
            WHERE relation = 'board_members'::regclass
              AND mode = 'RowExclusiveLock' AND NOT granted
          ) AS table_waiters
        FROM pg_locks
        WHERE database = (SELECT oid FROM pg_database WHERE datname = current_database())
      `);
      waitingCount = Math.max(
        Number(waiting.rows[0]?.advisory_waiters),
        Number(waiting.rows[0]?.table_waiters)
      );
      if (waitingCount === 2) break;
      if (Date.now() >= deadline)
        throw new Error('Both inserts did not reach the database barrier');
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

  const rows = await db<{ role: string; board_id: string; user_id: string }>('board_members').where(
    {
      board_id: boardId,
      user_id: targetId,
    }
  );
  check('exactly one membership row exists', rows.length, 1);

  // A second, strictly sequential duplicate must behave the same way.
  const sequential = await handleAddBoardMember(
    addRequest(rows[0]?.role === 'ADMIN' ? 'MEMBER' : 'ADMIN'),
    boardId
  );
  check('sequential duplicate -> 409', sequential.status, 409);

  const after = await db<{ role: string; board_id: string; user_id: string }>('board_members')
    .where({ board_id: boardId, user_id: targetId })
    .first();
  check('the duplicate did not rewrite the role', after?.role, rows[0]?.role);

  // A target removed from the workspace while POST is queued must not be
  // inserted after the removal transaction has cleaned board rows.
  await db('board_members').where({ board_id: boardId, user_id: targetId }).delete();
  const addRemovalBarrier = await db.transaction();
  let staleAddPending: Promise<Response> | undefined;
  try {
    await lockWorkspaceMembershipMutations(addRemovalBarrier, ws);
    await addRemovalBarrier.raw('LOCK TABLE board_members IN SHARE MODE');
    staleAddPending = handleAddBoardMember(addRequest('MEMBER'), boardId);

    const deadline = Date.now() + 10000;
    for (;;) {
      const waiting = await db.raw<{
        rows: Array<{ advisory_waiters: string; table_waiters: string }>;
      }>(`
        SELECT
          count(*) FILTER (WHERE locktype = 'advisory' AND NOT granted) AS advisory_waiters,
          count(*) FILTER (
            WHERE relation = 'board_members'::regclass
              AND mode = 'RowExclusiveLock' AND NOT granted
          ) AS table_waiters
        FROM pg_locks
        WHERE database = (SELECT oid FROM pg_database WHERE datname = current_database())
      `);
      const row = waiting.rows[0];
      if (Number(row?.advisory_waiters) >= 1 || Number(row?.table_waiters) >= 1) break;
      if (Date.now() >= deadline)
        throw new Error('Queued member add did not reach the removal barrier');
      await Bun.sleep(20);
    }

    await addRemovalBarrier('memberships').where({ workspace_id: ws, user_id: targetId }).delete();
  } finally {
    await addRemovalBarrier.commit();
  }

  const staleAddResponse = await staleAddPending;
  check('queued member add revalidates removed target', staleAddResponse.status, 422);
  const staleAddRows = await db('board_members').where({ board_id: boardId, user_id: targetId });
  check('workspace removal plus member add leaves no orphan board row', staleAddRows.length, 0);

  // Self-join uses the same unique key and must also be atomic/idempotent.
  await db('boards').where({ id: boardId }).update({ visibility: 'WORKSPACE' });
  const joinBarrier = await db.transaction();
  let joinPending: Promise<PromiseSettledResult<Response>[]> | undefined;
  let joinOutcomes: PromiseSettledResult<Response>[] = [];
  try {
    await lockWorkspaceMembershipMutations(joinBarrier, ws);
    await joinBarrier.raw('LOCK TABLE board_members IN SHARE MODE');
    joinPending = Promise.allSettled([
      handleJoinBoard(joinRequest(), boardId),
      handleJoinBoard(joinRequest(), boardId),
    ]);
    const deadline = Date.now() + 10000;
    for (;;) {
      const waiting = await joinBarrier.raw<{
        rows: Array<{ advisory_waiters: string; table_waiters: string }>;
      }>(`
        SELECT
          count(*) FILTER (WHERE locktype = 'advisory' AND NOT granted) AS advisory_waiters,
          count(*) FILTER (
            WHERE relation = 'board_members'::regclass
              AND mode = 'RowExclusiveLock' AND NOT granted
          ) AS table_waiters
        FROM pg_locks
        WHERE database = (SELECT oid FROM pg_database WHERE datname = current_database())
      `);
      if (
        Number(waiting.rows[0]?.advisory_waiters) >= 2 ||
        Number(waiting.rows[0]?.table_waiters) >= 2
      )
        break;
      if (Date.now() >= deadline)
        throw new Error('Both self-joins did not reach the database barrier');
      await Bun.sleep(20);
    }
  } finally {
    await joinBarrier.rollback();
    if (joinPending) joinOutcomes = await joinPending;
  }

  const joinResponses = joinOutcomes.map((outcome) => {
    if (outcome.status === 'rejected') throw outcome.reason;
    return outcome.value;
  });
  const joinStatuses = joinResponses.map((response) => response.status).sort((a, b) => a - b);
  check('concurrent self-join loser returns existing membership', joinStatuses[0], 200);
  check('concurrent self-join winner returns 201', joinStatuses[1], 201);
  const joinedRows = await db('board_members').where({ board_id: boardId, user_id: joinerId });
  check('self-join creates exactly one membership', joinedRows.length, 1);

  const eventDeadline = Date.now() + 2000;
  let joinedEvent: { type?: string; payload?: { memberId?: string } } | undefined;
  while (Date.now() < eventDeadline) {
    joinedEvent = await db<{
      type: string;
      payload: { memberId?: string };
      board_id: string;
      actor_id: string;
      created_at: Date;
    }>('events')
      .where({ board_id: boardId, actor_id: joinerId })
      .orderBy('created_at', 'desc')
      .first();
    if (joinedEvent) break;
    await Bun.sleep(20);
  }
  check('self-join preserves the realtime event name', joinedEvent?.type, 'board_member_added');
  check('self-join supplies the automation memberId', joinedEvent?.payload?.memberId, joinerId);

  // Workspace removal must win over a join that was authorized before the
  // removal committed. Both operations follow workspace→board lock order; the
  // join then re-reads membership and cannot resurrect an orphan board row.
  await db('board_members').where({ board_id: boardId, user_id: joinerId }).delete();
  const removalBarrier = await db.transaction();
  let staleJoinPending: Promise<Response> | undefined;
  try {
    await lockWorkspaceMembershipMutations(removalBarrier, ws);
    await removalBarrier.raw('LOCK TABLE board_members IN SHARE MODE');
    staleJoinPending = handleJoinBoard(joinRequest(), boardId);

    const deadline = Date.now() + 10000;
    for (;;) {
      const waiting = await db.raw<{
        rows: Array<{ advisory_waiters: string; table_waiters: string }>;
      }>(`
        SELECT
          count(*) FILTER (WHERE locktype = 'advisory' AND NOT granted) AS advisory_waiters,
          count(*) FILTER (
            WHERE relation = 'board_members'::regclass
              AND mode = 'RowExclusiveLock' AND NOT granted
          ) AS table_waiters
        FROM pg_locks
        WHERE database = (SELECT oid FROM pg_database WHERE datname = current_database())
      `);
      const row = waiting.rows[0];
      if (Number(row?.advisory_waiters) >= 1 || Number(row?.table_waiters) >= 1) break;
      if (Date.now() >= deadline)
        throw new Error('Queued self-join did not reach the removal barrier');
      await Bun.sleep(20);
    }

    // This is the removal transaction's final membership delete. A fixed join
    // has not validated yet; a vulnerable join already validated and is queued
    // only on its late board_members insert.
    await removalBarrier('memberships').where({ workspace_id: ws, user_id: joinerId }).delete();
  } finally {
    await removalBarrier.commit();
  }

  const staleJoinResponse = await staleJoinPending;
  check('queued self-join revalidates removed membership', staleJoinResponse.status, 403);
  const orphanRows = await db('board_members').where({ board_id: boardId, user_id: joinerId });
  check('workspace removal plus self-join leaves no orphan board row', orphanRows.length, 0);
} finally {
  await db('board_members').where({ board_id: boardId }).delete();
  await db('boards').where({ id: boardId }).delete();
  await db('memberships').where({ workspace_id: ws }).delete();
  await db('workspaces').where({ id: ws }).delete();
  await db('users').whereIn('id', [adminId, targetId, joinerId]).delete();
  await db.destroy();
}

console.info(
  failures === 0
    ? '\nALL CONCURRENCY CHECKS PASSED'
    : `\n${String(failures)} CONCURRENCY CHECK(S) FAILED`
);
process.exit(failures === 0 ? 0 : 1);
