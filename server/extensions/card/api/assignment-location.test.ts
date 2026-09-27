import { beforeEach, describe, expect, mock, test } from 'bun:test';

type Row = Record<string, unknown>;
type Table = 'cards' | 'lists' | 'boards' | 'memberships' | 'users' | 'card_members' | 'checklist_items' | 'board_members' | 'board_guest_access';
let rows: Record<Table, Row[]>;
let assignmentFailure: Error | null = null;

class Query {
  private predicates: Array<(row: Row) => boolean> = [];
  constructor(private table: Table) {}
  where(criteria: Row): this {
    this.predicates.push((row) => Object.entries(criteria).every(([key, value]) => row[key] === value));
    return this;
  }
  select(..._columns: string[]): this { return this; }
  first(): Promise<Row | undefined> {
    const row = this.matches()[0];
    return Promise.resolve(row ? { ...row } : undefined);
  }
  insert(row: Row): { onConflict: (_fields: string[]) => { ignore: () => Promise<void> } } {
    return { onConflict: () => ({ ignore: () => {
      if (assignmentFailure) return Promise.reject(assignmentFailure);
      rows[this.table].push(row);
      return Promise.resolve();
    } }) };
  }
  update(patch: Row): Promise<number> {
    if (assignmentFailure) return Promise.reject(assignmentFailure);
    const matching = this.matches();
    for (const row of matching) Object.assign(row, patch);
    return Promise.resolve(matching.length);
  }
  private matches(): Row[] { return rows[this.table].filter((row) => this.predicates.every((predicate) => predicate(row))); }
}
const dbMock = Object.assign((table: Table) => new Query(table), {
  transaction: async (callback: (trx: typeof dbMock) => Promise<Response | null>) => callback(dbMock),
});
const authenticateMock = mock((req: Request & { currentUser?: { id: string } }) => {
  req.currentUser = { id: 'actor' };
  return Promise.resolve(null);
});
const requireWorkspaceMembershipMock = mock((): Promise<Response | null> => Promise.resolve(null));
const requireMemberOrBoardGuestMemberMock = mock(() => Promise.resolve(null));
const emitCardMemberAssignedMock = mock(() => Promise.resolve());
const dispatchEventMock = mock(() => Promise.resolve());
const writeActivityMock = mock(() => Promise.resolve({ id: 'activity' }));

void mock.module('../../../common/db', () => ({ db: dbMock }));
void mock.module('../../auth/middlewares/authentication', () => ({ authenticate: authenticateMock }));
void mock.module('../../../middlewares/permissionManager', () => ({
  requireWorkspaceMembership: requireWorkspaceMembershipMock,
  requireMemberOrBoardGuestMember: requireMemberOrBoardGuestMemberMock,
}));
void mock.module('../../board/api/members/authorization', () => ({ getCurrentWorkspaceRole: () => Promise.resolve('MEMBER') }));
void mock.module('../../board/api/members/lock', () => ({ lockBoardMemberMutations: () => Promise.resolve() }));
void mock.module('../../workspace/api/members/lock', () => ({ lockWorkspaceMembershipMutations: () => Promise.resolve() }));
void mock.module('../../activity/mods/createActivityEvent', () => ({
  emitCardMemberAssigned: emitCardMemberAssignedMock,
  emitCardMemberUnassigned: () => Promise.resolve(),
  emitCardMoved: () => Promise.resolve(),
}));
void mock.module('../../../mods/events/dispatch', () => ({ dispatchEvent: dispatchEventMock }));
void mock.module('../../activity/mods/write', () => ({ writeActivity: writeActivityMock }));
void mock.module('../../activity/events/publishCardActivityEvent', () => ({ publishCardActivityEvent: () => Promise.resolve() }));
void mock.module('../../activity/mods/mapActivityToNotification', () => ({ mapActivityToNotification: () => Promise.resolve() }));

const { handleAssignMember } = await import('./members');
const { handleUpdateChecklistItem } = await import('./checklist');

function locationError(): Error & { code: string } {
  return Object.assign(new Error('assignment card location changed while waiting for locks'), { code: '40001' });
}
function assignRequest(): Request {
  return new Request('http://localhost/api/v1/cards/card-1/members', {
    method: 'POST', body: JSON.stringify({ userId: 'target' }),
  });
}
function updateRequest(): Request {
  return new Request('http://localhost/api/v1/checklist-items/item-1', {
    method: 'PATCH', body: JSON.stringify({ assigned_member_id: 'target', checked: true }),
  });
}
beforeEach(() => {
  rows = {
    cards: [{ id: 'card-1', list_id: 'list-1', title: 'Card' }],
    lists: [{ id: 'list-1', board_id: 'board-1' }],
    boards: [{ id: 'board-1', workspace_id: 'workspace-1' }],
    memberships: [{ workspace_id: 'workspace-1', user_id: 'target', role: 'MEMBER' }],
    users: [{ id: 'target', name: 'Target', email: 'target@example.test' }],
    card_members: [],
    checklist_items: [{ id: 'item-1', card_id: 'card-1', title: 'Task', checked: false, assigned_member_id: null, checklist_id: null, due_date: null }],
    board_members: [{ board_id: 'board-1', user_id: 'target' }],
    board_guest_access: [],
  };
  assignmentFailure = null;
  emitCardMemberAssignedMock.mockClear();
  dispatchEventMock.mockClear();
  writeActivityMock.mockClear();
  requireWorkspaceMembershipMock.mockReset();
  requireWorkspaceMembershipMock.mockImplementation(() => Promise.resolve(null));
  requireMemberOrBoardGuestMemberMock.mockReset();
  requireMemberOrBoardGuestMemberMock.mockImplementation(() => Promise.resolve(null));
});

async function expectAssignmentFailure(operation: () => Promise<Response>, expected: Error): Promise<void> {
  let rejected: unknown;
  try {
    await operation();
  } catch (error) {
    rejected = error;
  }
  expect(rejected).toBe(expected);
}

describe('assignment card-location race', () => {
  test('card member assignment returns 409 and emits nothing when the trigger rejects a stale board', async () => {
    assignmentFailure = locationError();
    const response = await handleAssignMember(assignRequest(), 'card-1');
    expect(response.status).toBe(409);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('card-location-changed');
    expect(rows.card_members).toHaveLength(0);
    expect(emitCardMemberAssignedMock).not.toHaveBeenCalled();
  });

  test('checklist assignment returns 409 without updating fields or emitting activity/events', async () => {
    assignmentFailure = locationError();
    const response = await handleUpdateChecklistItem(updateRequest(), 'item-1');
    expect(response.status).toBe(409);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('card-location-changed');
    expect(rows.checklist_items[0]?.assigned_member_id).toBeNull();
    expect(rows.checklist_items[0]?.checked).toBe(false);
    expect(dispatchEventMock).not.toHaveBeenCalled();
    expect(writeActivityMock).not.toHaveBeenCalled();
  });

  test('successful card member assignment still emits its event', async () => {
    const response = await handleAssignMember(assignRequest(), 'card-1');
    expect(response.status).toBe(201);
    expect(rows.card_members).toEqual([{ card_id: 'card-1', user_id: 'target' }]);
    expect(emitCardMemberAssignedMock).toHaveBeenCalledTimes(1);
  });

  test('successful checklist assignment still updates and publishes its event', async () => {
    const response = await handleUpdateChecklistItem(updateRequest(), 'item-1');
    expect(response.status).toBe(200);
    expect(rows.checklist_items[0]?.assigned_member_id).toBe('target');
    expect(rows.checklist_items[0]?.checked).toBe(true);
    expect(dispatchEventMock).toHaveBeenCalledTimes(1);
  });

  test('unrelated serialization failures still propagate', async () => {
    assignmentFailure = Object.assign(new Error('could not serialize access due to concurrent update'), { code: '40001' });
    await expectAssignmentFailure(() => handleAssignMember(assignRequest(), 'card-1'), assignmentFailure);
    await expectAssignmentFailure(() => handleUpdateChecklistItem(updateRequest(), 'item-1'), assignmentFailure);
    expect(emitCardMemberAssignedMock).not.toHaveBeenCalled();
    expect(dispatchEventMock).not.toHaveBeenCalled();
  });

  test('other database failures still propagate', async () => {
    assignmentFailure = Object.assign(new Error('check constraint violated'), { code: '23514' });
    await expectAssignmentFailure(() => handleAssignMember(assignRequest(), 'card-1'), assignmentFailure);
    await expectAssignmentFailure(() => handleUpdateChecklistItem(updateRequest(), 'item-1'), assignmentFailure);
  });

  test('denied workspace membership never starts an assignment', async () => {
    requireWorkspaceMembershipMock.mockImplementation(() => Promise.resolve(Response.json({ error: { code: 'forbidden' } }, { status: 403 })));
    expect((await handleAssignMember(assignRequest(), 'card-1')).status).toBe(403);
    expect((await handleUpdateChecklistItem(updateRequest(), 'item-1')).status).toBe(403);
    expect(rows.card_members).toHaveLength(0);
    expect(emitCardMemberAssignedMock).not.toHaveBeenCalled();
  });
});
