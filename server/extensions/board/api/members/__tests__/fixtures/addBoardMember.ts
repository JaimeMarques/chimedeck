import { strict as assert } from 'node:assert';
import { mock } from 'bun:test';

// Real handleAddBoardMember under test. The shared db module is mocked here in a
// subprocess so this fixture cannot leak a fake Knex chain into (or be replaced
// by) adjacent test files that mock '../../../../../../common/db' differently.
// Fake DB rows only — no live PostgreSQL coverage.

type Row = Record<string, unknown>;

const boardMembers: Row[] = [];
const memberships: Row[] = [];
const users: Row[] = [];
const boards: Row[] = [];
const inserted: Row[] = [];
const updated: Row[] = [];
const dispatched: Row[] = [];

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => row[key.replace(/^bm\./, '')] === value);
}

// Minimal Knex-style chain covering only the calls this handler makes.
function dbStub(table: string) {
  const state: { where: Row; notRole?: string } = { where: {} };
  const rows = () => {
    const source = table.startsWith('board_members')
      ? boardMembers
      : table === 'memberships'
        ? memberships
        : table === 'boards'
          ? boards
          : users;
    return source.filter(
      (row) =>
        matches(row, state.where) && (state.notRole === undefined || row.role !== state.notRole)
    );
  };
  const builder: Record<string, unknown> = {
    where(w: Row) {
      Object.assign(state.where, w);
      return builder;
    },
    whereNot(column: string, value: string) {
      if (column === 'role') state.notRole = value;
      return builder;
    },
    join: () => builder,
    select: () => builder,
    then: (resolve: (value: Row[]) => unknown) => Promise.resolve(rows()).then(resolve),
    first: () => Promise.resolve(rows()[0]),
    insert(row: Row) {
      // Model the real UNIQUE (board_id, user_id) constraint so the handler's
      // onConflict(...).ignore() path is exercised rather than stubbed away:
      // a conflicting insert writes nothing and returns no rows.
      const conflict = boardMembers.some(
        (r) => r['board_id'] === row['board_id'] && r['user_id'] === row['user_id']
      );
      const commit = (): Row[] => {
        if (conflict) return [];
        inserted.push(row);
        boardMembers.push(row);
        return [row];
      };
      const chain = {
        onConflict: () => chain,
        ignore: () => chain,
        merge: () => chain,
        returning: () => Promise.resolve(commit().map((r) => ({ id: r['id'] }))),
        then: (resolve: (value: Row[]) => unknown) => Promise.resolve(commit()).then(resolve),
      };
      return chain;
    },
    update(patch: Row) {
      updated.push({ ...state.where, ...patch });
      for (const row of rows()) Object.assign(row, patch);
      return Promise.resolve(1);
    },
  };
  return builder;
}

const db = Object.assign(dbStub, {
  raw: (sql: string) => sql,
  transaction: (callback: (trx: typeof dbStub) => unknown) => Promise.resolve(callback(db)),
});

await mock.module('../../../../../../common/db', () => ({ db }));
await mock.module('../../../../../../middlewares/permissionManager', () => ({
  requireRole: () => null, // caller is a workspace ADMIN throughout this fixture
  resolveHighestRole: (roles: string[]) => {
    const rank: Record<string, number> = { GUEST: 0, VIEWER: 1, MEMBER: 2, ADMIN: 3, OWNER: 4 };
    return roles.reduce<string | null>(
      (highest, role) => (!highest || (rank[role] ?? -1) > (rank[highest] ?? -1) ? role : highest),
      null
    );
  },
}));
await mock.module('../../../../../../mods/events/dispatch', () => ({
  dispatchEvent: (event: Row) => {
    dispatched.push(event);
    return Promise.resolve();
  },
}));

const { handleAddBoardMember } = await import('../../create');

function request(body: unknown): Request {
  const req = new Request('https://example.test/api/v1/boards/board-1/members', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  Object.assign(req, {
    board: { id: 'board-1', workspace_id: 'ws-1' },
    currentUser: { id: 'user-1' },
  });
  return req;
}

function reset(): void {
  boardMembers.length = 0;
  memberships.length = 0;
  users.length = 0;
  boards.length = 0;
  inserted.length = 0;
  updated.length = 0;
  dispatched.length = 0;
  memberships.push(
    { user_id: 'user-1', workspace_id: 'ws-1', role: 'ADMIN' },
    { user_id: 'user-2', workspace_id: 'ws-1', role: 'MEMBER' }
  );
  users.push({ id: 'user-2', email: 'new@example.com', name: 'New User', nickname: null });
  boards.push({ id: 'board-1', workspace_id: 'ws-1', visibility: 'PRIVATE' });
}

async function run(): Promise<void> {
  // 1. A workspace member who is not yet on the board is inserted as MEMBER.
  reset();
  let res = await handleAddBoardMember(request({ userId: 'user-2' }), 'board-1');
  assert.equal(res.status, 201);
  assert.equal(inserted.length, 1);
  const firstInsert = inserted[0] as Row;
  assert.equal(firstInsert.role, 'MEMBER');
  assert.equal(firstInsert.board_id, 'board-1');
  assert.deepEqual(dispatched, [
    {
      type: 'board_member_added',
      boardId: 'board-1',
      entityId: 'board-1',
      actorId: 'user-1',
      payload: { memberId: 'user-2', userId: 'user-2', role: 'MEMBER' },
    },
  ]);

  // 2. Re-adding an existing member is a conflict and never rewrites their role.
  //    This is the regression: it used to demote a board ADMIN to MEMBER.
  reset();
  boardMembers.push({ board_id: 'board-1', user_id: 'user-2', role: 'ADMIN' });
  res = await handleAddBoardMember(request({ userId: 'user-2' }), 'board-1');
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { name?: string }).name, 'board-member-exists');
  assert.equal(updated.length, 0);
  assert.equal((boardMembers[0] as Row).role, 'ADMIN');

  // 3. An unrecognised role is rejected instead of silently becoming MEMBER.
  //    The MCP invite_to_board tool offers 'observer', which this route never supported.
  reset();
  res = await handleAddBoardMember(request({ userId: 'user-2', role: 'observer' }), 'board-1');
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { name?: string }).name, 'invalid-role');
  assert.equal(inserted.length, 0);

  // 4. A supplied null role is invalid; only an omitted role defaults to MEMBER.
  reset();
  res = await handleAddBoardMember(request({ userId: 'user-2', role: null }), 'board-1');
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { name?: string }).name, 'invalid-role');
  assert.equal(inserted.length, 0);

  // 5. A valid role is accepted in any case — roles are stored uppercase.
  reset();
  res = await handleAddBoardMember(request({ userId: 'user-2', role: 'admin' }), 'board-1');
  assert.equal(res.status, 201);
  assert.equal((inserted[0] as Row).role, 'ADMIN');

  // 6. Unchanged: a non-workspace member still cannot be added to a board.
  reset();
  memberships.splice(1);
  res = await handleAddBoardMember(request({ userId: 'user-2' }), 'board-1');
  assert.equal(res.status, 422);
  assert.equal(((await res.json()) as { name?: string }).name, 'user-not-workspace-member');
  assert.equal(inserted.length, 0);

  // Email resolution requires real SQL joins/distinct and workspace locking;
  // its coverage lives in the CI-gated tests/db/addBoardMemberByEmail.ts.

  console.info(
    'handleAddBoardMember conflict, role validation, and workspace-membership gate verified'
  );
}

run().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
