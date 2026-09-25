import { beforeEach, describe, expect, it, mock } from 'bun:test';

type Row = Record<string, unknown>;
type DataStore = {
  users: Row[];
  workspaces: Row[];
  memberships: Row[];
  boards: Row[];
  board_members: Row[];
  board_guest_access: Row[];
  invites: Row[];
};

class QueryBuilder {
  private filters: Array<(row: Row) => boolean> = [];
  private orderByField: string | null = null;
  private orderByDirection: 'asc' | 'desc' = 'asc';
  private pickedColumns: string[] | null = null;

  constructor(
    private readonly store: DataStore,
    private readonly tableName: keyof DataStore
  ) {}

  where(criteria: Row): QueryBuilder {
    this.filters.push((row) =>
      Object.entries(criteria).every(([key, value]) => row[key] === value)
    );
    return this;
  }

  orderBy(field: string, direction: 'asc' | 'desc' = 'asc'): QueryBuilder {
    this.orderByField = field;
    this.orderByDirection = direction;
    return this;
  }

  select(...columns: string[]): QueryBuilder {
    this.pickedColumns = columns.length > 0 ? columns : null;
    return this;
  }

  async first(): Promise<Row | undefined> {
    const rows = await this.execute();
    return rows[0];
  }

  async insert(payload: Row | Row[]): Promise<void> {
    const rows = Array.isArray(payload) ? payload : [payload];
    for (const row of rows) {
      (this.store[this.tableName] as Row[]).push({ ...row });
    }
  }

  async update(patch: Row): Promise<number> {
    const rows = this.executeSync(false);
    rows.forEach((row) => Object.assign(row, patch));
    return rows.length;
  }

  async delete(): Promise<number> {
    const rows = this.store[this.tableName] as Row[];
    const before = rows.length;
    const keep = rows.filter((row) => !this.filters.every((filter) => filter(row)));
    this.store[this.tableName] = keep;
    return before - keep.length;
  }

  then<TResult1 = Row[], TResult2 = never>(
    onfulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private executeSync(clone = true): Row[] {
    const source = this.store[this.tableName] as Row[];
    let rows = source.filter((row) => this.filters.every((filter) => filter(row)));
    if (this.orderByField) {
      const field = this.orderByField;
      const factor = this.orderByDirection === 'asc' ? 1 : -1;
      rows = [...rows].sort((a, b) => {
        const left = a[field];
        const right = b[field];
        if (left === right) return 0;
        if (left === undefined || left === null) return -1 * factor;
        if (right === undefined || right === null) return 1 * factor;
        return String(left) > String(right) ? factor : -1 * factor;
      });
    }

    if (this.pickedColumns) {
      rows = rows.map((row) => {
        const next: Row = {};
        this.pickedColumns!.forEach((column) => {
          next[column] = row[column];
        });
        return next;
      });
    }
    return clone ? rows.map((row) => ({ ...row })) : rows;
  }

  private async execute(): Promise<Row[]> {
    return this.executeSync();
  }
}

function createStore(): DataStore {
  return {
    users: [
      { id: 'user-admin', email: 'admin@example.com', name: 'Admin User', avatar_url: null },
      { id: 'user-member', email: 'member@example.com', name: 'Member User', avatar_url: null },
      { id: 'user-owner-2', email: 'owner2@example.com', name: 'Owner Two', avatar_url: null },
      { id: 'user-new', email: 'new@example.com', name: 'New User', avatar_url: null },
    ],
    workspaces: [{ id: 'ws-1', name: 'Workspace One', owner_id: 'user-admin' }],
    memberships: [
      { workspace_id: 'ws-1', user_id: 'user-admin', role: 'OWNER' },
      { workspace_id: 'ws-1', user_id: 'user-member', role: 'MEMBER' },
      { workspace_id: 'ws-1', user_id: 'user-owner-2', role: 'OWNER' },
    ],
    boards: [
      {
        id: 'board-1',
        workspace_id: 'ws-1',
        title: 'Board One',
        description: 'board',
        state: 'ACTIVE',
        visibility: 'PRIVATE',
      },
    ],
    board_members: [{ id: 'bm-1', board_id: 'board-1', user_id: 'user-admin', role: 'ADMIN' }],
    board_guest_access: [],
    invites: [],
  };
}

let dataStore = createStore();
let inviteIdSeq = 0;

const authenticateMock = mock(async (req: Request & { currentUser?: unknown }) => {
  const authHeader = req.headers.get('authorization') ?? req.headers.get('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (token === 'hf_admin_token') {
    req.currentUser = { id: 'user-admin', email: 'admin@example.com', name: 'Admin User' };
    return null;
  }
  if (token === 'hf_member_token') {
    req.currentUser = { id: 'user-member', email: 'member@example.com', name: 'Member User' };
    return null;
  }

  return Response.json(
    { error: { code: 'unauthorized', message: 'Invalid API token' } },
    { status: 401 }
  );
});

const createInviteMock = mock(
  async ({
    workspaceId,
    invitedEmail,
    role,
  }: {
    workspaceId: string;
    invitedEmail: string;
    role: string;
  }) => {
    inviteIdSeq += 1;
    const id = `invite-${inviteIdSeq}`;
    dataStore.invites.push({ id, workspace_id: workspaceId, invited_email: invitedEmail, role });
    return { id, token: `token-${inviteIdSeq}`, expiresAt: new Date() };
  }
);

mock.module('../../../server/extensions/auth/middlewares/authentication', () => ({
  authenticate: authenticateMock,
}));

mock.module('../../../server/extensions/workspace/mods/invite/create', () => ({
  createInvite: createInviteMock,
}));

const dbMockBase = (tableName: keyof DataStore) => new QueryBuilder(dataStore, tableName);
const dbMock = Object.assign(dbMockBase, {
  transaction: async <T>(callback: (trx: typeof dbMockBase) => Promise<T>) => callback(dbMockBase),
});
mock.module('../../../server/common/db', () => ({
  db: dbMock as unknown as typeof import('../../../server/common/db').db,
}));
mock.module('../../../server/extensions/workspace/api/members/lock', () => ({
  lockWorkspaceMembershipMutations: async () => {},
}));
mock.module('../../../server/extensions/board/api/members/authorization', () => ({
  getCurrentWorkspaceRole: async (_trx: unknown, workspaceId: string, userId: string) =>
    (dataStore.memberships.find(
      (membership) => membership.workspace_id === workspaceId && membership.user_id === userId
    )?.role as string | undefined) ?? null,
}));
mock.module('../../../server/extensions/workspace/api/members/removeService', () => ({
  removeWorkspaceMemberInTransaction: async (
    _trx: unknown,
    workspaceId: string,
    userId: string
  ) => {
    dataStore.memberships = dataStore.memberships.filter(
      (membership) => membership.workspace_id !== workspaceId || membership.user_id !== userId
    );
    return null;
  },
}));

const { trelloCompatRouter } = await import('../../../server/extensions/trelloCompat/api/index');

beforeEach(() => {
  Bun.env['TRELLO_COMPAT_ENABLED'] = 'true';
  dataStore = createStore();
  inviteIdSeq = 0;
  authenticateMock.mockClear();
  createInviteMock.mockClear();
});

describe('trelloCompat organizations', () => {
  it('POST /organizations creates organization', async () => {
    const req = new Request('http://localhost/trello/1/organizations', {
      method: 'POST',
      headers: { Authorization: 'Bearer hf_admin_token' },
      body: JSON.stringify({ displayName: 'Created Workspace' }),
    });
    const res = await trelloCompatRouter(req, '/trello/1/organizations');
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { id: string; displayName: string };
    expect(body.displayName).toBe('Created Workspace');
    expect(dataStore.workspaces.some((workspace) => workspace.id === body.id)).toBe(true);
  });

  it('GET /organizations/{id} returns organization with memberships', async () => {
    const req = new Request('http://localhost/trello/1/organizations/ws-1', {
      method: 'GET',
      headers: { Authorization: 'Bearer hf_admin_token' },
    });
    const res = await trelloCompatRouter(req, '/trello/1/organizations/ws-1');
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { id: string; memberships: Array<{ idMember: string }> };
    expect(body.id).toBe('ws-1');
    expect(body.memberships).toHaveLength(3);
  });

  it('GET /organizations/{id}/boards and /members returns arrays', async () => {
    const boardsReq = new Request('http://localhost/trello/1/organizations/ws-1/boards', {
      method: 'GET',
      headers: { Authorization: 'Bearer hf_admin_token' },
    });
    const boardsRes = await trelloCompatRouter(boardsReq, '/trello/1/organizations/ws-1/boards');
    expect(boardsRes?.status).toBe(200);
    const boards = (await boardsRes!.json()) as Array<{ id: string }>;
    expect(boards.map((board) => board.id)).toEqual(['board-1']);

    const membersReq = new Request('http://localhost/trello/1/organizations/ws-1/members', {
      method: 'GET',
      headers: { Authorization: 'Bearer hf_admin_token' },
    });
    const membersRes = await trelloCompatRouter(membersReq, '/trello/1/organizations/ws-1/members');
    expect(membersRes?.status).toBe(200);
    const members = (await membersRes!.json()) as Array<{ id: string }>;
    expect(members.map((member) => member.id)).toEqual([
      'user-admin',
      'user-member',
      'user-owner-2',
    ]);
  });

  it('PUT /organizations/{id}/members invites by email', async () => {
    const req = new Request('http://localhost/trello/1/organizations/ws-1/members', {
      method: 'PUT',
      headers: { Authorization: 'Bearer hf_admin_token' },
      body: JSON.stringify({ email: 'new@example.com', type: 'normal' }),
    });
    const res = await trelloCompatRouter(req, '/trello/1/organizations/ws-1/members');
    expect(res?.status).toBe(200);
    expect(createInviteMock).toHaveBeenCalledTimes(1);
    expect(dataStore.invites).toHaveLength(1);
    expect(dataStore.invites[0]?.invited_email).toBe('new@example.com');
  });

  it('PUT /organizations/{id}/members/{id} changes role', async () => {
    const req = new Request('http://localhost/trello/1/organizations/ws-1/members/user-member', {
      method: 'PUT',
      headers: { Authorization: 'Bearer hf_admin_token' },
      body: JSON.stringify({ type: 'admin' }),
    });
    const res = await trelloCompatRouter(req, '/trello/1/organizations/ws-1/members/user-member');
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { idMember: string; memberType: string };
    expect(body.idMember).toBe('user-member');
    expect(body.memberType).toBe('admin');
  });

  it('preserves OWNER on admin round-trip and denies ADMIN demotion of OWNER', async () => {
    const ownerRoundTrip = new Request(
      'http://localhost/trello/1/organizations/ws-1/members/user-owner-2',
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer hf_admin_token' },
        body: JSON.stringify({ type: 'admin' }),
      }
    );
    const ownerResponse = await trelloCompatRouter(
      ownerRoundTrip,
      '/trello/1/organizations/ws-1/members/user-owner-2'
    );
    expect(ownerResponse?.status).toBe(200);
    expect(
      dataStore.memberships.find((membership) => membership.user_id === 'user-owner-2')?.role
    ).toBe('OWNER');

    const caller = dataStore.memberships.find((membership) => membership.user_id === 'user-member');
    if (caller) caller.role = 'ADMIN';
    const adminDemotion = new Request(
      'http://localhost/trello/1/organizations/ws-1/members/user-owner-2',
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer hf_member_token' },
        body: JSON.stringify({ type: 'normal' }),
      }
    );
    const denied = await trelloCompatRouter(
      adminDemotion,
      '/trello/1/organizations/ws-1/members/user-owner-2'
    );
    expect(denied?.status).toBe(401);
    expect(
      dataStore.memberships.find((membership) => membership.user_id === 'user-owner-2')?.role
    ).toBe('OWNER');
  });

  it('DELETE /organizations/{id}/members/{id} removes member', async () => {
    const req = new Request('http://localhost/trello/1/organizations/ws-1/members/user-member', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer hf_admin_token' },
    });
    const res = await trelloCompatRouter(req, '/trello/1/organizations/ws-1/members/user-member');
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({});
    expect(dataStore.memberships.some((membership) => membership.user_id === 'user-member')).toBe(
      false
    );
  });

  it('DELETE /organizations/{id}/members/{id}/all supports Trello all-board removal', async () => {
    const req = new Request(
      'http://localhost/trello/1/organizations/ws-1/members/user-member/all',
      {
        method: 'DELETE',
        headers: { Authorization: 'Bearer hf_admin_token' },
      }
    );
    const res = await trelloCompatRouter(
      req,
      '/trello/1/organizations/ws-1/members/user-member/all'
    );
    expect(res?.status).toBe(200);
    expect(dataStore.memberships.some((membership) => membership.user_id === 'user-member')).toBe(
      false
    );
  });
});
