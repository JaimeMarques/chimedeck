// server/extensions/historicalImport/api/router.ts
// REST surface for the administrative historical-import extension.
//
// Endpoints (all require: authenticated API token/JWT, workspace OWNER,
// HISTORICAL_IMPORT_ENABLED=true; apply additionally requires
// HISTORICAL_IMPORT_APPLY_ENABLED=true and a confirmed plan hash):
//
//   POST /api/v1/admin/historical-import/validate
//        body: { plan: ImportPlan }
//        => 200 { data: { validation } }  — returns computed plan_hash
//
//   POST /api/v1/admin/historical-import/dry-run
//        body: { plan: ImportPlan }
//        => 200 { data: { result } }  — no writes to entity tables
//
//   POST /api/v1/admin/historical-import/apply
//        body: { plan: ImportPlan, confirmed_plan_hash: string,
//                confirmed_destination_fingerprint: string }
//        => 200 { data: { result } } | 403/409 gate errors
//        The destination fingerprint is returned by validate/dry-run and is
//        mandatory: it is the stop for destination-state divergence.
//
//   POST /api/v1/admin/historical-import/reset
//        body: { plan_hash: string, recovery?: boolean, confirm_destructive?: boolean }
//        => 200 { data: { cleared, created_targets_remaining, ... } }
//           with recovery=true (+ confirm_destructive) deletes the rows this
//           plan created, then clears provenance; refused (409) when any row
//           outside the plan's own creation set would be affected.
//
//   GET  /api/v1/admin/historical-import/provenance?entity_type=&source_id=
//   => 200 { data: { provenance | null } }
//
//   GET  /api/v1/admin/historical-import/audit?plan_hash=&limit=
//   => 200 { data: { entries: [...] } }
//
// Environment gates: HISTORICAL_IMPORT_ENABLED, HISTORICAL_IMPORT_APPLY_ENABLED,
// HISTORICAL_IMPORT_EXPECTED_SNAPSHOT_HASH (frozen source snapshot — enforced
// against the plan's snapshot_hash), HISTORICAL_IMPORT_RESET_RECOVERY_ENABLED
// (enables destructive recovery).
//
// Notifications/webhooks/automation suppression: entity rows are written
// directly (knex) without dispatching domain events, so mentions/automation/
// notification fan-out of the normal create paths never fires during import.
// The import has its own audit trail (import_audit_log) recording the
// OPERATOR; historical authors are recorded in import_provenance + payload.
import { db } from '../../../common/db';
import { authenticate, type AuthenticatedRequest } from '../../auth/middlewares/authentication';
import {
  importDisabledResponse,
  planAuthorizationWitnesses,
  requireImportOperator,
  resolvePlanWorkspace,
} from './authorize';
import {
  applyPlan,
  dryRunPlan,
  recoverPlan,
  resetPlan,
  validatePlan,
  type ImportPlan,
  type PlanApplyResult,
  type PlanExpectations,
} from '../core/plan';
import { createKnexDeps, loadIdentityMap } from '../core/adapters';
import { loadCardDescriptionAuthorization } from '../core/cardDescriptionAuthorization';
import { decodeCompositeTargetId } from '../core/composite';

function badRequest(message: string): Response {
  return Response.json({ error: { code: 'bad-request', message } }, { status: 400 });
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;

// Out-of-band expectations are read per request from the server environment —
// never from the plan document, which must not authorize its own snapshot.
function readExpectations(): PlanExpectations {
  const expected = Bun.env['HISTORICAL_IMPORT_EXPECTED_SNAPSHOT_HASH'];
  return {
    expectedSnapshotHash: typeof expected === 'string' && expected.length > 0 ? expected : null,
  };
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Boards referenced by a plan (payloads are private; authorization resolves
// from op target boards for board/list ops and op.provenance.board_id for entity
// ops — carried as provenance.board_id when present), including the workspace
// witness of every board the plan itself creates.

export async function historicalImportRouter(
  req: Request,
  pathname: string
): Promise<Response | null> {
  if (!pathname.startsWith('/api/v1/admin/historical-import')) return null;

  // Gates are evaluated per-request (not cached at module load) so ops can
  // flip them via env without a code change and tests can exercise both.
  if (Bun.env['HISTORICAL_IMPORT_ENABLED'] !== 'true') {
    const disabled = importDisabledResponse();
    if (disabled) return disabled;
  }

  const authError = await authenticate(req as AuthenticatedRequest);
  if (authError) return authError;
  const currentUser = (req as AuthenticatedRequest).currentUser;
  if (!currentUser) {
    return Response.json(
      { error: { code: 'unauthorized', message: 'Authentication required' } },
      { status: 401 }
    );
  }
  const actorId = currentUser.id;

  // ---- POST validate ----
  if (pathname === '/api/v1/admin/historical-import/validate' && req.method === 'POST') {
    const body = await readJson(req);
    const plan = body?.plan as ImportPlan | undefined;
    if (!plan) return badRequest('body.plan is required');
    // Authorization consumes the adapter's out-of-band board-create witness
    // proof, so deps are created before the workspace is resolved.
    const deps = await createDeps(actorId);
    const ws = await resolvePlanWorkspace(planAuthorizationWitnesses(plan), deps);
    if ('error' in ws) return ws.error;
    const authz = await requireImportOperator(req as AuthenticatedRequest, ws.workspaceId);
    if (authz) return authz;
    const validation = await validatePlan(plan, deps, actorId, readExpectations());
    return Response.json({ data: { validation } });
  }

  // ---- POST dry-run ----
  if (pathname === '/api/v1/admin/historical-import/dry-run' && req.method === 'POST') {
    const body = await readJson(req);
    const plan = body?.plan as ImportPlan | undefined;
    if (!plan) return badRequest('body.plan is required');
    // Authorization consumes the adapter's out-of-band board-create witness
    // proof, so deps are created before the workspace is resolved.
    const deps = await createDeps(actorId);
    const ws = await resolvePlanWorkspace(planAuthorizationWitnesses(plan), deps);
    if ('error' in ws) return ws.error;
    const authz = await requireImportOperator(req as AuthenticatedRequest, ws.workspaceId);
    if (authz) return authz;
    const result = (await dryRunPlan(
      plan,
      deps,
      actorId,
      readExpectations()
    )) as PlanApplyResult & {
      validation_errors?: unknown;
    };
    if (result.validation_errors) {
      return Response.json(
        {
          error: {
            code: 'plan-invalid',
            message: 'plan failed validation',
            data: result.validation_errors,
          },
        },
        { status: 422 }
      );
    }
    return Response.json({ data: { result } });
  }

  // ---- POST apply ----
  if (pathname === '/api/v1/admin/historical-import/apply' && req.method === 'POST') {
    if (Bun.env['HISTORICAL_IMPORT_APPLY_ENABLED'] !== 'true') {
      return Response.json(
        {
          error: {
            code: 'apply-disabled',
            message: 'Apply is disabled (set HISTORICAL_IMPORT_APPLY_ENABLED=true)',
          },
        },
        { status: 403 }
      );
    }
    const body = await readJson(req);
    const plan = body?.plan as ImportPlan | undefined;
    const confirmed = body?.confirmed_plan_hash;
    const confirmedDestination = body?.confirmed_destination_fingerprint;
    if (!plan) return badRequest('body.plan is required');
    if (typeof confirmed !== 'string') return badRequest('body.confirmed_plan_hash is required');
    if (typeof confirmedDestination !== 'string' || !HASH_PATTERN.test(confirmedDestination)) {
      return badRequest(
        'body.confirmed_destination_fingerprint is required (64-hex): re-run validate/dry-run and echo destination_fingerprint'
      );
    }
    // Authorization consumes the adapter's out-of-band board-create witness
    // proof, so deps are created before the workspace is resolved.
    const deps = await createDeps(actorId);
    const ws = await resolvePlanWorkspace(planAuthorizationWitnesses(plan), deps);
    if ('error' in ws) return ws.error;
    const authz = await requireImportOperator(req as AuthenticatedRequest, ws.workspaceId);
    if (authz) return authz;
    const result = await applyPlan(
      plan,
      {
        applyEnabled: true,
        confirmedPlanHash: confirmed,
        confirmedDestinationFingerprint: confirmedDestination,
        expectations: readExpectations(),
      },
      deps,
      actorId
    );
    if ('error' in result) {
      // 409 = the world changed under the confirmation (re-observe and retry);
      // 403 = a gate refused.
      const conflict =
        result.code === 'destination-state-divergence' ||
        result.code === 'snapshot-divergence' ||
        result.code === 'external-input-divergence';
      return Response.json(
        { error: { code: result.code, message: result.error } },
        { status: conflict ? 409 : 403 }
      );
    }
    return Response.json({ data: { result } });
  }

  // ---- POST reset ----
  if (pathname === '/api/v1/admin/historical-import/reset' && req.method === 'POST') {
    const body = await readJson(req);
    const planHash = body?.plan_hash;
    const recovery = body?.recovery === true;
    const confirmDestructive = body?.confirm_destructive === true;
    if (typeof planHash !== 'string' || !HASH_PATTERN.test(planHash)) {
      return badRequest('body.plan_hash must be a 64-hex string');
    }
    // Reset authorizes against the workspace of any provenance row of the plan.
    const row = (await db('import_provenance').where({ import_plan_hash: planHash }).first()) as
      | { entity_type: string; target_id: string }
      | undefined;
    if (!row) {
      return Response.json({
        data: {
          cleared: 0,
          created_targets_remaining: [],
          recovery: recovery ? 'recovery' : 'provenance-only',
          recovery_note: 'no provenance rows for this plan hash — nothing to reset',
        },
      });
    }
    const entityTableBoard = await resolveBoardForEntity(row.entity_type, row.target_id);
    if (!entityTableBoard) return badRequest('cannot resolve workspace for plan — reset denied');
    // Reset authorises against an existing board only (the plan's own witness is
    // not applicable: reset is addressed by a provenance row, not a plan).
    const deps = await createDeps(actorId);
    const ws = await resolvePlanWorkspace(
      { existingBoardIds: [entityTableBoard], boardCreates: [] },
      deps
    );
    if ('error' in ws) return ws.error;
    const authz = await requireImportOperator(req as AuthenticatedRequest, ws.workspaceId);
    if (authz) return authz;

    if (!recovery) {
      const result = await resetPlan(planHash, deps, actorId);
      return Response.json({ data: result });
    }
    const report = await recoverPlan(planHash, deps, actorId, {
      confirmDestructive,
      recoveryEnabled: Bun.env['HISTORICAL_IMPORT_RESET_RECOVERY_ENABLED'] === 'true',
    });
    if ('error' in report) {
      const status = report.code === 'recovery-disabled' ? 403 : 400;
      return Response.json({ error: { code: report.code, message: report.error } }, { status });
    }
    if (!report.ok) {
      // Fail-closed: nothing was deleted; the blockers explain why.
      return Response.json(
        { error: { code: 'recovery-refused', message: 'recovery refused', data: report } },
        { status: 409 }
      );
    }
    return Response.json({ data: report });
  }

  // ---- GET provenance ----
  if (pathname === '/api/v1/admin/historical-import/provenance' && req.method === 'GET') {
    const url = new URL(req.url);
    const entityType = url.searchParams.get('entity_type');
    const sourceId = url.searchParams.get('source_id');
    if (!entityType || !sourceId)
      return badRequest('entity_type and source_id query params are required');
    const row = await db('import_provenance')
      .where({ entity_type: entityType, source_id: sourceId })
      .first();
    return Response.json({ data: { provenance: row ?? null } });
  }

  // ---- GET audit ----
  if (pathname === '/api/v1/admin/historical-import/audit' && req.method === 'GET') {
    const url = new URL(req.url);
    const planHash = url.searchParams.get('plan_hash');
    const limitRaw = url.searchParams.get('limit');
    const limit = Math.min(Math.max(parseInt(limitRaw ?? '50', 10) || 50, 1), 200);
    const q = db('import_audit_log').orderBy('created_at', 'desc').limit(limit);
    const rows = await (planHash ? q.where({ import_plan_hash: planHash }) : q);
    return Response.json({ data: { entries: rows } });
  }

  return Response.json(
    { error: { code: 'not-found', message: `${req.method} ${pathname} not found` } },
    { status: 404 }
  );
}

async function createDeps(operatorUserId: string) {
  const [identityMap, cardDescriptionAuthorization] = await Promise.all([
    loadIdentityMap(),
    loadCardDescriptionAuthorization(),
  ]);
  return createKnexDeps(identityMap, cardDescriptionAuthorization, operatorUserId);
}

// Resolve a board id for an entity type/target so reset can authorize.
async function resolveBoardForEntity(entityType: string, targetId: string): Promise<string | null> {
  try {
    switch (entityType) {
      case 'board':
        return targetId;
      case 'list': {
        const row = (await db('lists').where({ id: targetId }).first()) as
          | { board_id?: string }
          | undefined;
        return row?.board_id ?? null;
      }
      case 'card':
      case 'checklist':
      case 'checklist_item':
      case 'attachment':
      case 'comment':
      case 'card_label':
      case 'card_member':
      case 'custom_field_value': {
        const cardId = await resolveCardId(targetId, entityType);
        if (!cardId) return null;
        const card = (await db('cards').where({ id: cardId }).first()) as
          | { list_id: string }
          | undefined;
        if (!card) return null;
        const list = (await db('lists').where({ id: card.list_id }).first()) as
          | { board_id?: string }
          | undefined;
        return list?.board_id ?? null;
      }
      case 'label':
      case 'custom_field': {
        const row = (await db(entityType === 'label' ? 'labels' : 'custom_fields')
          .where({ id: targetId })
          .first()) as { board_id?: string } | undefined;
        return row?.board_id ?? null;
      }
      case 'activity': {
        const row = (await db('activities').where({ id: targetId }).first()) as
          | { board_id?: string }
          | undefined;
        return row?.board_id ?? null;
      }
      case 'comment_reaction':
      case 'mention':
      default:
        return null;
    }
  } catch {
    return null;
  }
}

async function resolveCardId(targetId: string, entityType: string): Promise<string | null> {
  switch (entityType) {
    case 'card':
      return targetId;
    case 'comment': {
      const c = (await db('comments').where({ id: targetId }).first()) as
        | { card_id?: string }
        | undefined;
      return c?.card_id ?? null;
    }
    case 'attachment': {
      const a = (await db('attachments').where({ id: targetId }).first()) as
        | { card_id?: string }
        | undefined;
      return a?.card_id ?? null;
    }
    case 'checklist': {
      const cl = (await db('checklists').where({ id: targetId }).first()) as
        | { card_id?: string }
        | undefined;
      return cl?.card_id ?? null;
    }
    case 'checklist_item': {
      const ci = (await db('checklist_items').where({ id: targetId }).first()) as
        | { card_id?: string }
        | undefined;
      return ci?.card_id ?? null;
    }
    case 'card_label':
    case 'card_member': {
      // Join tables: provenance target_id is the composite key
      // "<card_id>:<label_id|user_id>" — the parent card is its first part.
      const key = decodeCompositeTargetId(entityType, targetId);
      return key.card_id ?? null;
    }
    case 'custom_field_value': {
      const cfv = (await db('card_custom_field_values').where({ id: targetId }).first()) as
        | { card_id?: string }
        | undefined;
      return cfv?.card_id ?? null;
    }
    default:
      return null;
  }
}
