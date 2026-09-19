import { strict as assert } from 'node:assert';
import { mock } from 'bun:test';

// Real handleAddBoardMember under test, exercising the email-based lookup. The
// shared db module is mocked here in a subprocess so this fixture cannot leak a
// fake Knex chain into (or be replaced by) adjacent test files that mock the
// shared db module differently. Fake DB rows only — no live PostgreSQL.

type Row = Record<string, unknown>;

const boardMembers: Row[] = [];
const memberships: Row[] = [];
const users: Row[] = [];
const inserted: Row[] = [];

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => row[key.replace(/^bm\./, '')] === value);
}

// Minimal Knex-style chain covering only the calls this handler makes.
function dbStub(table: string) {
  const state: {
    where: Row;
    notRole?: string;
    workspaceId?: string;
    lowerEmail?: string;
  } = { where: {} };

  const isUserJoin = table.startsWith('users');

  const rows = () => {
    if (isUserJoin) {
      // Mirrors the handler's workspace-scoped join: a user is only visible
      // when a non-GUEST membership ties them to this workspace.
      return users.filter((user) => {
        if (
          state.lowerEmail !== undefined &&
          String(user['email']).toLowerCase() !== state.lowerEmail
        ) {
          return false;
        }
        return memberships.some(
          (m) =>
            m['user_id'] === user['id'] &&
            (state.workspaceId === undefined || m['workspace_id'] === state.workspaceId) &&
            (state.notRole === undefined || m['role'] !== state.notRole),
        );
      });
    }

    const source = table.startsWith('board_members') ? boardMembers : memberships;
    return source.filter(
      (row) => matches(row, state.where) && (state.notRole === undefined || row['role'] !== state.notRole),
    );
  };

  const builder: Record<string, unknown> = {
    where(w: Row | string, value?: unknown) {
      if (typeof w === 'string') {
        if (w === 'm.workspace_id') state.workspaceId = value as string;
        else state.where[w] = value;
      } else {
        Object.assign(state.where, w);
      }
      return builder;
    },
    whereNot(column: string, value: string) {
      if (column === 'role' || column === 'm.role') state.notRole = value;
      return builder;
    },
    whereRaw(_sql: string, bindings: unknown[]) {
      state.lowerEmail = String(bindings[0]);
      return builder;
    },
    join: () => builder,
    distinct: () => builder,
    select: () => builder,
    first: () => Promise.resolve(rows()[0]),
    // The user lookup awaits the builder directly (no .first()), so it has to
    // resolve to the full row list rather than the builder itself.
    then: (resolve: (value: Row[]) => unknown) => Promise.resolve(rows()).then(resolve),
    insert(row: Row) {
      // Model the real UNIQUE (board_id, user_id) constraint so the handler's
      // onConflict(...).ignore() path is exercised rather than stubbed away.
      const conflict = boardMembers.some(
        (r) => r['board_id'] === row['board_id'] && r['user_id'] === row['user_id'],
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
    update: () => Promise.resolve(1),
  };
  return builder;
}

const db = Object.assign(dbStub, { raw: (sql: string) => sql });

await mock.module('../../../../../../common/db', () => ({ db }));
await mock.module('../../../../../../middlewares/permissionManager', () => ({
  requireRole: () => null, // caller is a workspace ADMIN throughout this fixture
}));
await mock.module('../../../../../../mods/events/dispatch', () => ({
  dispatchEvent: () => Promise.resolve(),
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
  inserted.length = 0;
  memberships.push({ user_id: 'user-2', workspace_id: 'ws-1', role: 'MEMBER' });
  users.push({ id: 'user-2', email: 'new@example.com', name: 'New User', nickname: null });
}

async function run(): Promise<void> {
  // 1. An email identifies the target user, so the MCP invite_to_board tool —
  //    which has only ever sent { email, role } — now works against this route.
  reset();
  let res = await handleAddBoardMember(request({ email: 'new@example.com' }), 'board-1');
  assert.equal(res.status, 201);
  assert.equal(inserted.length, 1);
  assert.equal((inserted[0] as Row)['user_id'], 'user-2');
  assert.equal((inserted[0] as Row)['role'], 'MEMBER');

  // 2. Email matching is case- and whitespace-insensitive on both sides:
  //    registration preserves the casing the user typed, so a stored
  //    `Mixed@Example.com` must still be reachable by `mixed@example.com`.
  reset();
  res = await handleAddBoardMember(request({ email: '  NEW@Example.com ' }), 'board-1');
  assert.equal(res.status, 201);
  assert.equal((inserted[0] as Row)['user_id'], 'user-2');

  reset();
  const mixedCaseUser = users[0];
  if (mixedCaseUser) mixedCaseUser['email'] = 'Mixed@Example.COM';
  res = await handleAddBoardMember(request({ email: 'mixed@example.com' }), 'board-1');
  assert.equal(res.status, 201);
  assert.equal((inserted[0] as Row)['user_id'], 'user-2');

  // 2b. Two accounts whose addresses differ only by case can both be eligible,
  //     because users.email is unique on raw casing only. Picking one would be
  //     a coin flip that could hand board ADMIN to the wrong account, so the
  //     request is refused and the caller is told to pass userId.
  reset();
  users.push({ id: 'user-9', email: 'NEW@example.com', name: 'Case Twin', nickname: null });
  memberships.push({ user_id: 'user-9', workspace_id: 'ws-1', role: 'MEMBER' });
  res = await handleAddBoardMember(request({ email: 'new@example.com' }), 'board-1');
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { name?: string }).name, 'ambiguous-email');
  assert.equal(inserted.length, 0, 'an ambiguous email must not add anyone');

  // 2c. Naming the account explicitly still works while the twin exists.
  reset();
  users.push({ id: 'user-9', email: 'NEW@example.com', name: 'Case Twin', nickname: null });
  memberships.push({ user_id: 'user-9', workspace_id: 'ws-1', role: 'MEMBER' });
  res = await handleAddBoardMember(request({ userId: 'user-9' }), 'board-1');
  assert.equal(res.status, 201);
  assert.equal((inserted[0] as Row)['user_id'], 'user-9');

  // 3. userId still works and wins when both are supplied.
  reset();
  users.push({ id: 'user-3', email: 'other@example.com', name: 'Other', nickname: null });
  memberships.push({ user_id: 'user-3', workspace_id: 'ws-1', role: 'MEMBER' });
  res = await handleAddBoardMember(
    request({ userId: 'user-3', email: 'new@example.com' }),
    'board-1',
  );
  assert.equal(res.status, 201);
  assert.equal((inserted[0] as Row)['user_id'], 'user-3');

  // 4. An unknown address and an address outside the workspace are
  //    indistinguishable: both 422 with the same body. Returning 404 for one
  //    and 422 for the other would let a board admin probe whether an arbitrary
  //    email has an account anywhere on the instance.
  reset();
  res = await handleAddBoardMember(request({ email: 'nobody@example.com' }), 'board-1');
  const unknownStatus = res.status;
  const unknownBody = await res.text();
  assert.equal(unknownStatus, 422);
  assert.equal(inserted.length, 0);

  reset();
  memberships.length = 0; // the account exists, but not in this workspace
  res = await handleAddBoardMember(request({ email: 'new@example.com' }), 'board-1');
  assert.equal(res.status, unknownStatus);
  assert.equal(await res.text(), unknownBody);
  assert.equal(inserted.length, 0);

  // 5. A workspace GUEST is not eligible either, matching the userId path.
  reset();
  memberships.length = 0;
  memberships.push({ user_id: 'user-2', workspace_id: 'ws-1', role: 'GUEST' });
  res = await handleAddBoardMember(request({ email: 'new@example.com' }), 'board-1');
  assert.equal(res.status, 422);
  assert.equal(inserted.length, 0);

  // 6. Neither identifier supplied is still a 400, with a message naming both.
  reset();
  res = await handleAddBoardMember(request({}), 'board-1');
  assert.equal(res.status, 400);
  const missing = (await res.json()) as { name?: string; data?: { message?: string } };
  assert.equal(missing.name, 'missing-user-id');
  assert.ok(missing.data?.message?.includes('email'));
  assert.equal(inserted.length, 0);

  // 7. An email that resolves to someone already on the board is still a conflict.
  reset();
  boardMembers.push({ board_id: 'board-1', user_id: 'user-2', role: 'ADMIN' });
  res = await handleAddBoardMember(request({ email: 'new@example.com' }), 'board-1');
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { name?: string }).name, 'board-member-exists');
  assert.equal((boardMembers[0] as Row)['role'], 'ADMIN');

  console.info(
    'handleAddBoardMember email lookup, case-insensitive matching, ambiguous-email refusal, userId precedence, indistinguishable ineligible responses, and duplicate gate verified',
  );
}

run().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
