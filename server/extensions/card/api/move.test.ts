import { beforeEach, describe, expect, mock, test } from 'bun:test';

type Row = Record<string, unknown>;
type Store = {
  boards: Row[];
  lists: Row[];
  cards: Row[];
  comments: Row[];
  attachments: Row[];
  checklists: Row[];
  checklist_items: Row[];
  card_members: Row[];
  card_labels: Row[];
};
type TableName = keyof Store;

let store: Store;

function requireRow(tableName: TableName, id: string): Row {
  const row = store[tableName].find((candidate) => candidate.id === id);
  if (!row) throw new Error(`Missing ${tableName} fixture ${id}`);
  return row;
}

class QueryBuilder {
  private filters: Array<(row: Row) => boolean> = [];

  constructor(private readonly tableName: TableName) {}

  where(criteria: Row): this {
    this.filters.push((row) => Object.entries(criteria).every(([key, value]) => row[key] === value));
    return this;
  }

  whereNot(criteria: Row): this {
    this.filters.push((row) => Object.entries(criteria).every(([key, value]) => row[key] !== value));
    return this;
  }

  orderBy(field: string, direction: 'asc' | 'desc' = 'asc'): this {
    const factor = direction === 'asc' ? 1 : -1;
    store[this.tableName].sort((left, right) => String(left[field]).localeCompare(String(right[field])) * factor);
    return this;
  }

  select(...columns: string[]): Promise<Row[]> {
    return Promise.resolve(this.rows().map((row) => Object.fromEntries(columns.map((column) => [column, row[column]]))));
  }

  first(): Promise<Row | undefined> {
    return Promise.resolve(this.rows()[0]);
  }

  update(patch: Row, returning?: string[]): Promise<number | Row[]> {
    const rows = this.rows();
    rows.forEach((row) => Object.assign(row, patch));
    return Promise.resolve(returning ? rows.map((row) => ({ ...row })) : rows.length);
  }

  then<TResult1 = Row[], TResult2 = never>(
    onfulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.rows().map((row) => ({ ...row }))).then(onfulfilled, onrejected);
  }

  private rows(): Row[] {
    return store[this.tableName].filter((row) => this.filters.every((filter) => filter(row)));
  }
}

const dbMock = Object.assign(
  (tableName: TableName) => new QueryBuilder(tableName),
  {
    transaction: async (callback: (trx: typeof dbMock) => Promise<void>) => callback(dbMock),
  },
);

const authenticateMock = mock((req: Request & { currentUser?: { id: string } }) => {
  req.currentUser = { id: 'user-1' };
  return Promise.resolve(null);
});

const requireCardWritableMock = mock((req: Request & { card?: Row; board?: Row }) => {
  req.card = { ...requireRow('cards', 'card-source') };
  req.board = { ...requireRow('boards', 'board-source') };
  return Promise.resolve(null);
});

const requireWorkspaceMembershipMock = mock((req: Request & { callerRole?: string }, _workspaceId: string) => {
  req.callerRole = 'MEMBER';
  return Promise.resolve(null);
});
const requireMemberOrBoardGuestMemberMock = mock(() => Promise.resolve(null));
const validateCardMoveMock = mock(() => Promise.resolve(undefined));
const applyBoardVisibilityMock = mock((_req?: Request, _boardId?: string): Promise<Response | null> => Promise.resolve(null));
const dispatchEventMock = mock(() => Promise.resolve());
const emitCardMovedMock = mock(() => Promise.resolve());
const publishMock = mock((_boardId: string, _payload: string): Promise<void> => Promise.resolve());

void mock.module('../../../common/db', () => ({ db: dbMock }));
void mock.module('../../auth/middlewares/authentication', () => ({ authenticate: authenticateMock }));
void mock.module('../middlewares/requireCardWritable', () => ({ requireCardWritable: requireCardWritableMock }));
void mock.module('../../../middlewares/permissionManager', () => ({
  requireWorkspaceMembership: requireWorkspaceMembershipMock,
  requireMemberOrBoardGuestMember: requireMemberOrBoardGuestMemberMock,
}));
void mock.module('../../../middlewares/boardVisibility', () => ({ applyBoardVisibility: applyBoardVisibilityMock }));
void mock.module('../../stateTransitions/enforcement', () => ({ validateCardMove: validateCardMoveMock }));
void mock.module('../../../mods/events/dispatch', () => ({ dispatchEvent: dispatchEventMock }));
void mock.module('../../activity/mods/createActivityEvent', () => ({ emitCardMoved: emitCardMovedMock }));
void mock.module('../../../mods/pubsub/publisher', () => ({ publisher: { publish: publishMock } }));
void mock.module('../../realtime/mods/conflictHandler', () => ({ recordConflict: mock(() => undefined) }));

const { handleMoveCard } = await import('./move');
const { StateTransitionForbiddenError } = await import('../../stateTransitions/common/errors');

function resetStore(): Store {
  return {
    boards: [
      { id: 'board-source', workspace_id: 'workspace-source', state: 'ACTIVE', visibility: 'PRIVATE' },
      { id: 'board-target', workspace_id: 'workspace-target', state: 'ACTIVE', visibility: 'PRIVATE' },
    ],
    lists: [
      { id: 'list-source', board_id: 'board-source', title: 'Source', archived: false },
      { id: 'list-target', board_id: 'board-target', title: 'Target', archived: false },
    ],
    cards: [
      {
        id: 'card-source',
        list_id: 'list-source',
        title: 'Source card',
        archived: false,
        position: 'a',
        start_date: '2026-01-01T00:00:00.000Z',
        due_date: '2026-01-02T00:00:00.000Z',
        cover_type: 'color',
        cover_value: '#123456',
      },
    ],
    comments: [{ id: 'comment-1', card_id: 'card-source', content: 'Preserve me' }],
    attachments: [{ id: 'attachment-1', card_id: 'card-source', name: 'proof.txt' }],
    checklists: [{ id: 'checklist-1', card_id: 'card-source', title: 'Checklist' }],
    checklist_items: [{ id: 'item-1', card_id: 'card-source', checklist_id: 'checklist-1' }],
    card_members: [{ card_id: 'card-source', user_id: 'user-1' }],
    card_labels: [{ card_id: 'card-source', label_id: 'label-1' }],
  };
}

beforeEach(() => {
  store = resetStore();
  authenticateMock.mockClear();
  requireCardWritableMock.mockClear();
  requireWorkspaceMembershipMock.mockClear();
  requireMemberOrBoardGuestMemberMock.mockClear();
  validateCardMoveMock.mockClear();
  applyBoardVisibilityMock.mockReset();
  applyBoardVisibilityMock.mockImplementation(() => Promise.resolve(null));
  dispatchEventMock.mockClear();
  emitCardMovedMock.mockClear();
  publishMock.mockClear();
});

describe('card move destination boundaries', () => {
  test('moves across accessible boards in one workspace without changing card identity or relationships', async () => {
    requireRow('boards', 'board-target').workspace_id = 'workspace-source';
    const relationshipSnapshot = JSON.stringify({
      comments: store.comments,
      attachments: store.attachments,
      checklists: store.checklists,
      checklistItems: store.checklist_items,
      members: store.card_members,
      labels: store.card_labels,
    });
    const request = new Request('http://localhost/api/v1/cards/card-source/move', {
      method: 'PATCH',
      body: JSON.stringify({ targetListId: 'list-target' }),
    });

    const response = await handleMoveCard(request, 'card-source');
    const body = (await response.json()) as { data: Row };

    expect(response.status).toBe(200);
    expect(body.data.id).toBe('card-source');
    expect(body.data.list_id).toBe('list-target');
    expect(body.data.start_date).toBe('2026-01-01T00:00:00.000Z');
    expect(body.data.due_date).toBe('2026-01-02T00:00:00.000Z');
    expect(body.data.cover_type).toBe('color');
    expect(body.data.cover_value).toBe('#123456');
    expect(JSON.stringify({
      comments: store.comments,
      attachments: store.attachments,
      checklists: store.checklists,
      checklistItems: store.checklist_items,
      members: store.card_members,
      labels: store.card_labels,
    })).toBe(relationshipSnapshot);
    expect(validateCardMoveMock).toHaveBeenCalledWith(expect.objectContaining({
      boardId: 'board-source',
      fromListId: 'list-source',
      toListId: 'list-target',
      cardId: 'card-source',
    }));
    expect(dispatchEventMock).toHaveBeenCalledTimes(1);
    expect(emitCardMovedMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledTimes(2);
    expect(publishMock.mock.calls[0]?.[0]).toBe('board-source');
    expect(publishMock.mock.calls[1]?.[0]).toBe('board-target');
  });

  test('moves between lists on the same board and publishes only to that board', async () => {
    requireRow('lists', 'list-target').board_id = 'board-source';
    const request = new Request('http://localhost/api/v1/cards/card-source/move', {
      method: 'PATCH',
      body: JSON.stringify({ targetListId: 'list-target' }),
    });

    const response = await handleMoveCard(request, 'card-source');
    const body = (await response.json()) as { data: Row };

    expect(response.status).toBe(200);
    expect(body.data.id).toBe('card-source');
    expect(body.data.list_id).toBe('list-target');
    expect(applyBoardVisibilityMock).not.toHaveBeenCalled();
    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock.mock.calls[0]?.[0]).toBe('board-source');
  });

  test('keeps a same-list no-op free of activity and realtime events', async () => {
    const request = new Request('http://localhost/api/v1/cards/card-source/move', {
      method: 'PATCH',
      body: JSON.stringify({ targetListId: 'list-source' }),
    });

    const response = await handleMoveCard(request, 'card-source');
    const body = (await response.json()) as { data: Row };

    expect(response.status).toBe(200);
    expect(body.data.id).toBe('card-source');
    expect(body.data.list_id).toBe('list-source');
    expect(dispatchEventMock).not.toHaveBeenCalled();
    expect(emitCardMovedMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  test('does not let the cross-board path bypass source-board state transitions', async () => {
    requireRow('boards', 'board-target').workspace_id = 'workspace-source';
    validateCardMoveMock.mockImplementationOnce(() => Promise.reject(new StateTransitionForbiddenError({
      boardId: 'board-source',
      fromListId: 'list-source',
      fromListName: 'Source',
      toListId: 'list-target',
      toListName: 'Target',
      allowedNextStates: [],
    })));
    const request = new Request('http://localhost/api/v1/cards/card-source/move', {
      method: 'PATCH',
      body: JSON.stringify({ targetListId: 'list-target' }),
    });

    const response = await handleMoveCard(request, 'card-source');
    const body = (await response.json()) as { name?: string };

    expect(response.status).toBe(422);
    expect(body.name).toBe('state-transition-forbidden');
    expect(store.cards[0]?.list_id).toBe('list-source');
    expect(dispatchEventMock).not.toHaveBeenCalled();
    expect(emitCardMovedMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  test('rejects a target board in another workspace even when the caller belongs to both', async () => {
    const request = new Request('http://localhost/api/v1/cards/card-source/move', {
      method: 'PATCH',
      body: JSON.stringify({ targetListId: 'list-target' }),
    });

    const response = await handleMoveCard(request, 'card-source');
    const body = (await response.json()) as { error?: { code?: string } };

    expect(response.status).toBe(403);
    expect(body.error?.code).toBe('cross-workspace-move-forbidden');
    expect(store.cards[0]?.list_id).toBe('list-source');
  });

  test('rejects a target board that the caller cannot access', async () => {
    requireRow('boards', 'board-target').workspace_id = 'workspace-source';
    requireRow('boards', 'board-target').state = 'ARCHIVED';
    requireRow('lists', 'list-target').archived = true;
    applyBoardVisibilityMock.mockImplementationOnce(() => Promise.resolve(Response.json(
      { error: { code: 'board-access-denied', message: 'You do not have access to this board' } },
      { status: 403 },
    )));
    const request = new Request('http://localhost/api/v1/cards/card-source/move', {
      method: 'PATCH',
      body: JSON.stringify({ targetListId: 'list-target' }),
    });

    const response = await handleMoveCard(request, 'card-source');
    const body = (await response.json()) as { error?: { code?: string } };

    expect(response.status).toBe(403);
    expect(body.error?.code).toBe('board-access-denied');
    expect(applyBoardVisibilityMock).toHaveBeenCalledWith(request, 'board-target');
    expect(validateCardMoveMock).not.toHaveBeenCalled();
    expect(store.cards[0]?.list_id).toBe('list-source');
  });

  test('rejects an archived destination list', async () => {
    requireRow('boards', 'board-target').workspace_id = 'workspace-source';
    requireRow('lists', 'list-target').archived = true;
    const request = new Request('http://localhost/api/v1/cards/card-source/move', {
      method: 'PATCH',
      body: JSON.stringify({ targetListId: 'list-target' }),
    });

    const response = await handleMoveCard(request, 'card-source');
    const body = (await response.json()) as { error?: { code?: string } };

    expect(response.status).toBe(403);
    expect(body.error?.code).toBe('target-list-archived');
    expect(store.cards[0]?.list_id).toBe('list-source');
  });

  test('rejects an archived destination board', async () => {
    requireRow('boards', 'board-target').workspace_id = 'workspace-source';
    requireRow('boards', 'board-target').state = 'ARCHIVED';
    const request = new Request('http://localhost/api/v1/cards/card-source/move', {
      method: 'PATCH',
      body: JSON.stringify({ targetListId: 'list-target' }),
    });

    const response = await handleMoveCard(request, 'card-source');
    const body = (await response.json()) as { error?: { code?: string } };

    expect(response.status).toBe(403);
    expect(body.error?.code).toBe('board-is-archived');
    expect(store.cards[0]?.list_id).toBe('list-source');
  });
});
