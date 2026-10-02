import { beforeEach, describe, expect, mock, test } from 'bun:test';

type Row = Record<string, unknown>;

let cards: Row[] = [];
let currentUserId: string | undefined;

class QueryBuilder {
  private criteria: Row = {};

  constructor(private readonly tableName: string) {}

  where(criteria: Row): this {
    Object.assign(this.criteria, criteria);
    return this;
  }

  orderBy(): this {
    return this;
  }

  first(): Promise<Row | undefined> {
    if (this.tableName === 'lists') return Promise.resolve({ id: 'list-1', board_id: 'board-1', title: 'Todo' });
    const rows = cards.filter((row) => Object.entries(this.criteria).every(([key, value]) => row[key] === value));
    return Promise.resolve(rows[0]);
  }

  insert(row: Row): Promise<void> {
    cards.push({ ...row });
    return Promise.resolve();
  }
}

void mock.module('../../../common/db', () => ({ db: (tableName: string) => new QueryBuilder(tableName) }));
void mock.module('../../auth/middlewares/authentication', () => ({
  authenticate: (req: Request & { currentUser?: { id: string; email: string } }) => {
    if (currentUserId) req.currentUser = { id: currentUserId, email: 'member@example.test' };
    return Promise.resolve(null);
  },
}));
void mock.module('../../board/middlewares/requireBoardWritable', () => ({
  requireBoardWritable: (req: Request & { board?: Row }) => {
    req.board = { id: 'board-1', workspace_id: 'workspace-1' };
    return Promise.resolve(null);
  },
}));
void mock.module('../../../middlewares/permissionManager', () => ({
  requireWorkspaceMembership: () => Promise.resolve(null),
  requireMemberOrBoardGuestMember: () => Promise.resolve(null),
}));
void mock.module('../../../mods/events/dispatch', () => ({ dispatchEvent: () => Promise.resolve() }));
void mock.module('../../activity/mods/createActivityEvent', () => ({ emitCardCreated: () => Promise.resolve() }));
void mock.module('../../../common/cards/cover', () => ({ resolveCoverImageUrl: (card: Row) => Promise.resolve(card) }));
void mock.module('../../../common/ids/shortId', () => ({ generateUniqueShortId: () => Promise.resolve('Abc12345') }));

const { handleCreateCard } = await import('./create');

function create(): Promise<Response> {
  return handleCreateCard(
    new Request('http://localhost/api/v1/lists/list-1/cards', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'New card' }),
    }),
    'list-1',
  );
}

describe('handleCreateCard created_by', () => {
  beforeEach(() => {
    cards = [];
    currentUserId = undefined;
  });

  test('records the authenticated user as the creator', async () => {
    currentUserId = 'user-1';
    const response = await create();
    expect(response.status).toBe(201);
    expect(cards[0]?.created_by).toBe('user-1');
    const body = (await response.json()) as { data: Row };
    expect(body.data.created_by).toBe('user-1');
  });

  test('stores null, never system, when there is no user', async () => {
    const response = await create();
    expect(response.status).toBe(201);
    expect(cards[0]?.created_by).toBeNull();
  });
});
