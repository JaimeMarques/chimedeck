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
  labels: Row[];
  users: Row[];
};
type TableName = keyof Store;

let store: Store;
let moveGuardError: (Error & { code: string; constraint: string }) | null = null;

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
  whereIn(field: string, values: string[]): this {
    this.filters.push((row) => values.includes(String(row[field])));
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
    if (this.tableName === 'cards' && patch.list_id === 'list-target' && moveGuardError) {
      return Promise.reject(moveGuardError);
    }
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
    labels: [{ id: 'label-1', board_id: 'board-source', name: 'Urgent', color: 'red' }],
    users: [{ id: 'user-1', email: 'member@example.test', name: 'Member', avatar_url: 'avatars/member.jpg' }],
  };
}

beforeEach(() => {
  store = resetStore();
  moveGuardError = null;
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
  test('maps an assignment-eligibility DB guard to a stable refusal without publishing events', async () => {
    requireRow('boards', 'board-target').workspace_id = 'workspace-source';
    store.card_labels = [];
    moveGuardError = Object.assign(new Error('assignment not eligible'), {
      code: '23514', constraint: 'card_move_assignment_eligibility',
    });
    const request = new Request('http://localhost/api/v1/cards/card-source/move', {
      method: 'PATCH', body: JSON.stringify({ targetListId: 'list-target' }),
    });
    const response = await handleMoveCard(request, 'card-source');
    const body = (await response.json()) as { error?: { code?: string } };
    expect(response.status).toBe(422);
    expect(body.error?.code).toBe('assignment-target-ineligible');
    expect(store.cards[0]?.list_id).toBe('list-source');
    expect(dispatchEventMock).not.toHaveBeenCalled();
    expect(emitCardMovedMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  test('moves across accessible boards in one workspace without changing card identity or relationships', async () => {
    requireRow('boards', 'board-target').workspace_id = 'workspace-source';
    store.card_labels = [];
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
    // Source-board transition graphs cannot contain a destination-board list.
    expect(validateCardMoveMock).not.toHaveBeenCalled();
    expect(dispatchEventMock).toHaveBeenCalledTimes(1);
    expect(emitCardMovedMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledTimes(2);
    expect(publishMock.mock.calls[0]?.[0]).toBe('board-source');
    expect(publishMock.mock.calls[1]?.[0]).toBe('board-target');
    const destinationEvent = JSON.parse(publishMock.mock.calls[1]?.[1] ?? '{}') as {
      type: string; payload: { card: Row; fromListId: string };
    };
    expect(destinationEvent.type).toBe('card_moved');
    expect(destinationEvent.payload.fromListId).toBe('list-source');
    expect(destinationEvent.payload.card.labels).toEqual([]);
    expect(destinationEvent.payload.card.members).toEqual([{
      id: 'user-1', email: 'member@example.test', name: 'Member',
      avatar_url: '/api/v1/users/user-1/avatar',
    }]);
    expect(destinationEvent.payload.card.cover_image_url).toBeNull();
    expect(destinationEvent.payload.card.cover_aspect_ratio).toBeNull();
    expect(destinationEvent.payload.card.cover_is_gif).toBe(false);
  });

  test('publishes a renderable destination card even without labels or members and resolves its attachment cover', async () => {
    requireRow('boards', 'board-target').workspace_id = 'workspace-source';
    store.card_labels = [];
    store.card_members = [];
    requireRow('cards', 'card-source').cover_attachment_id = 'attachment-1';
    Object.assign(requireRow('attachments', 'attachment-1'), {
      status: 'READY', s3_key: 'private/proof.jpg', thumbnail_key: 'private/proof-thumb.webp',
      mime_type: 'image/jpeg', width: 1600, height: 900,
    });
    const response = await handleMoveCard(new Request('http://localhost/api/v1/cards/card-source/move', {
      method: 'PATCH', body: JSON.stringify({ targetListId: 'list-target' }),
    }), 'card-source');
    expect(response.status).toBe(200);
    const destinationEvent = JSON.parse(publishMock.mock.calls[1]?.[1] ?? '{}') as { payload: { card: Row } };
    expect(destinationEvent.payload.card.labels).toEqual([]);
    expect(destinationEvent.payload.card.members).toEqual([]);
    expect(destinationEvent.payload.card.cover_image_url).toBe('/api/v1/attachments/attachment-1/thumbnail');
    expect(destinationEvent.payload.card.cover_aspect_ratio).toBe('16:9');
    expect(destinationEvent.payload.card.cover_is_gif).toBe(false);
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

  test('maps a concurrent label-ownership DB guard to a stable refusal without events', async () => {
    requireRow('boards', 'board-target').workspace_id = 'workspace-source';
    store.card_labels = [];
    moveGuardError = Object.assign(new Error('concurrent foreign label'), {
      code: '23514', constraint: 'card_move_label_ownership',
    });
    const response = await handleMoveCard(new Request('http://localhost/api/v1/cards/card-source/move', {
      method: 'PATCH', body: JSON.stringify({ targetListId: 'list-target' }),
    }), 'card-source');
    const body = (await response.json()) as { error?: { code?: string } };
    expect(response.status).toBe(422);
    expect(body.error?.code).toBe('label-target-ineligible');
    expect(store.cards[0]?.list_id).toBe('list-source');
    expect(dispatchEventMock).not.toHaveBeenCalled();
    expect(emitCardMovedMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  test('refuses a cross-board move with source-board labels without changing the card or emitting events', async () => {
    requireRow('boards', 'board-target').workspace_id = 'workspace-source';
    const request = new Request('http://localhost/api/v1/cards/card-source/move', {
      method: 'PATCH', body: JSON.stringify({ targetListId: 'list-target' }),
    });
    const response = await handleMoveCard(request, 'card-source');
    const body = (await response.json()) as { error?: { code?: string } };
    expect(response.status).toBe(422);
    expect(body.error?.code).toBe('label-target-ineligible');
    expect(store.cards[0]?.list_id).toBe('list-source');
    expect(store.card_labels).toEqual([{ card_id: 'card-source', label_id: 'label-1' }]);
    expect(dispatchEventMock).not.toHaveBeenCalled();
    expect(emitCardMovedMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
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

  test('enforces source-board state transitions for same-board moves', async () => {
    requireRow('lists', 'list-target').board_id = 'board-source';
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
