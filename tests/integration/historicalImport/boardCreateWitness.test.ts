// tests/integration/historicalImport/boardCreateWitness.test.ts
// Workspace authorization for board CREATE operations.
//
// [why] A board the plan is about to create does not exist yet, so
// `resolvePlanWorkspace` used to fail it with `board-not-found` — and with it
// every list/card/comment op that authorises through that new board. The plan
// now carries an explicit workspace witness (`provenance.workspace_id`) which is
// NEVER trusted on its own: the server cross-checks it against the workspace the
// staged board payload will land in, proven by the adapter through the same
// owner gate the create path enforces (payload.workspace_id + workspaces.owner_id
// + OWNER membership), and every existing-board and board-create witness must
// resolve to one workspace before OWNER authorization.
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { MemoryImporterDeps } from './harness';
import { SYNTH_IDENTITY_MAP, SYNTH_BOARD_ID } from './fixtures';

const authenticateMock = mock(async (req: { currentUser?: { id: string; email: string } }) => {
  req.currentUser = { id: 'usr_operator_0001', email: 'operator@synth.test' };
  return null as Response | null;
});
mock.module('../../../server/extensions/auth/middlewares/authentication', () => ({
  authenticate: authenticateMock,
}));

let ownerScenario: 'owner' | 'member' | 'none' = 'owner';
mock.module('../../../server/middlewares/permissionManager', () => ({
  requireWorkspaceMembership: async (req: { currentUser?: { id: string } }) => {
    if (!req.currentUser)
      return Response.json({ error: { code: 'unauthorized' } }, { status: 401 });
    if (ownerScenario === 'none') {
      return Response.json({ error: { code: 'insufficient-role' } }, { status: 403 });
    }
    (req as { callerRole?: string }).callerRole = ownerScenario === 'owner' ? 'OWNER' : 'MEMBER';
    return null;
  },
  requireRole: () => null,
  hasRole: (callerRole: string, minRole: string) => {
    const rank: Record<string, number> = { OWNER: 4, ADMIN: 3, MEMBER: 2, VIEWER: 1, GUEST: 0 };
    return (rank[callerRole] ?? 0) >= (rank[minRole] ?? 0);
  },
  resolveHighestRole: () =>
    ownerScenario === 'none' ? null : ownerScenario === 'owner' ? 'OWNER' : 'MEMBER',
}));

const boardRows: Array<{ id: string; workspace_id: string }> = [];
let boardsQueryCount = 0;
mock.module('../../../server/common/db', () => {
  const table = (name: string) => {
    const qb: Record<string, unknown> = {
      whereIn: (_col: string, ids: string[]) => {
        boardsQueryCount += 1;
        return { select: async () => boardRows.filter((b) => ids.includes(b.id)) };
      },
      where: () => qb,
      first: async () => null,
      orderBy: () => qb,
      limit: () => qb,
      insert: async () => undefined,
    };
    void name;
    return qb;
  };
  return { db: table };
});

// Engine deps come from the in-memory harness: the authorization witness is the
// only piece the router consumes from the adapter here.
const harnessHolder: { deps: InstanceType<typeof MemoryImporterDeps> } = {
  deps: new MemoryImporterDeps({}),
};
mock.module('../../../server/extensions/historicalImport/core/adapters', () => ({
  loadIdentityMap: async () => new Map(Object.entries(SYNTH_IDENTITY_MAP)),
  createKnexDeps: () => harnessHolder.deps,
}));

const { historicalImportRouter } =
  await import('../../../server/extensions/historicalImport/api/router');
const { validatePlan } = await import('../../../server/extensions/historicalImport/core/plan');

const OPERATOR = 'usr_operator_0001';
const WORKSPACE = 'ws_synth_0001';
const OTHER_WORKSPACE = 'ws_other_0001';
const BOARD_SOURCE = 'trello_board_new_0001';
const BOARD_ID = 'brd_new_0001';
const LIST_SOURCE = 'trello_list_new_0001';
const LIST_ID = 'lst_new_0001';
const BOARD_PAYLOAD = 'file:///payloads/plan_board/op-board.json';
const LIST_PAYLOAD = 'file:///payloads/plan_board/op-list.json';

const BOARD_PAYLOADS: Record<string, unknown> = {
  [BOARD_PAYLOAD]: {
    entity_type: 'board',
    source_id: BOARD_SOURCE,
    historical_author: 'm_synth_alice',
    created_at: '2026-01-01T00:00:00.000Z',
    fields: {
      workspace_id: WORKSPACE,
      title: 'Imported Phoenix board',
      state: 'ACTIVE',
      visibility: 'PRIVATE',
    },
  },
  [LIST_PAYLOAD]: {
    entity_type: 'list',
    source_id: LIST_SOURCE,
    created_at: '2026-01-01T00:10:00.000Z',
    fields: { board_id: BOARD_ID, title: 'Imported list', position: '0000000000000001.000000' },
  },
};

// declaredWorkspaceId === null omits the witness entirely (legacy plan shape).
function boardCreatePlan(declaredWorkspaceId: string | null = WORKSPACE) {
  return {
    plan_id: 'plan_board_create_0001',
    source_system: 'trello',
    snapshot_hash: 'a'.repeat(64),
    created_at: '2026-09-16T00:00:00.000Z',
    operations: [
      {
        op_id: 'op-board-create',
        entity_type: 'board',
        source_id: BOARD_SOURCE,
        target_id: BOARD_ID,
        operation: 'create',
        provenance: {
          source_system: 'trello',
          source_id: BOARD_SOURCE,
          evidence_refs: [`trello-export:boards/${BOARD_SOURCE}`],
          board_id: BOARD_ID,
          ...(declaredWorkspaceId === null ? {} : { workspace_id: declaredWorkspaceId }),
        },
        evidence_refs: [`trello-export:boards/${BOARD_SOURCE}`],
        expected_target_fingerprint: null,
        payload_ref: BOARD_PAYLOAD,
        dependencies: [],
      },
      {
        op_id: 'op-list-create',
        entity_type: 'list',
        source_id: LIST_SOURCE,
        target_id: LIST_ID,
        operation: 'create',
        provenance: {
          source_system: 'trello',
          source_id: LIST_SOURCE,
          evidence_refs: [`trello-export:lists/${LIST_SOURCE}`],
          board_id: BOARD_ID,
        },
        evidence_refs: [`trello-export:lists/${LIST_SOURCE}`],
        expected_target_fingerprint: null,
        payload_ref: LIST_PAYLOAD,
        dependencies: ['op-board-create'],
      },
    ],
  };
}

function jsonReq(path: string, body: unknown): Request {
  return new Request(`http://localhost:3000${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer hf_test' },
    body: JSON.stringify(body),
  });
}

async function call(path: string, body: unknown) {
  return historicalImportRouter(
    jsonReq(path, body),
    path
  ) as Promise<Response>;
}

beforeEach(() => {
  authenticateMock.mockClear();
  ownerScenario = 'owner';
  boardsQueryCount = 0;
  boardRows.length = 0;
  // The destination has one pre-existing board in WORKSPACE.
  boardRows.push({ id: SYNTH_BOARD_ID, workspace_id: WORKSPACE });
  process.env['HISTORICAL_IMPORT_ENABLED'] = 'true';
  delete process.env['HISTORICAL_IMPORT_APPLY_ENABLED'];
  harnessHolder.deps = new MemoryImporterDeps(SYNTH_IDENTITY_MAP, BOARD_PAYLOADS);
  harnessHolder.deps.boardCreateWorkspaces.set(BOARD_SOURCE, WORKSPACE);
});

describe('board create authorization witness', () => {
  it('requires provenance.workspace_id for a board create at plan validation', async () => {
    const deps = new MemoryImporterDeps(SYNTH_IDENTITY_MAP, BOARD_PAYLOADS);
    const plan = boardCreatePlan(null);
    const validation = await validatePlan(plan, deps, OPERATOR);
    expect(validation.ok).toBe(false);
    const err = validation.errors.find((e) => e.code === 'board-create-witness-required')!;
    expect(err).toBeDefined();
    expect(err.op_id).toBe('op-board-create');
  });

  it('authorizes validate for a board that does not exist yet', async () => {
    const res = await call('/api/v1/admin/historical-import/validate', { plan: boardCreatePlan() });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      data: { validation: { ok: boolean; plan_hash: string; errors: unknown[] } };
    };
    expect(payload.data.validation.ok).toBe(true);
    expect(payload.data.validation.errors).toEqual([]);
  });

  it('reaches the missing board create in dry-run for the authorized workspace', async () => {
    const res = await call('/api/v1/admin/historical-import/dry-run', { plan: boardCreatePlan() });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      data: {
        result: {
          operations_applied: number;
          outcomes: Array<{ op_id: string; status: string }>;
        };
      };
    };
    expect(payload.data.result.operations_applied).toBe(2);
    expect(payload.data.result.outcomes.map((o) => o.op_id)).toEqual([
      'op-board-create',
      'op-list-create',
    ]);
    // rehearsal must not have written anything durable
    expect(harnessHolder.deps.rows.size).toBe(1);
    expect(harnessHolder.deps.provenance).toHaveLength(0);
  });

  it('refuses a board create that declares no workspace witness', async () => {
    const res = await call('/api/v1/admin/historical-import/validate', {
      plan: boardCreatePlan(null),
    });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: { code: string; message: string } };
    expect(payload.error.code).toBe('board-create-witness-required');
  });

  it('refuses a witness that disagrees with the staged board payload workspace', async () => {
    harnessHolder.deps.boardCreateWorkspaces.set(BOARD_SOURCE, OTHER_WORKSPACE);
    const res = await call('/api/v1/admin/historical-import/validate', { plan: boardCreatePlan() });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: { code: string; message: string } };
    expect(payload.error.code).toBe('board-create-witness-mismatch');
    expect(payload.error.message).toContain('workspace');
  });

  it('refuses a witness that cannot be proven from the staged payload', async () => {
    harnessHolder.deps.boardCreateWorkspaces.clear();
    const res = await call('/api/v1/admin/historical-import/validate', { plan: boardCreatePlan() });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: { code: string; message: string } };
    expect(payload.error.code).toBe('board-create-witness-invalid');
  });

  it('refuses a plan that spans the witnessed workspace and another workspace', async () => {
    // an op in the plan authorises through an EXISTING board in another workspace
    const plan = boardCreatePlan();
    (plan.operations[1]!.provenance as { board_id?: string }).board_id = SYNTH_BOARD_ID;
    boardRows.length = 0;
    boardRows.push({ id: SYNTH_BOARD_ID, workspace_id: OTHER_WORKSPACE });
    const res = await call('/api/v1/admin/historical-import/validate', { plan });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: { code: string } };
    expect(payload.error.message).toContain('multiple workspaces');
  });

  it('refuses a board create whose pre-existing target lives in another workspace', async () => {
    boardRows.push({ id: BOARD_ID, workspace_id: OTHER_WORKSPACE });
    const res = await call('/api/v1/admin/historical-import/validate', { plan: boardCreatePlan() });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: { code: string } };
    expect(payload.error.code).toBe('board-create-witness-mismatch');
  });

  it('still refuses unknown boards that the plan does not create', async () => {
    const plan = boardCreatePlan();
    (plan.operations[1]!.provenance as { board_id?: string }).board_id = 'brd_missing_0001';
    const res = await call('/api/v1/admin/historical-import/validate', { plan });
    expect(res.status).toBe(404);
    const payload = (await res.json()) as { error: { code: string; message: string } };
    expect(payload.error.code).toBe('board-not-found');
    expect(payload.error.message).toContain('brd_missing_0001');
  });

  it('applies OWNER authorization to the witnessed workspace', async () => {
    ownerScenario = 'member';
    const res = await call('/api/v1/admin/historical-import/validate', { plan: boardCreatePlan() });
    expect(res.status).toBe(403);
    const payload = (await res.json()) as { error: { code: string } };
    expect(payload.error.code).toBe('insufficient-role');
  });
});
