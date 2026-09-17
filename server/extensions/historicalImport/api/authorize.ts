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
import type { ImportPlan, ImporterDeps } from '../core/plan';

// A board the plan will create: its target does not exist yet, so the workspace
// it lands in must be declared (witness) and proven out of band.
export interface BoardCreateWitness {
  op_id: string;
  target_board_id: string | null;
  declared_workspace_id: string | null;
  payload_ref: string | null;
  source_id: string;
}

// Every board reference a plan authorises through, split by whether the board is
// expected to exist in the destination or is created by the plan itself.
export interface PlanWitnesses {
  existingBoardIds: string[];
  boardCreates: BoardCreateWitness[];
}

// Boards referenced by a plan: payloads are private, so authorization resolves
// from op target boards for board ops and op.provenance.board_id for entity ops.
// A board created by this plan is NOT an "existing board" witness (it cannot be
// read from the destination) — it is a board-create witness instead, which the
// list/card/comment ops that authorise through it share.
export function planAuthorizationWitnesses(plan: ImportPlan | null | undefined): PlanWitnesses {
  const createdBoardIds = new Set<string>();
  for (const op of plan?.operations ?? []) {
    if (
      op?.entity_type === 'board' &&
      op.operation === 'create' &&
      typeof op.target_id === 'string' &&
      op.target_id.length > 0
    ) {
      createdBoardIds.add(op.target_id);
    }
  }
  const existingBoardIds = new Set<string>();
  const boardCreates: BoardCreateWitness[] = [];
  for (const op of plan?.operations ?? []) {
    const boardId = (op as { provenance?: { board_id?: string } } | undefined)?.provenance
      ?.board_id;
    if (typeof boardId === 'string' && boardId.length > 0 && !createdBoardIds.has(boardId)) {
      existingBoardIds.add(boardId);
    }
    if (op?.entity_type !== 'board') continue;
    const target = typeof op.target_id === 'string' && op.target_id.length > 0 ? op.target_id : null;
    if (op.operation === 'create') {
      const declared = (op as { provenance?: { workspace_id?: string } }).provenance?.workspace_id;
      boardCreates.push({
        op_id: op.op_id,
        target_board_id: target,
        declared_workspace_id:
          typeof declared === 'string' && declared.length > 0 ? declared : null,
        payload_ref: typeof op.payload_ref === 'string' ? op.payload_ref : null,
        source_id: op.source_id,
      });
      continue;
    }
    if (target) existingBoardIds.add(target);
  }
  return { existingBoardIds: [...existingBoardIds], boardCreates };
}

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
    { status: 503 }
  );
}

// Requires workspace OWNER (import writes provenance + entity rows at
// workspace scope). GUEST/VIEWER/MEMBER/ADMIN are rejected.
export async function requireImportOperator(
  req: AuthenticatedRequest,
  workspaceId: string
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
      { status: 403 }
    );
  }
  return null;
}

// Resolve the workspace id governing an import plan: the workspace of the
// board each operation targets. All operations must resolve to a single
// workspace, else the plan is rejected (no cross-workspace plans).
//
// A board the plan is about to CREATE does not exist yet, so it cannot be
// resolved from the boards table (and neither can the list/card/comment ops that
// authorise through it). Those operations carry an explicit workspace witness
// (`provenance.workspace_id`) which is cross-checked here against the workspace
// the staged board payload will land in — proven by the adapter through the same
// owner gate the create path enforces — and against a pre-existing target board.
// A witness is never self-authorizing.
export async function resolvePlanWorkspace(
  witnesses: PlanWitnesses,
  deps: ImporterDeps
): Promise<{ workspaceId: string } | { error: Response }> {
  const { existingBoardIds, boardCreates } = witnesses;
  if (existingBoardIds.length === 0 && boardCreates.length === 0) {
    return {
      error: Response.json(
        { error: { code: 'bad-request', message: 'plan targets no board — cannot authorize' } },
        { status: 400 }
      ),
    };
  }
  const createdTargetIds = boardCreates
    .map((create) => create.target_board_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const boards = await db('boards')
    .whereIn('id', [...existingBoardIds, ...createdTargetIds])
    .select('id', 'workspace_id');
  const byId = new Map(
    boards.map((b: { id: string; workspace_id: string }) => [b.id, b.workspace_id])
  );
  const missing = existingBoardIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return {
      error: Response.json(
        { error: { code: 'board-not-found', message: `unknown board(s): ${missing.join(', ')}` } },
        { status: 404 }
      ),
    };
  }
  const workspaces = new Set(existingBoardIds.map((id) => byId.get(id) as string));

  for (const create of boardCreates) {
    const label = create.target_board_id ?? '(unresolved target id)';
    if (!create.declared_workspace_id) {
      return {
        error: Response.json(
          {
            error: {
              code: 'board-create-witness-required',
              message: `board create ${create.op_id} (${label}) must declare provenance.workspace_id — the workspace authorization witness for a board that does not exist yet`,
            },
          },
          { status: 400 }
        ),
      };
    }
    let proven: { workspace_id: string } | { error: string };
    try {
      proven = await deps.resolveBoardCreateWorkspace({
        source_id: create.source_id,
        payload_ref: create.payload_ref,
      });
    } catch (err: unknown) {
      proven = { error: err instanceof Error ? err.message : String(err) };
    }
    if ('error' in proven) {
      return {
        error: Response.json(
          {
            error: {
              code: 'board-create-witness-invalid',
              message: `board create ${create.op_id} (${label}): cannot prove the workspace from the staged board payload: ${proven.error}`,
            },
          },
          { status: 400 }
        ),
      };
    }
    if (proven.workspace_id !== create.declared_workspace_id) {
      return {
        error: Response.json(
          {
            error: {
              code: 'board-create-witness-mismatch',
              message: `board create ${create.op_id} (${label}): provenance.workspace_id (${create.declared_workspace_id}) disagrees with the workspace proven from the staged board payload (${proven.workspace_id})`,
            },
          },
          { status: 400 }
        ),
      };
    }
    const existing = create.target_board_id ? byId.get(create.target_board_id) : undefined;
    if (existing && existing !== proven.workspace_id) {
      return {
        error: Response.json(
          {
            error: {
              code: 'board-create-witness-mismatch',
              message: `board create ${create.op_id}: target board ${label} already exists in workspace ${existing}, not in the witnessed workspace ${proven.workspace_id}`,
            },
          },
          { status: 400 }
        ),
      };
    }
    workspaces.add(proven.workspace_id);
  }

  if (workspaces.size !== 1) {
    return {
      error: Response.json(
        { error: { code: 'bad-request', message: 'plan spans multiple workspaces — not allowed' } },
        { status: 400 }
      ),
    };
  }
  return { workspaceId: workspaces.values().next().value as string };
}
