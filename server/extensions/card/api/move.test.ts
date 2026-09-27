import { beforeEach, describe, expect, mock, test } from 'bun:test';

type Row = Record<string, unknown>;
type Store = {
  memberships: Row[];
  board_members: Row[];
  board_guest_access: Row[];
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
  board_state_transitions: Row[];
};
type TableName = keyof Store;

let store: Store;
let moveGuardError: (Error & { code: string; constraint: string }) | null = null;
let inTransaction = false;
const lockOrder: string[] = [];

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
    if (this.tableName === 'cards' && !inTransaction) throw new Error('card updated outside transaction');
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
    transaction: async <T>(callback: (trx: typeof dbMock) => Promise<T>): Promise<T> => {
      inTransaction = true;
      try { return await callback(dbMock); } finally { inTransaction = false; }
    },
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
const applyBoardVisibilityMock = mock((_req?: Request, _boardId?: string): Promise<Response | null> => Promise.resolve(null));
const dispatchEventMock = mock((_event: { type: string; boardId: string }) => {
  if (inTransaction) throw new Error('event emitted before commit');
  return Promise.resolve();
});
const emitCardMovedMock = mock((_event: { toListName: string | null }) => {
  if (inTransaction) throw new Error('activity emitted before commit');
  return Promise.resolve();
});
const emitCardMoveBlockedActivityMock = mock((_event: { cardId: string }) => {
  if (inTransaction) throw new Error('blocked activity emitted before transaction closes');
  return Promise.resolve();
});
const publishMock = mock((_boardId: string, _payload: string): Promise<void> => {
  if (inTransaction) throw new Error('realtime event emitted before commit');
  return Promise.resolve();
});

void mock.module('../../../common/db', () => ({ db: dbMock }));
void mock.module('../../auth/middlewares/authentication', () => ({ authenticate: authenticateMock }));
void mock.module('../middlewares/requireCardWritable', () => ({ requireCardWritable: requireCardWritableMock }));
void mock.module('../../../middlewares/permissionManager', () => ({
  requireWorkspaceMembership: requireWorkspaceMembershipMock,
  requireMemberOrBoardGuestMember: requireMemberOrBoardGuestMemberMock,
  resolveHighestRole: (roles: string[]) => ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER', 'GUEST'].find((role) => roles.includes(role)) ?? null,
  hasRole: (role: string, minRole: string) => ['GUEST', 'VIEWER', 'MEMBER', 'ADMIN', 'OWNER'].indexOf(role) >= ['GUEST', 'VIEWER', 'MEMBER', 'ADMIN', 'OWNER'].indexOf(minRole),
}));
void mock.module('../../../config/featureFlags', () => ({ featureFlags: { STATE_TRANSITIONS_ENABLED: true } }));
void mock.module('../../stateTransitions/common/activityLog', () => ({ emitCardMoveBlockedActivity: emitCardMoveBlockedActivityMock }));
void mock.module('../../../middlewares/boardVisibility', () => ({ applyBoardVisibility: applyBoardVisibilityMock }));
void mock.module('../../workspace/api/members/lock', () => ({ lockWorkspaceMembershipMutations: (_trx: unknown, id: string) => { lockOrder.push(`workspace:${id}`); return Promise.resolve(); } }));
void mock.module('../../board/api/members/lock', () => ({ lockBoardMemberMutations: (_trx: unknown, id: string) => { lockOrder.push(`board:${id}`); return Promise.resolve(); } }));
void mock.module('../../../mods/events/dispatch', () => ({ dispatchEvent: dispatchEventMock }));
void mock.module('../../activity/mods/createActivityEvent', () => ({ emitCardMoved: emitCardMovedMock }));
void mock.module('../../../mods/pubsub/publisher', () => ({ publisher: { publish: publishMock } }));
void mock.module('../../realtime/mods/conflictHandler', () => ({ recordConflict: mock(() => undefined) }));

const { handleMoveCard } = await import('./move');

function resetStore(): Store {
  return {
    memberships: [{ user_id: 'user-1', workspace_id: 'workspace-source', role: 'MEMBER' }],
    board_members: [{ user_id: 'user-1', board_id: 'board-source' }, { user_id: 'user-1', board_id: 'board-target' }],
    board_guest_access: [],
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
    comments: [{ id: 'comment-1', card_id: 'card-source', content: 'Preserve me', deleted: false }],
    attachments: [{ id: 'attachment-1', card_id: 'card-source', name: 'proof.txt', status: 'READY', referenced_card_id: null }],
    checklists: [{ id: 'checklist-1', card_id: 'card-source', title: 'Checklist' }],
    checklist_items: [{ id: 'item-1', card_id: 'card-source', checklist_id: 'checklist-1', checked: false }],
    card_members: [{ card_id: 'card-source', user_id: 'user-1' }],
    card_labels: [{ card_id: 'card-source', label_id: 'label-1' }],
    labels: [{ id: 'label-1', board_id: 'board-source', name: 'Urgent', color: 'red' }],
    users: [{ id: 'user-1', email: 'member@example.test', name: 'Member', avatar_url: 'avatars/member.jpg' }],
    board_state_transitions: [],
  };
}

function enableLegacySourceTransition(): void {
  requireRow('lists', 'list-target').board_id = 'board-source';
  store.lists.push({ id: 'list-forbidden', board_id: 'board-source', title: 'Forbidden', archived: false });
  store.board_state_transitions.push({ board_id: 'board-source', enabled: true, graph_data: {
    nodes: [
      { id: 'legacy-source-node', listId: 'list-source', label: 'Source', positionX: 0, positionY: 0 },
      { id: 'legacy-target-node', listId: 'list-target', label: 'Target', positionX: 100, positionY: 0 },
      { id: 'legacy-forbidden-node', listId: 'list-forbidden', label: 'Forbidden', positionX: 200, positionY: 0 },
    ],
    edges: [{ id: 'source-to-target', fromNodeId: 'legacy-source-node', toNodeId: 'legacy-target-node',
      action: 'allowed_move_to', direction: 'one_way', style: 'straight' }],
    notes: [],
  } });
}

beforeEach(() => {
  store = resetStore();
  moveGuardError = null;
  inTransaction = false;
  lockOrder.length = 0;
  authenticateMock.mockClear();
  requireCardWritableMock.mockClear();
  requireWorkspaceMembershipMock.mockClear();
  requireMemberOrBoardGuestMemberMock.mockClear();
  applyBoardVisibilityMock.mockReset();
  applyBoardVisibilityMock.mockImplementation(() => Promise.resolve(null));
  dispatchEventMock.mockClear();
  emitCardMovedMock.mockClear();
  emitCardMoveBlockedActivityMock.mockClear();
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

  test('refuses a move if the card leaves its authorized source board while target access is checked', async () => {
    requireRow('boards', 'board-target').workspace_id = 'workspace-source';
    store.card_labels = [];
    store.boards.push({ id: 'board-private', workspace_id: 'workspace-source', state: 'ACTIVE', visibility: 'PRIVATE' });
    store.lists.push({ id: 'list-private', board_id: 'board-private', title: 'Private', archived: false });
    applyBoardVisibilityMock.mockImplementationOnce(() => {
      requireRow('cards', 'card-source').list_id = 'list-private';
      return Promise.resolve(null);
    });
    const response = await handleMoveCard(new Request('http://localhost/api/v1/cards/card-source/move', {
      method: 'PATCH', body: JSON.stringify({ targetListId: 'list-target' }),
    }), 'card-source');
    const body = (await response.json()) as { error?: { code?: string } };
    expect(response.status).toBe(409);
    expect(body.error?.code).toBe('card-location-changed');
    expect(store.cards[0]?.list_id).toBe('list-private');
    expect(dispatchEventMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  test('rechecks destination access after a queued guest grant is revoked', async () => {
    requireRow('boards', 'board-target').workspace_id = 'workspace-source';
    store.card_labels = [];
    applyBoardVisibilityMock.mockImplementation(() => {
      store.board_members = store.board_members.filter((entry) => entry.board_id !== 'board-target');
      return Promise.resolve(null);
    });
    const response = await handleMoveCard(new Request('http://localhost/api/v1/cards/card-source/move', {
      method: 'PATCH', body: JSON.stringify({ targetListId: 'list-target' }),
    }), 'card-source');
    expect(response.status).toBe(403);
    expect(lockOrder).toEqual(['workspace:workspace-source', 'board:board-source', 'board:board-target']);
    expect(store.cards[0]?.list_id).toBe('list-source');
    expect(dispatchEventMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  test('refuses a revoked guest grant despite cached guestType MEMBER', async () => {
    requireRow('boards', 'board-target').workspace_id = 'workspace-source';
    const membership = store.memberships[0];
    if (!membership) throw new Error('Missing membership fixture');
    membership.role = 'GUEST';
    store.board_guest_access = [
      { user_id: 'user-1', board_id: 'board-source', guest_type: 'MEMBER' },
      { user_id: 'user-1', board_id: 'board-target', guest_type: 'MEMBER' },
    ];
    store.card_labels = [];
    applyBoardVisibilityMock.mockImplementation((req) => {
      (req as Request & { guestType?: string }).guestType = 'MEMBER';
      store.board_guest_access = store.board_guest_access.filter((row) => row.board_id !== 'board-target');
      return Promise.resolve(null);
    });
    const response = await handleMoveCard(new Request('http://localhost/api/v1/cards/card-source/move', {
      method: 'PATCH', body: JSON.stringify({ targetListId: 'list-target' }),
    }), 'card-source');
    expect(response.status).toBe(403);
    expect(store.cards[0]?.list_id).toBe('list-source');
    expect(publishMock).not.toHaveBeenCalled();
  });

  test('rechecks newly enabled transition rules after both board locks', async () => {
    requireRow('boards', 'board-target').workspace_id = 'workspace-source';
    store.card_labels = [];
    applyBoardVisibilityMock.mockImplementation(() => {
      store.board_state_transitions.push({ board_id: 'board-target', enabled: true });
      return Promise.resolve(null);
    });
    const response = await handleMoveCard(new Request('http://localhost/api/v1/cards/card-source/move', {
      method: 'PATCH', body: JSON.stringify({ targetListId: 'list-target' }),
    }), 'card-source');
    expect(response.status).toBe(422);
    expect(lockOrder).toEqual(['workspace:workspace-source', 'board:board-source', 'board:board-target']);
    expect(store.cards[0]?.list_id).toBe('list-source');
    expect(publishMock).not.toHaveBeenCalled();
  });

  test('refuses a revoked workspace membership despite stale middleware role', async () => {
    requireRow('boards', 'board-target').workspace_id = 'workspace-source';
    store.card_labels = [];
    applyBoardVisibilityMock.mockImplementation(() => {
      store.memberships = [];
      return Promise.resolve(null);
    });
    const response = await handleMoveCard(new Request('http://localhost/api/v1/cards/card-source/move', {
      method: 'PATCH', body: JSON.stringify({ targetListId: 'list-target' }),
    }), 'card-source');
    expect(response.status).toBe(403);
    expect(store.cards[0]?.list_id).toBe('list-source');
    expect(publishMock).not.toHaveBeenCalled();
  });

  test('fails closed on cross-board moves when either board enforces transition rules', async () => {
    requireRow('boards', 'board-target').workspace_id = 'workspace-source';
    store.card_labels = [];
    store.board_state_transitions.push({ board_id: 'board-source', enabled: true });
    const request = new Request('http://localhost/api/v1/cards/card-source/move', {
      method: 'PATCH', body: JSON.stringify({ targetListId: 'list-target' }),
    });
    const response = await handleMoveCard(request, 'card-source');
    const body = (await response.json()) as { error?: { code?: string } };
    expect(response.status).toBe(422);
    expect(body.error?.code).toBe('cross-board-transition-unsupported');
    expect(store.cards[0]?.list_id).toBe('list-source');
    expect(dispatchEventMock).not.toHaveBeenCalled();
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
    // A source-board event would resolve the destination list in notifications
    // and expose its title to recipients who cannot access the target board.
    expect(dispatchEventMock).not.toHaveBeenCalled();
    expect(emitCardMovedMock).toHaveBeenCalledTimes(1);
    expect(emitCardMovedMock.mock.calls[0]?.[0]).toMatchObject({ toListName: null });
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
    expect(destinationEvent.payload.card.comment_count).toBe(1);
    expect(destinationEvent.payload.card.attachment_count).toBe(1);
    expect(destinationEvent.payload.card.linked_card_count).toBe(0);
    expect(destinationEvent.payload.card.checklist_total).toBe(1);
    expect(destinationEvent.payload.card.checklist_done).toBe(0);
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
    expect(dispatchEventMock).toHaveBeenCalledTimes(1);
    expect(dispatchEventMock.mock.calls[0]?.[0]).toMatchObject({ type: 'card.moved', boardId: 'board-source' });
    expect(emitCardMovedMock.mock.calls[0]?.[0]).toMatchObject({ toListName: 'Target' });
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
    store.board_state_transitions.push({ board_id: 'board-source', enabled: true, graph_data: {
      nodes: [
        { id: 'list-source', listId: 'list-source', label: 'Source', positionX: 0, positionY: 0 },
        { id: 'list-target', listId: 'list-target', label: 'Target', positionX: 100, positionY: 0 },
      ], edges: [], notes: [],
    } });
    const request = new Request('http://localhost/api/v1/cards/card-source/move', {
      method: 'PATCH',
      body: JSON.stringify({ targetListId: 'list-target' }),
    });

    const response = await handleMoveCard(request, 'card-source');
    const body = (await response.json()) as { name?: string };

    expect(response.status).toBe(422);
    expect(body.name).toBe('state-transition-forbidden');
    expect(store.cards[0]?.list_id).toBe('list-source');
    expect(emitCardMoveBlockedActivityMock).toHaveBeenCalledTimes(1);
    expect(dispatchEventMock).not.toHaveBeenCalled();
    expect(emitCardMovedMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  test('allows the listed edge of an enabled legacy transition graph with distinct node and list IDs', async () => {
    enableLegacySourceTransition();
    const response = await handleMoveCard(new Request('http://localhost/api/v1/cards/card-source/move', {
      method: 'PATCH', body: JSON.stringify({ targetListId: 'list-target' }),
    }), 'card-source');
    const body = (await response.json()) as { data?: Row };
    expect(response.status).toBe(200);
    expect(body.data?.list_id).toBe('list-target');
    expect(dispatchEventMock).toHaveBeenCalledTimes(1);
    expect(emitCardMoveBlockedActivityMock).not.toHaveBeenCalled();
  });

  test('refuses an unlisted edge of an enabled legacy transition graph with distinct node and list IDs', async () => {
    enableLegacySourceTransition();
    const response = await handleMoveCard(new Request('http://localhost/api/v1/cards/card-source/move', {
      method: 'PATCH', body: JSON.stringify({ targetListId: 'list-forbidden' }),
    }), 'card-source');
    const body = (await response.json()) as { name?: string; data?: { allowedNextStates: Array<{ id: string; name: string }> } };
    expect(response.status).toBe(422);
    expect(body.name).toBe('state-transition-forbidden');
    expect(body.data?.allowedNextStates).toEqual([{ id: 'list-target', name: 'Target' }]);
    expect(store.cards[0]?.list_id).toBe('list-source');
    expect(emitCardMoveBlockedActivityMock).toHaveBeenCalledTimes(1);
    expect(dispatchEventMock).not.toHaveBeenCalled();
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
