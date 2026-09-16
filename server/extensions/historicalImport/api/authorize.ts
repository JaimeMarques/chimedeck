// server/extensions/historicalImport/api/authorize.ts
// Authorization for the historical-import extension.
//
// [why] Import operations are administrative and cross-board by nature; they
// must NOT be authorizable per-board. We require workspace OWNER on the
// target workspace, resolved per-operation from the plan's target board, plus
// a global enable flag. This keeps the executor distinct from historical
// authors: the operator acts under their own identity, authors are recorded
// in provenance.
import { db } from '../../../common/db';
import {
  requireWorkspaceMembership,
  hasRole,
  type WorkspaceScopedRequest,
} from '../../../middlewares/permissionManager';
import type { AuthenticatedRequest } from '../../auth/middlewares/authentication';

// Resolve enablement per request. Process environments are captured only at
// process launch in many deployment managers; evaluating here keeps the
// router's documented request-time gate semantics accurate for the runtime.
export function historicalImportEnabled(): boolean {
  return Bun.env['HISTORICAL_IMPORT_ENABLED'] === 'true';
}

export function importDisabledResponse(): Response | null {
  if (historicalImportEnabled()) return null;
  return Response.json(
    {
      error: {
        code: 'historical-import-disabled',
        message: 'Historical import extension is disabled (set HISTORICAL_IMPORT_ENABLED=true).',
      },
    },
    { status: 503 },
  );
}

// Requires workspace OWNER (import writes provenance + entity rows at
// workspace scope). GUEST/VIEWER/MEMBER/ADMIN are rejected.
export async function requireImportOperator(
  req: AuthenticatedRequest,
  workspaceId: string,
): Promise<Response | null> {
  const scoped = req as WorkspaceScopedRequest;
  const membershipError = await requireWorkspaceMembership(scoped, workspaceId);
  if (membershipError) return membershipError;
  if (!scoped.callerRole || !hasRole(scoped.callerRole, 'OWNER')) {
    return Response.json(
      {
        error: {
          code: 'insufficient-role',
          message: 'Historical import requires workspace OWNER role',
        },
      },
      { status: 403 },
    );
  }
  return null;
}

// Resolve the workspace id governing an import plan: the workspace of the
// board each operation targets. All operations must resolve to a single
// workspace, else the plan is rejected (no cross-workspace plans).
export async function resolvePlanWorkspace(
  targetBoardIds: string[],
): Promise<{ workspaceId: string } | { error: Response }> {
  if (targetBoardIds.length === 0) {
    return { error: Response.json(
      { error: { code: 'bad-request', message: 'plan targets no board — cannot authorize' } },
      { status: 400 },
    ) };
  }
  const boards = await db('boards').whereIn('id', targetBoardIds).select('id', 'workspace_id');
  const byId = new Map(boards.map((b: { id: string; workspace_id: string }) => [b.id, b.workspace_id]));
  const missing = targetBoardIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return { error: Response.json(
      { error: { code: 'board-not-found', message: `unknown board(s): ${missing.join(', ')}` } },
      { status: 404 },
    ) };
  }
  const workspaces = new Set(targetBoardIds.map((id) => byId.get(id)));
  if (workspaces.size !== 1) {
    return { error: Response.json(
      { error: { code: 'bad-request', message: 'plan spans multiple workspaces — not allowed' } },
      { status: 400 },
    ) };
  }
  return { workspaceId: workspaces.values().next().value as string };
}
