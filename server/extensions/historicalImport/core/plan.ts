// server/extensions/historicalImport/core/plan.ts
// Core historical-import engine: validate / dry-run / apply / reset.
//
// Design contract (from the reconciliation task):
// - Manifest ops: entity_type, source_id, target_id?, operation,
//   provenance, evidence_refs, expected_target_fingerprint,
//   payload_ref (private — never transported through the tool),
//   dependencies.
// - Dry-run by default; apply requires explicit gates
//   (HISTORICAL_IMPORT_APPLY_ENABLED=true AND confirmed_plan_hash
//   matching the validated plan's hash).
// - Unresolved identity => operation blocked (not skipped).
// - Prohibits: delete, board replacement, overwrite of native rows,
//   overwrite of drifted imported rows.
// - Idempotent: create-ops that find existing provenance for the same
//   source are no-ops; re-running a plan is safe.
// - Per-op transaction; a failing op records failure and (default)
//   stops the run (fail-fast), leaving prior ops committed and
//   resumable.
//
// [why] The importer is expressed against an ImporterDeps interface so tests
// inject in-memory stores, and production wiring passes the knex db.
import { randomUUID } from 'node:crypto';
import {
  FINGERPRINT_ALGORITHM,
  fingerprintFields,
  fingerprintJson,
  CARD_FINGERPRINT_FIELDS,
  COMMENT_FINGERPRINT_FIELDS,
  hashPlanDocument,
} from './fingerprint';

// ---------------------------------------------------------------------------
// Manifest types
// ---------------------------------------------------------------------------

export const ENTITY_TYPES = [
  'board',
  'list',
  'card',
  'comment',
  'comment_reaction',
  'attachment',
  'checklist',
  'checklist_item',
  'label',
  'card_label',
  'card_member',
  'custom_field',
  'custom_field_value',
  'activity',
  'mention',
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const OPERATIONS = ['create', 'link'] as const;
export type Operation = (typeof OPERATIONS)[number];

export interface ImportProvenanceInfo {
  source_system: string; // 'trello'
  source_id: string;
  evidence_refs: string[]; // e.g. ['trello-export:actions/64a1...']
  exported_at?: string;
  // Board whose workspace authorizes this operation (optional for
  // board-level ops where target_id is the board itself).
  board_id?: string;
}

export interface ImportOperation {
  op_id: string; // stable within plan, e.g. 'op-001'
  entity_type: EntityType;
  source_id: string;
  target_id?: string; // optional pre-resolved target
  operation: Operation;
  provenance: ImportProvenanceInfo;
  evidence_refs: string[];
  expected_target_fingerprint: string | null;
  payload_ref: string | null; // private payload locator — validated shape only
  dependencies: string[]; // op_ids that must be applied before this one
}

export interface ImportPlan {
  plan_id: string;
  plan_hash?: string; // server-computed on validation; caller passes on apply
  snapshot_hash?: string; // hash of the source snapshot the plan was built from
  source_system: string; // 'trello'
  created_at: string;
  operations: ImportOperation[];
}

export type OpOutcome =
  | { status: 'applied'; op_id: string; target_id: string }
  | { status: 'noop'; op_id: string; reason: string; target_id?: string }
  | { status: 'blocked'; op_id: string; reason: string }
  | { status: 'failed'; op_id: string; reason: string };

export interface PlanValidationResult {
  ok: boolean;
  plan_hash: string;
  snapshot_hash: string | null;
  operations_total: number;
  errors: Array<{ op_id: string; code: string; message: string }>;
  warnings: Array<{ op_id: string; code: string; message: string }>;
}

export interface PlanApplyResult {
  mode: 'dry-run' | 'apply';
  plan_hash: string;
  operations_total: number;
  operations_applied: number;
  operations_noop: number;
  operations_blocked: number;
  operations_failed: number;
  outcomes: OpOutcome[];
  stopped_early: boolean;
}

// ---------------------------------------------------------------------------
// Importer deps — everything the engine needs from the outside world.
// Production: knex-backed adapters (./adapters.ts). Tests: in-memory stores.
// ---------------------------------------------------------------------------

export interface FetchedRow {
  row: Record<string, unknown> | null;
  provenance: ProvenanceRow | null; // provenance for (entity_type, source_id)
}

export interface ProvenanceRow {
  id: string;
  source_system: string;
  entity_type: string;
  source_id: string;
  target_id: string;
  target_ref: string;
  import_plan_hash: string;
  operation: string;
}

export interface ImporterDeps {
  // Fetch a target row by id (entity table read).
  fetchTarget(entityType: EntityType, targetId: string): Promise<Record<string, unknown> | null>;
  // Fetch provenance by source identity.
  fetchProvenance(entityType: EntityType, sourceId: string): Promise<ProvenanceRow | null>;
  // Fetch provenance by target reference (drift/overwrite detection).
  fetchProvenanceByTarget(entityType: EntityType, targetId: string): Promise<ProvenanceRow | null>;
  // Resolve a historical author identity to a ChimeDeck user id.
  // Must return null for unresolved identities (=> op blocked).
  resolveIdentity(sourceSystem: string, sourceUserId: string): Promise<string | null>;
  // Apply-only creation: atomically create the row + provenance, or no-op if
  // provenance already exists. Returns the resulting target id.
  createWithProvenance(input: {
    entity_type: EntityType;
    source_id: string;
    target_id: string;
    payload_ref: string | null;
    plan_hash: string;
    operation: Operation;
  }): Promise<{ target_id: string; created: boolean }>;
  // Dry-run creation preflight. Implementations MUST resolve the same payload
  // source and validate the same identity/schema/constraint path as apply,
  // without committing entity or provenance rows. A false result is reported
  // as a dry-run failed outcome; this keeps rehearsal and apply parity.
  preflightCreate(input: {
    entity_type: EntityType;
    source_id: string;
    target_id: string;
    payload_ref: string | null;
    plan_hash: string;
    operation: Operation;
  }): Promise<{ ok: true } | { ok: false; reason: string }>;
  // Link an existing target row to a source identity (provenance insert only).
  linkProvenance(input: {
    entity_type: EntityType;
    source_id: string;
    target_id: string;
    plan_hash: string;
  }): Promise<void>;
  // Append an audit entry (never throws into the engine path).
  writeAudit(entry: {
    actor_user_id: string;
    action: 'validate' | 'dry_run' | 'apply' | 'reset';
    import_plan_hash: string;
    operations_total: number;
    operations_applied: number;
    operations_noop: number;
    operations_failed: number;
    detail: Record<string, unknown>;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Validation — pure over the manifest + deps reads.
// ---------------------------------------------------------------------------

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isValidHash(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
}

export async function validatePlan(
  plan: unknown,
  deps: ImporterDeps,
  actorUserId: string,
): Promise<PlanValidationResult> {
  const errors: PlanValidationResult['errors'] = [];
  const warnings: PlanValidationResult['warnings'] = [];
  const result: PlanValidationResult = {
    ok: false,
    plan_hash: '',
    snapshot_hash: null,
    operations_total: 0,
    errors,
    warnings,
  };

  if (plan === null || typeof plan !== 'object') {
    errors.push({ op_id: 'plan', code: 'plan-invalid', message: 'plan must be a JSON object' });
    return result;
  }
  const p = plan as ImportPlan;
  if (!isNonEmptyString(p.plan_id)) {
    errors.push({ op_id: 'plan', code: 'plan-id-required', message: 'plan_id is required' });
  }
  if (!isNonEmptyString(p.source_system)) {
    errors.push({ op_id: 'plan', code: 'source-system-required', message: 'source_system is required' });
  }
  if (typeof p.created_at !== 'string' || Number.isNaN(Date.parse(p.created_at))) {
    errors.push({ op_id: 'plan', code: 'created-at-invalid', message: 'created_at must be an ISO timestamp' });
  }
  if (p.snapshot_hash !== undefined && p.snapshot_hash !== null && !isValidHash(p.snapshot_hash)) {
    errors.push({
      op_id: 'plan',
      code: 'snapshot-hash-invalid',
      message: 'snapshot_hash must be a 64-hex sha256 (algorithm sha256-plan-v1)',
    });
  }
  if (!Array.isArray(p.operations)) {
    errors.push({ op_id: 'plan', code: 'operations-required', message: 'operations must be an array' });
    return result;
  }

  result.operations_total = p.operations.length;
  if (p.operations.length === 0) {
    warnings.push({ op_id: 'plan', code: 'plan-empty', message: 'plan has no operations' });
  }

  const seenOpIds = new Set<string>();
  const seenSourceKeys = new Set<string>();

  for (let i = 0; i < p.operations.length; i++) {
    const op = p.operations[i];
    const opId = op?.op_id ?? `operations[${i}]`;
    if (!op || typeof op !== 'object') {
      errors.push({ op_id: opId, code: 'op-invalid', message: 'operation must be an object' });
      continue;
    }
    if (!isNonEmptyString(op.op_id)) {
      errors.push({ op_id: opId, code: 'op-id-required', message: 'op_id is required' });
    } else if (seenOpIds.has(op.op_id)) {
      errors.push({ op_id: op.op_id, code: 'op-id-duplicate', message: `duplicate op_id ${op.op_id}` });
    } else {
      seenOpIds.add(op.op_id);
    }

    if (!(ENTITY_TYPES as readonly string[]).includes(op.entity_type)) {
      errors.push({
        op_id: opId,
        code: 'entity-type-invalid',
        message: `entity_type must be one of ${ENTITY_TYPES.join('|')}`,
      });
    }
    if (!isNonEmptyString(op.source_id)) {
      errors.push({ op_id: opId, code: 'source-id-required', message: 'source_id is required' });
    }
    if (!(OPERATIONS as readonly string[]).includes(op.operation)) {
      errors.push({
        op_id: opId,
        code: 'operation-invalid',
        message: `operation must be one of ${OPERATIONS.join('|')}`,
      });
    }

    // provenance block
    const prov = op.provenance;
    if (!prov || typeof prov !== 'object' || !isNonEmptyString(prov.source_system)) {
      errors.push({
        op_id: opId,
        code: 'provenance-required',
        message: 'provenance.source_system is required',
      });
    } else if (prov.source_system !== p.source_system) {
      errors.push({
        op_id: opId,
        code: 'provenance-mismatch',
        message: `provenance.source_system (${prov.source_system}) does not match plan.source_system (${p.source_system})`,
      });
    }
    if (prov && prov.source_id !== undefined && prov.source_id !== op.source_id) {
      errors.push({
        op_id: opId,
        code: 'provenance-source-mismatch',
        message: 'provenance.source_id must equal op.source_id',
      });
    }

    if (!Array.isArray(op.evidence_refs) || op.evidence_refs.length === 0) {
      errors.push({
        op_id: opId,
        code: 'evidence-refs-required',
        message: 'evidence_refs must be a non-empty array (e.g. trello-export action IDs)',
      });
    } else if (op.evidence_refs.some((r) => !isNonEmptyString(r))) {
      errors.push({ op_id: opId, code: 'evidence-refs-invalid', message: 'evidence_refs entries must be non-empty strings' });
    }

    if (op.expected_target_fingerprint !== null && op.expected_target_fingerprint !== undefined) {
      if (!isValidHash(op.expected_target_fingerprint)) {
        errors.push({
          op_id: opId,
          code: 'fingerprint-invalid',
          message: `expected_target_fingerprint must be 64-hex sha256 (${FINGERPRINT_ALGORITHM}) or null`,
        });
      }
    }

    if (op.payload_ref !== null && op.payload_ref !== undefined && !isNonEmptyString(op.payload_ref)) {
      errors.push({ op_id: opId, code: 'payload-ref-invalid', message: 'payload_ref must be a non-empty string or null' });
    }

    if (!Array.isArray(op.dependencies)) {
      errors.push({ op_id: opId, code: 'dependencies-invalid', message: 'dependencies must be an array of op_ids' });
    }

    // duplicate source identity within one plan
    if (isNonEmptyString(op.source_id) && typeof op.entity_type === 'string') {
      const key = `${op.entity_type}:${op.source_id}`;
      if (seenSourceKeys.has(key)) {
        errors.push({
          op_id: opId,
          code: 'duplicate-source',
          message: `duplicate source entity ${key} within plan`,
        });
      } else {
        seenSourceKeys.add(key);
      }
    }
  }

  // second pass — dependency graph checks need all op_ids known
  for (const op of p.operations) {
    if (!op || typeof op !== 'object' || !isNonEmptyString(op.op_id)) continue;
    for (const dep of op.dependencies ?? []) {
      if (!seenOpIds.has(dep)) {
        errors.push({
          op_id: op.op_id,
          code: 'dependency-unknown',
          message: `dependency ${dep} is not a known op_id`,
        });
      } else if (dep === op.op_id) {
        errors.push({
          op_id: op.op_id,
          code: 'dependency-self',
          message: 'operation cannot depend on itself',
        });
      }
    }
  }

  // cycle detection (DFS)
  const adjacency = new Map<string, string[]>();
  for (const op of p.operations) {
    if (op && typeof op === 'object' && isNonEmptyString(op.op_id)) {
      adjacency.set(op.op_id, (op.dependencies ?? []).filter((d) => seenOpIds.has(d) && d !== op.op_id));
    }
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const reportCycle = (start: string) => {
    errors.push({
      op_id: start,
      code: 'dependency-cycle',
      message: `dependency cycle detected involving ${start}`,
    });
  };
  const dfs = (node: string, path: Set<string>): void => {
    color.set(node, GRAY);
    path.add(node);
    for (const next of adjacency.get(node) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) {
        reportCycle(next);
      } else if (c === WHITE) {
        dfs(next, path);
      }
    }
    path.delete(node);
    color.set(node, BLACK);
  };
  for (const node of adjacency.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) dfs(node, new Set());
  }

  // duplicate target_id across create ops (two sources cannot create the same row id)
  const createTargets = new Map<string, string>();
  for (const op of p.operations) {
    if (!op || typeof op !== 'object' || op.operation !== 'create' || !op.target_id) continue;
    if (createTargets.has(op.target_id)) {
      errors.push({
        op_id: op.op_id,
        code: 'duplicate-target',
        message: `target_id ${op.target_id} claimed by both ${createTargets.get(op.target_id)} and ${op.op_id}`,
      });
    } else {
      createTargets.set(op.target_id, op.op_id);
    }
  }

  const planHash = hashPlanDocument({ ...p, plan_hash: undefined, snapshot_hash: p.snapshot_hash });
  result.plan_hash = planHash;
  result.snapshot_hash = p.snapshot_hash ?? null;
  result.ok = errors.length === 0;

  await deps.writeAudit({
    actor_user_id: actorUserId,
    action: 'validate',
    import_plan_hash: planHash,
    operations_total: result.operations_total,
    operations_applied: 0,
    operations_noop: 0,
    operations_failed: 0,
    detail: { ok: result.ok, errors: errors.length, warnings: warnings.length, plan_id: p.plan_id },
  });

  return result;
}

// ---------------------------------------------------------------------------
// Execution — shared by dry-run and apply.
// ---------------------------------------------------------------------------

interface ExecutionContext {
  mode: 'dry-run' | 'apply';
  plan: ImportPlan;
  planHash: string;
  deps: ImporterDeps;
  outcomes: OpOutcome[];
  counts: { applied: number; noop: number; blocked: number; failed: number };
  appliedOps: Set<string>;
}

async function executePlan(ctx: ExecutionContext): Promise<PlanApplyResult> {
  const { deps, plan, planHash } = ctx;

  // Dependency-respecting order: Kahn's algorithm over declared dependencies;
  // stable with respect to manifest order.
  const pending = [...plan.operations];
  const appliedOrNoop = new Set<string>();
  const stoppedEarly = { value: false };

  const execOne = async (op: ImportOperation): Promise<void> => {
    // (0) unresolved dependencies
    for (const dep of op.dependencies ?? []) {
      if (!appliedOrNoop.has(dep)) {
        ctx.outcomes.push({
          status: 'blocked',
          op_id: op.op_id,
          reason: `dependency ${dep} not applied`,
        });
        ctx.counts.blocked++;
        return;
      }
    }

    // (1) existing provenance for this source => dedupe / idempotent re-run
    const existing = await deps.fetchProvenance(op.entity_type, op.source_id);
    if (existing) {
      if (existing.import_plan_hash === planHash) {
        ctx.outcomes.push({
          status: 'noop',
          op_id: op.op_id,
          reason: 'already imported by this plan (idempotent re-run)',
          target_id: existing.target_id,
        });
      } else {
        ctx.outcomes.push({
          status: 'noop',
          op_id: op.op_id,
          reason: `already imported by plan ${existing.import_plan_hash.slice(0, 12)}`,
          target_id: existing.target_id,
        });
      }
      ctx.counts.noop++;
      appliedOrNoop.add(op.op_id);
      return;
    }

    // (2) identity resolution gate — every provenance claim references an
    // author; unresolved identity blocks the operation.
    if (op.provenance && isNonEmptyString(op.provenance.source_system)) {
      // author identity rides in evidence convention: provenance.source_id is
      // the entity; the author identity map is consulted by adapters via
      // payload_ref. Here we resolve the plan's declared author when present.
      const declaredAuthor = (op as ImportOperation & { historical_author?: string }).historical_author;
      if (isNonEmptyString(declaredAuthor)) {
        const resolved = await deps.resolveIdentity(plan.source_system, declaredAuthor);
        if (!resolved) {
          ctx.outcomes.push({
            status: 'blocked',
            op_id: op.op_id,
            reason: `unresolved historical identity ${declaredAuthor}`,
          });
          ctx.counts.blocked++;
          return;
        }
      }
    }

    // (3) target resolution
    const targetId = op.target_id ?? null;

    if (op.operation === 'link') {
      if (!targetId) {
        ctx.outcomes.push({
          status: 'blocked',
          op_id: op.op_id,
          reason: 'link operation requires target_id',
        });
        ctx.counts.blocked++;
        return;
      }
      const target = await deps.fetchTarget(op.entity_type, targetId);
      if (!target) {
        ctx.outcomes.push({
          status: 'blocked',
          op_id: op.op_id,
          reason: `link target ${op.entity_type}:${targetId} not found`,
        });
        ctx.counts.blocked++;
        return;
      }
      const targetProv = await deps.fetchProvenanceByTarget(op.entity_type, targetId);
      if (targetProv) {
        ctx.outcomes.push({
          status: 'noop',
          op_id: op.op_id,
          reason: `target already claimed by ${targetProv.source_system}:${targetProv.source_id}`,
          target_id: targetId,
        });
        ctx.counts.noop++;
        appliedOrNoop.add(op.op_id);
        return;
      }
      // Fingerprint precondition — link is only allowed onto a target whose
      // content still matches the expected fingerprint (drift => blocked).
      if (op.expected_target_fingerprint) {
        const fields =
          op.entity_type === 'card'
            ? CARD_FINGERPRINT_FIELDS
            : op.entity_type === 'comment'
              ? COMMENT_FINGERPRINT_FIELDS
              : null;
        const actual = fields ? fingerprintFields(target, fields) : fingerprintJson(target);
        if (actual !== op.expected_target_fingerprint) {
          ctx.outcomes.push({
            status: 'blocked',
            op_id: op.op_id,
            reason: `target fingerprint drift: expected ${op.expected_target_fingerprint.slice(0, 12)}, found ${actual.slice(0, 12)}`,
          });
          ctx.counts.blocked++;
          return;
        }
      }
      if (ctx.mode === 'apply') {
        await deps.linkProvenance({
          entity_type: op.entity_type,
          source_id: op.source_id,
          target_id: targetId,
          plan_hash: planHash,
        });
      }
      ctx.outcomes.push({ status: 'applied', op_id: op.op_id, target_id: targetId });
      ctx.counts.applied++;
      appliedOrNoop.add(op.op_id);
      return;
    }

    // operation === 'create'
    // (3a) if a target_id is pre-declared, it must not exist (no overwrite).
    if (targetId) {
      const existingRow = await deps.fetchTarget(op.entity_type, targetId);
      if (existingRow) {
        const claim = await deps.fetchProvenanceByTarget(op.entity_type, targetId);
        if (claim) {
          ctx.outcomes.push({
            status: 'noop',
            op_id: op.op_id,
            reason: `target ${targetId} already imported as ${claim.source_system}:${claim.source_id}`,
            target_id: targetId,
          });
          ctx.counts.noop++;
          appliedOrNoop.add(op.op_id);
          return;
        }
        ctx.outcomes.push({
          status: 'blocked',
          op_id: op.op_id,
          reason: `target ${op.entity_type}:${targetId} already exists without provenance (native or drifted content) — overwrite prohibited`,
        });
        ctx.counts.blocked++;
        return;
      }
    }

    // (3b) fingerprint precondition when target is expected to pre-exist via
    // link semantics embedded in create (target_id + expected fingerprint).
    if (targetId && op.expected_target_fingerprint) {
      const row = await deps.fetchTarget(op.entity_type, targetId);
      if (row) {
        const fields =
          op.entity_type === 'card'
            ? CARD_FINGERPRINT_FIELDS
            : op.entity_type === 'comment'
              ? COMMENT_FINGERPRINT_FIELDS
              : null;
        const actual = fields ? fingerprintFields(row, fields) : fingerprintJson(row);
        if (actual !== op.expected_target_fingerprint) {
          ctx.outcomes.push({
            status: 'blocked',
            op_id: op.op_id,
            reason: `target fingerprint drift: expected ${op.expected_target_fingerprint.slice(0, 12)}, found ${actual.slice(0, 12)}`,
          });
          ctx.counts.blocked++;
          return;
        }
      }
    }

    // (4) create. Dry-run preflight resolves the staged payload, verifies its
    // configured SHA-256 manifest entry, resolves its historical author, and
    // runs the exact INSERTs in a rolled-back DB transaction. This makes a
    // green rehearsal evidence that apply reaches the same constraints.
    const newTargetId = targetId ?? `hi_${randomUUID()}`;
    const createInput = {
      entity_type: op.entity_type,
      source_id: op.source_id,
      target_id: newTargetId,
      payload_ref: op.payload_ref ?? null,
      plan_hash: planHash,
      operation: op.operation,
    };
    if (ctx.mode === 'apply') {
      const res = await deps.createWithProvenance(createInput);
      ctx.outcomes.push({ status: 'applied', op_id: op.op_id, target_id: res.target_id });
    } else {
      const preflight = await deps.preflightCreate(createInput);
      if (!preflight.ok) {
        // Let the common fail-fast handler emit the failed outcome and stop
        // scheduling, exactly as an apply-side INSERT error would.
        throw new Error(`dry-run preflight failed: ${preflight.reason}`);
      }
      ctx.outcomes.push({ status: 'applied', op_id: op.op_id, target_id: newTargetId });
    }
    ctx.counts.applied++;
    appliedOrNoop.add(op.op_id);
  };

  // Simple multi-pass scheduler honoring dependencies and manifest order.
  let progressed = true;
  let blockedRound = new Set<string>();
  while (pending.length > 0 && progressed && !stoppedEarly.value) {
    progressed = false;
    blockedRound = new Set();
    for (let i = 0; i < pending.length; ) {
      const op = pending[i] as ImportOperation;
      const depsOk = (op.dependencies ?? []).every((d) => appliedOrNoop.has(d));
      if (!depsOk) {
        blockedRound.add(op.op_id);
        i++;
        continue;
      }
      pending.splice(i, 1);
      try {
        await execOne(op);
        progressed = true;
      } catch (err: unknown) {
        ctx.outcomes.push({
          status: 'failed',
          op_id: op.op_id,
          reason: err instanceof Error ? err.message : String(err),
        });
        ctx.counts.failed++;
        progressed = true;
        stoppedEarly.value = true;
        break; // fail-fast: stop scheduling further ops this run
      }
    }
    // any op blocked because its dependency failed/blocked cannot proceed
    if (!progressed) break;
  }

  // Remaining pending ops: dependency-failed cascade
  for (const op of pending) {
    ctx.outcomes.push({
      status: 'blocked',
      op_id: op.op_id,
      reason: 'dependency failed or blocked earlier in this run',
    });
    ctx.counts.blocked++;
  }

  return {
    mode: ctx.mode,
    plan_hash: planHash,
    operations_total: plan.operations.length,
    operations_applied: ctx.counts.applied,
    operations_noop: ctx.counts.noop,
    operations_blocked: ctx.counts.blocked,
    operations_failed: ctx.counts.failed,
    outcomes: ctx.outcomes,
    stopped_early: stoppedEarly.value,
  };
}

// ---------------------------------------------------------------------------
// Public: dry-run (default) and apply (gated).
// ---------------------------------------------------------------------------

export async function dryRunPlan(
  plan: ImportPlan,
  deps: ImporterDeps,
  actorUserId: string,
): Promise<PlanApplyResult> {
  const validation = await validatePlan(plan, deps, actorUserId);
  if (!validation.ok) {
    return {
      mode: 'dry-run',
      plan_hash: validation.plan_hash,
      operations_total: validation.operations_total,
      operations_applied: 0,
      operations_noop: 0,
      operations_blocked: validation.operations_total,
      operations_failed: 0,
      outcomes: [],
      stopped_early: false,
      validation_errors: validation.errors,
    } as PlanApplyResult & { validation_errors: unknown };
  }
  const ctx: ExecutionContext = {
    mode: 'dry-run',
    plan,
    planHash: validation.plan_hash,
    deps,
    outcomes: [],
    counts: { applied: 0, noop: 0, blocked: 0, failed: 0 },
    appliedOps: new Set(),
  };
  const result = await executePlan(ctx);
  await deps.writeAudit({
    actor_user_id: actorUserId,
    action: 'dry_run',
    import_plan_hash: validation.plan_hash,
    operations_total: result.operations_total,
    operations_applied: 0,
    operations_noop: result.operations_noop,
    operations_failed: result.operations_failed,
    detail: {
      blocked: result.operations_blocked,
      noop: result.operations_noop,
      plan_id: plan.plan_id,
    },
  });
  return result;
}

export interface ApplyGates {
  applyEnabled: boolean; // env HISTORICAL_IMPORT_APPLY_ENABLED === 'true'
  confirmedPlanHash: string; // operator-confirmed hash from validation/dry-run
}

export async function applyPlan(
  plan: ImportPlan,
  gates: ApplyGates,
  deps: ImporterDeps,
  actorUserId: string,
): Promise<PlanApplyResult | { error: string; code: string }> {
  if (!gates.applyEnabled) {
    return { error: 'apply is disabled: set HISTORICAL_IMPORT_APPLY_ENABLED=true to enable', code: 'apply-disabled' };
  }
  const validation = await validatePlan(plan, deps, actorUserId);
  if (!validation.ok) {
    return { error: 'plan failed validation', code: 'plan-invalid' };
  }
  if (gates.confirmedPlanHash !== validation.plan_hash) {
    return {
      error: `confirmed_plan_hash does not match computed plan hash (${validation.plan_hash})`,
      code: 'plan-hash-mismatch',
    };
  }
  const ctx: ExecutionContext = {
    mode: 'apply',
    plan,
    planHash: validation.plan_hash,
    deps,
    outcomes: [],
    counts: { applied: 0, noop: 0, blocked: 0, failed: 0 },
    appliedOps: new Set(),
  };
  const result = await executePlan(ctx);
  await deps.writeAudit({
    actor_user_id: actorUserId,
    action: 'apply',
    import_plan_hash: validation.plan_hash,
    operations_total: result.operations_total,
    operations_applied: result.operations_applied,
    operations_noop: result.operations_noop,
    operations_failed: result.operations_failed,
    detail: {
      blocked: result.operations_blocked,
      stopped_early: result.stopped_early,
      plan_id: plan.plan_id,
    },
  });
  return result;
}

// Reset: clears provenance for a plan hash so a corrected plan can be re-run.
// Never deletes native entity rows — only provenance and audit remain,
// the entity rows created by the plan stay (documented limitation, see docs).
export async function resetPlan(
  planHash: string,
  deps: ImporterDeps,
  actorUserId: string,
): Promise<{ cleared: number }> {
  const cleared = await depsClearProvenance(deps, planHash);
  await deps.writeAudit({
    actor_user_id: actorUserId,
    action: 'reset',
    import_plan_hash: planHash,
    operations_total: 0,
    operations_applied: 0,
    operations_noop: 0,
    operations_failed: 0,
    detail: { cleared },
  });
  return { cleared };
}

// Adapter hook — adapters implement this; tests stub it.
interface ClearableDeps extends ImporterDeps {
  clearProvenanceByPlan?(planHash: string): Promise<number>;
}
function depsClearProvenance(deps: ImporterDeps, planHash: string): Promise<number> {
  const c = deps as ClearableDeps;
  if (typeof c.clearProvenanceByPlan === 'function') return c.clearProvenanceByPlan(planHash);
  return Promise.resolve(0);
}
