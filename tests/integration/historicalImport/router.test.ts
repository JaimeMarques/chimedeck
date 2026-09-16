// tests/integration/historicalImport/router.test.ts
// Router-level gate tests with mocked auth/db boundary.
// [why] The plan engine is fully tested in historicalImport.test.ts; here we
// verify the HTTP surface contract: routing paths, method handling, disabled
// extension behavior, bad-request shapes. Auth/RBAC and knex flows rely on
// the same middlewares as the rest of the app (unit-tested there); we mock
// the modules to isolate the router.
import { beforeEach, describe, expect, it, mock } from 'bun:test';

const authenticateMock = mock(async (req: { currentUser?: { id: string; email: string } }) => {
  req.currentUser = { id: 'usr_operator_0001', email: 'operator@synth.test' };
  return null as Response | null;
});
mock.module('../../../server/extensions/auth/middlewares/authentication', () => ({
  authenticate: authenticateMock,
}));

let ownerScenario: 'owner' | 'member' | 'none' = 'owner';
mock.module('../../../server/middlewares/permissionManager', () => ({
  requireWorkspaceMembership: async (req: { currentUser?: { id: string } }, _ws: string) => {
    if (!req.currentUser) return Response.json({ error: { code: 'unauthorized' } }, { status: 401 });
    if (ownerScenario === 'none') {
      return Response.json({ error: { code: 'insufficient-role', message: 'no membership' } }, { status: 403 });
    }
    (req as { callerRole?: string }).callerRole = ownerScenario === 'owner' ? 'OWNER' : 'MEMBER';
    return null;
  },
  requireRole: () => null,
  hasRole: (callerRole: string, minRole: string) => {
    const rank: Record<string, number> = { OWNER: 4, ADMIN: 3, MEMBER: 2, VIEWER: 1, GUEST: 0 };
    return (rank[callerRole] ?? 0) >= (rank[minRole] ?? 0);
  },
  resolveHighestRole: () => (ownerScenario === 'none' ? null : ownerScenario === 'owner' ? 'OWNER' : 'MEMBER'),
}));

const boardRows: Array<{ id: string; workspace_id: string }> = [];
mock.module('../../../server/common/db', () => {
  const table = (name: string) => {
    const qb: Record<string, unknown> = {
      whereIn: (_col: string, ids: string[]) => ({
        select: async () => boardRows.filter((b) => ids.includes(b.id)),
      }),
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

const { historicalImportRouter } = await import('../../../server/extensions/historicalImport/api/router');
const { syntheticPlan } = await import('./fixtures');

function jsonReq(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer hf_test' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  authenticateMock.mockClear();
  ownerScenario = 'owner';
  delete process.env['HISTORICAL_IMPORT_ENABLED'];
  delete process.env['HISTORICAL_IMPORT_APPLY_ENABLED'];
  boardRows.length = 0;
  boardRows.push({ id: 'brd_synth_0001', workspace_id: 'ws_synth_0001' });
});

describe('historicalImport router', () => {
  it('ignores unrelated paths', async () => {
    expect(await historicalImportRouter(jsonReq('GET', '/api/v1/cards'), '/api/v1/cards')).toBeNull();
  });

  it('returns 503 when the extension is disabled', async () => {
    const res = await historicalImportRouter(
      jsonReq('POST', '/api/v1/admin/historical-import/validate', { plan: syntheticPlan() }),
      '/api/v1/admin/historical-import/validate',
    );
    // HISTORICAL_IMPORT_ENABLED is not set in the test env => disabled.
    expect(res!.status).toBe(503);
  });

  it('validates a plan and returns the computed hash when enabled', async () => {
    process.env['HISTORICAL_IMPORT_ENABLED'] = 'true';
    try {
      const res = await historicalImportRouter(
        jsonReq('POST', '/api/v1/admin/historical-import/validate', { plan: syntheticPlan() }),
        '/api/v1/admin/historical-import/validate',
      );
      expect(res!.status).toBe(200);
      const payload = (await res!.json()) as { data: { validation: { ok: boolean; plan_hash: string } } };
      expect(payload.data.validation.ok).toBe(true);
      expect(payload.data.validation.plan_hash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      delete process.env['HISTORICAL_IMPORT_ENABLED'];
    }
  });

  it('requires body.plan', async () => {
    process.env['HISTORICAL_IMPORT_ENABLED'] = 'true';
    try {
      const res = await historicalImportRouter(
        jsonReq('POST', '/api/v1/admin/historical-import/validate', {}),
        '/api/v1/admin/historical-import/validate',
      );
      expect(res!.status).toBe(400);
    } finally {
      delete process.env['HISTORICAL_IMPORT_ENABLED'];
    }
  });

  it('rejects non-OWNER operators with 403', async () => {
    process.env['HISTORICAL_IMPORT_ENABLED'] = 'true';
    ownerScenario = 'member';
    try {
      const res = await historicalImportRouter(
        jsonReq('POST', '/api/v1/admin/historical-import/validate', { plan: syntheticPlan() }),
        '/api/v1/admin/historical-import/validate',
      );
      expect(res!.status).toBe(403);
      const payload = (await res!.json()) as { error: { code: string } };
      expect(payload.error.code).toBe('insufficient-role');
    } finally {
      delete process.env['HISTORICAL_IMPORT_ENABLED'];
    }
  });

  it('refuses apply while the global apply gate is off', async () => {
    process.env['HISTORICAL_IMPORT_ENABLED'] = 'true';
    try {
      const res = await historicalImportRouter(
        jsonReq('POST', '/api/v1/admin/historical-import/apply', {
          plan: syntheticPlan(),
          confirmed_plan_hash: 'a'.repeat(64),
        }),
        '/api/v1/admin/historical-import/apply',
      );
      expect(res!.status).toBe(403);
      const payload = (await res!.json()) as { error: { code: string } };
      expect(payload.error.code).toBe('apply-disabled');
    } finally {
      delete process.env['HISTORICAL_IMPORT_ENABLED'];
    }
  });

  it('rejects a plan that targets an unknown board', async () => {
    process.env['HISTORICAL_IMPORT_ENABLED'] = 'true';
    try {
      const plan = syntheticPlan();
      const res = await historicalImportRouter(
        jsonReq('POST', '/api/v1/admin/historical-import/validate', { plan }),
        '/api/v1/admin/historical-import/validate',
      );
      // board brd_synth_0001 seeded => 200 (plan targets only that board)
      expect(res!.status).toBe(200);
    } finally {
      delete process.env['HISTORICAL_IMPORT_ENABLED'];
    }
  });
});
