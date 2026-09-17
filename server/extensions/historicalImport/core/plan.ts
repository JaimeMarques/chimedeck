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
  COMMENT_CORRECTION_FIELDS,
  CARD_COVER_FIELDS,
  hashPlanDocument,
  sha256Hex,
  canonicalJson,
} from './fingerprint';
import {
  COMPOSITE_KEY_COLUMNS,
  isCompositeKeyEntity,
  tryDecodeCompositeTargetId,
} from './composite';
import { verifyExternalInputHashes } from './externalInputs';

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

export const OPERATIONS = ['create', 'link', 'correct', 'enrich'] as const;
export type Operation = (typeof OPERATIONS)[number];

export interface ImportProvenanceInfo {
  source_system: string; // 'trello'
  source_id: string;
  evidence_refs: string[]; // e.g. ['trello-export:actions/64a1...']
  exported_at?: string;
  // Board whose workspace authorizes this operation (optional for
  // board-level ops where target_id is the board itself).
  board_id?: string;
  // Workspace authorization witness for a board CREATE operation. A board that
  // does not exist yet cannot be resolved from the boards table, so the op
  // declares the workspace it will land in. The value is NEVER self-authorizing:
  // the API cross-checks it against the workspace_id of the staged board payload
  // and against the owner gate the create path enforces (the payload's
  // historical_author must be workspaces.owner_id with an OWNER membership).
  workspace_id?: string;
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
  // Required for mutating operations. The importer projects the live row onto
  // its operation-specific allowlist and requires this exact pre-image as well
  // as its fingerprint before changing anything.
  expected_target_fields?: Record<string, unknown> | null;
  payload_ref: string | null; // private payload locator — validated shape only
  dependencies: string[]; // op_ids that must be applied before this one
  historical_author?: string; // source-system user id, resolved fail-closed
}

export interface ExternalInputPreconditions {
  payload_manifest?: { canonical_sha256: string };
  identity_map?: { importer_map_sha256: string };
  attachment_object_manifest?: {
    canonical_sha256: string;
    operations?: number;
    bytes?: number;
  };
  destination_row_source?: { rows_sha256: string };
}

export interface ImportPlan {
  plan_id: string;
  plan_hash?: string; // server-computed on validation; caller passes on apply
  snapshot_hash?: string; // hash of the source snapshot the plan was built from
  source_system: string; // 'trello'
  created_at: string;
  input_preconditions?: ExternalInputPreconditions;
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
  // true when the operator pinned the expected source snapshot hash out of
  // band (HISTORICAL_IMPORT_EXPECTED_SNAPSHOT_HASH); false => only shape-validated.
  snapshot_hash_pinned: boolean;
  // True only when every external artifact hash referenced by the plan was
  // recomputed from the configured server-side input and matched before any
  // destination observation or mutation.
  external_input_hashes_verified: boolean;
  // Fingerprint of the destination state observed for every target this plan
  // touches. The operator must echo it back on apply (state-divergence stop).
  destination_fingerprint: string;
  operations_total: number;
  errors: Array<{ op_id: string; code: string; message: string }>;
  warnings: Array<{ op_id: string; code: string; message: string }>;
}

// Out-of-band expectations supplied by the operator/server configuration, not
// by the plan document itself (a plan must not be able to authorize its own
// snapshot).
export interface PlanExpectations {
  // Frozen SHA-256 of the SOURCE snapshot the plan was built from. When set,
  // the plan's declared snapshot_hash must match it exactly, else the plan is
  // invalid and apply is refused (snapshot divergence stop).
  expectedSnapshotHash?: string | null;
}

export interface DestinationObservation {
  op_id: string;
  entity_type: string;
  target_id: string | null;
  row_present: boolean;
  row_fingerprint: string | null; // sha256 of the canonical full row
  provenance_ref: string | null; // "<source_system>:<source_id>" when claimed
}

export interface DestinationState {
  fingerprint: string;
  entries: DestinationObservation[];
}

export interface PlanApplyResult {
  mode: 'dry-run' | 'apply';
  plan_hash: string;
  snapshot_hash?: string | null;
  destination_fingerprint: string;
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
  source_references?: unknown[];
}

export interface MutationInput {
  entity_type: EntityType;
  source_system: string;
  source_id: string;
  target_id: string;
  payload_ref: string;
  plan_hash: string;
  operation: 'correct' | 'enrich';
  expected_target_fields: Record<string, unknown>;
  expected_target_fingerprint: string;
  historical_author?: string;
}

export type MutationResult =
  | { status: 'applied'; target_id: string }
  | { status: 'noop'; target_id: string; reason: string }
  | { status: 'blocked'; reason: string };

export interface ImporterDeps {
  // Hash of the exact external artifact snapshot already loaded into this deps
  // instance. Production exposes the identity-map digest so validation proves
  // the bytes that execution will actually use, closing a load/verify TOCTOU.
  loadedExternalInputHash?(name: 'identity_map'): Promise<string | null>;
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
    board_id?: string;
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
    board_id?: string;
  }): Promise<{ ok: true; created?: boolean; target_id?: string } | { ok: false; reason: string }>;
  // Existing-row mutations share one adapter body in apply and dry-run. The
  // adapter owns the row lock, exact pre-image check, constrained update, and
  // provenance write/verification so they are one atomic decision.
  mutateWithProvenance(input: MutationInput): Promise<MutationResult>;
  preflightMutation(input: MutationInput): Promise<MutationResult>;
  // Authorization witness for a board CREATE: the workspace the staged board
  // payload will land in, proven against the same invariants the create path
  // enforces — payload identity, an existing workspace, and a historical author
  // that is the workspace OWNER with an OWNER membership. The plan's own claim
  // (`provenance.workspace_id`) is never trusted: this is the out-of-band proof
  // the API cross-checks it against.
  resolveBoardCreateWorkspace(input: {
    source_id: string;
    payload_ref: string | null;
  }): Promise<{ workspace_id: string } | { error: string }>;
  // Dry-run rehearsal scope. Every operation of one rehearsal runs in a single
  // scope so a write is visible to the operations that depend on it: an
  // attachment-backed cover (card create -> attachment create -> card enrich)
  // can only be rehearsed against its own pending writes, exactly as apply does
  // — but nothing may survive endDryRunScope(). Implementations that omit the
  // scope fall back to per-operation rehearsals.
  beginDryRunScope?(): Promise<void>;
  endDryRunScope?(): Promise<void>;
  // Link an existing target row to a source identity (provenance insert only).
  // Apply commits the claim; dry-run executes the identical insert inside the
  // rehearsal scope so dependent operations can observe it, then the outer
  // scope rolls everything back.
  linkProvenance(input: {
    entity_type: EntityType;
    source_id: string;
    target_id: string;
    plan_hash: string;
  }): Promise<void>;
  preflightLink(input: {
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
// Destination state observation — the external drift stop.
// ---------------------------------------------------------------------------

// Observe, per operation, the destination row/claim this plan is about to act
// on, and fold it into a single fingerprint. Computed BEFORE any write.
//
// [why] Fingerprint preconditions only protect individual `link` operations.
// Apply had no witness of the destination state as a whole, so a plan could be
// confirmed against one state and executed against another. The operator now
// echoes this fingerprint back on apply; any change to a touched row, to its
// claim, or to the presence of a target row makes apply refuse instead of
// silently acting on drifted state.
export async function observeDestination(
  plan: ImportPlan,
  deps: ImporterDeps
): Promise<DestinationState> {
  const entries: DestinationObservation[] = [];
  for (const op of plan?.operations ?? []) {
    const targetId =
      typeof op?.target_id === 'string' && op.target_id.length > 0 ? op.target_id : null;
    let row: Record<string, unknown> | null = null;
    let provenance: ProvenanceRow | null = null;
    if (targetId) {
      row = await deps.fetchTarget(op.entity_type, targetId);
      provenance = await deps.fetchProvenanceByTarget(op.entity_type, targetId);
    }
    entries.push({
      op_id: op.op_id,
      entity_type: op.entity_type,
      target_id: targetId,
      row_present: row !== null,
      row_fingerprint: row ? fingerprintJson(row) : null,
      provenance_ref: provenance ? `${provenance.source_system}:${provenance.source_id}` : null,
    });
  }
  return { fingerprint: sha256Hex(canonicalJson(entries)), entries };
}

async function observeDestinationSafe(
  plan: ImportPlan,
  deps: ImporterDeps,
  errors: PlanValidationResult['errors']
): Promise<string> {
  try {
    const observed = await observeDestination(plan, deps);
    return observed.fingerprint;
  } catch (err: unknown) {
    // Fail-closed: without an observation we cannot certify the destination
    // state, so the plan must not be applicable.
    errors.push({
      op_id: 'plan',
      code: 'destination-observation-failed',
      message: `could not observe the destination state: ${err instanceof Error ? err.message : String(err)}`,
    });
    return '';
  }
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

function claimIsOwn(
  op: ImportOperation,
  claim: Pick<ProvenanceRow, 'source_system' | 'source_id'>,
  sourceSystem: string
): boolean {
  return claim.source_system === sourceSystem && claim.source_id === op.source_id;
}

function mutationFields(operation: Operation): readonly string[] | null {
  if (operation === 'correct') return COMMENT_CORRECTION_FIELDS;
  if (operation === 'enrich') return CARD_COVER_FIELDS;
  return null;
}

function hasExactFields(
  value: unknown,
  fields: readonly string[]
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...fields].sort();
  return (
    actual.length === expected.length && actual.every((field, index) => field === expected[index])
  );
}

// The single duplicate source identity a plan may contain: a card `create|link`
// followed by that same card's cover `enrich`, where the enrich depends directly
// on both the materialisation and the import-owned cover attachment (an
// attachment create|link planned against that same card).
//
// Returns null when the chain is valid, else the violation to report against the
// duplicate operation. Anything that is not this shape is the generic
// `duplicate-source` refusal.
function coverChainViolation(
  materialisation: ImportOperation,
  enrich: ImportOperation,
  opsById: Map<string, ImportOperation>
): { code: string; message: string } | null {
  const key = `${materialisation.entity_type}:${materialisation.source_id}`;
  const duplicateSource = {
    code: 'duplicate-source',
    message: `duplicate source entity ${key} within plan`,
  };
  const chainShape =
    materialisation.entity_type === 'card' &&
    enrich.entity_type === 'card' &&
    isNonEmptyString(materialisation.target_id) &&
    materialisation.target_id === enrich.target_id &&
    (materialisation.operation === 'create' || materialisation.operation === 'link') &&
    enrich.operation === 'enrich';
  if (!chainShape) return duplicateSource;

  const dependencies = Array.isArray(enrich.dependencies) ? enrich.dependencies : [];
  if (!dependencies.includes(materialisation.op_id)) {
    return {
      code: 'enrich-chain-dependency-missing',
      message: `enrich on card:${materialisation.target_id} must depend directly on its card ${materialisation.operation} (${materialisation.op_id})`,
    };
  }
  const coverAttachment = dependencies.some((dependency) => {
    const candidate = opsById.get(dependency);
    return (
      candidate !== undefined &&
      candidate.entity_type === 'attachment' &&
      (candidate.operation === 'create' || candidate.operation === 'link') &&
      isNonEmptyString(candidate.target_id) &&
      (candidate.dependencies ?? []).includes(materialisation.op_id)
    );
  });
  if (!coverAttachment) {
    return {
      code: 'enrich-chain-attachment-missing',
      message: `enrich on card:${materialisation.target_id} must depend directly on the import-owned cover attachment planned against that card (an attachment create|link depending on ${materialisation.op_id})`,
    };
  }
  return null;
}

export async function validatePlan(
  plan: unknown,
  deps: ImporterDeps,
  actorUserId: string,
  expectations?: PlanExpectations
): Promise<PlanValidationResult> {
  const errors: PlanValidationResult['errors'] = [];
  const warnings: PlanValidationResult['warnings'] = [];
  const result: PlanValidationResult = {
    ok: false,
    plan_hash: '',
    snapshot_hash: null,
    snapshot_hash_pinned: false,
    external_input_hashes_verified: false,
    destination_fingerprint: '',
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
    errors.push({
      op_id: 'plan',
      code: 'source-system-required',
      message: 'source_system is required',
    });
  }
  if (typeof p.created_at !== 'string' || Number.isNaN(Date.parse(p.created_at))) {
    errors.push({
      op_id: 'plan',
      code: 'created-at-invalid',
      message: 'created_at must be an ISO timestamp',
    });
  }
  if (p.snapshot_hash !== undefined && p.snapshot_hash !== null && !isValidHash(p.snapshot_hash)) {
    errors.push({
      op_id: 'plan',
      code: 'snapshot-hash-invalid',
      message: 'snapshot_hash must be a 64-hex sha256 (algorithm sha256-plan-v1)',
    });
  }
  // Snapshot divergence stop. The plan cannot authorize its own snapshot: the
  // expected value must come out of band (frozen artifact / server config).
  // [why] Shape-only validation let a tampered snapshot_hash pass validate.
  const pinnedSnapshot = isNonEmptyString(expectations?.expectedSnapshotHash ?? null)
    ? (expectations?.expectedSnapshotHash as string)
    : null;
  result.snapshot_hash_pinned = pinnedSnapshot !== null;
  if (pinnedSnapshot !== null) {
    if (pinnedSnapshot !== (p.snapshot_hash ?? null)) {
      errors.push({
        op_id: 'plan',
        code: 'snapshot-divergence',
        message:
          p.snapshot_hash === undefined || p.snapshot_hash === null
            ? 'plan.snapshot_hash is required when snapshot pinning is enabled'
            : `plan.snapshot_hash (${p.snapshot_hash.slice(0, 12)}…) diverges from the frozen snapshot hash (${pinnedSnapshot.slice(0, 12)}…)`,
      });
    }
  } else {
    warnings.push({
      op_id: 'plan',
      code: 'snapshot-hash-unpinned',
      message:
        'no expected snapshot hash configured (HISTORICAL_IMPORT_EXPECTED_SNAPSHOT_HASH): snapshot_hash is only shape-validated, not enforced against the frozen source snapshot',
    });
  }
  if (!Array.isArray(p.operations)) {
    errors.push({
      op_id: 'plan',
      code: 'operations-required',
      message: 'operations must be an array',
    });
    return result;
  }

  result.operations_total = p.operations.length;
  if (p.operations.length === 0) {
    warnings.push({ op_id: 'plan', code: 'plan-empty', message: 'plan has no operations' });
  }

  // External inputs referenced by the plan are not assertions the plan may
  // satisfy by declaration alone. Recompute each digest from the configured
  // private server-side artifact. dry-run/apply call validatePlan first, so a
  // missing/swapped/unreadable artifact stops the whole run before any write.
  const externalInputs = await verifyExternalInputHashes(
    p,
    deps.loadedExternalInputHash?.bind(deps)
  );
  result.external_input_hashes_verified = externalInputs.verified;
  errors.push(...externalInputs.errors);

  const seenOpIds = new Set<string>();
  const sourceKeyGroups = new Map<string, ImportOperation[]>();

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
      errors.push({
        op_id: op.op_id,
        code: 'op-id-duplicate',
        message: `duplicate op_id ${op.op_id}`,
      });
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
      errors.push({
        op_id: opId,
        code: 'evidence-refs-invalid',
        message: 'evidence_refs entries must be non-empty strings',
      });
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

    const mutationFieldSet = mutationFields(op.operation);
    if (mutationFieldSet) {
      const requiredEntity = op.operation === 'correct' ? 'comment' : 'card';
      if (op.entity_type !== requiredEntity) {
        errors.push({
          op_id: opId,
          code: 'mutation-entity-invalid',
          message: `${op.operation} is supported only for ${requiredEntity}`,
        });
      }
      if (!isNonEmptyString(op.target_id)) {
        errors.push({
          op_id: opId,
          code: 'mutation-target-required',
          message: `${op.operation} requires target_id`,
        });
      }
      if (!isNonEmptyString(op.payload_ref)) {
        errors.push({
          op_id: opId,
          code: 'mutation-payload-required',
          message: `${op.operation} requires payload_ref`,
        });
      }
      if (!isValidHash(op.expected_target_fingerprint)) {
        errors.push({
          op_id: opId,
          code: 'mutation-fingerprint-required',
          message: `${op.operation} requires expected_target_fingerprint`,
        });
      }
      if (!hasExactFields(op.expected_target_fields, mutationFieldSet)) {
        errors.push({
          op_id: opId,
          code: 'mutation-expected-fields-invalid',
          message: `${op.operation} expected_target_fields must contain exactly ${mutationFieldSet.join(',')}`,
        });
      } else if (
        isValidHash(op.expected_target_fingerprint) &&
        fingerprintFields(op.expected_target_fields, mutationFieldSet) !==
          op.expected_target_fingerprint
      ) {
        errors.push({
          op_id: opId,
          code: 'mutation-fingerprint-mismatch',
          message: `${op.operation} expected_target_fingerprint does not match expected_target_fields`,
        });
      }
      if (op.operation === 'correct' && !isNonEmptyString(op.historical_author)) {
        errors.push({
          op_id: opId,
          code: 'historical-author-required',
          message: 'correct requires historical_author',
        });
      }
    }

    // A board the plan creates does not exist yet, so its workspace cannot be
    // resolved from the boards table. The op must declare the workspace witness
    // the API cross-checks against the staged board payload + owner gate.
    if (op.entity_type === 'board' && op.operation === 'create') {
      const witness = (prov as { workspace_id?: unknown } | undefined)?.workspace_id;
      if (!isNonEmptyString(witness)) {
        errors.push({
          op_id: opId,
          code: 'board-create-witness-required',
          message:
            'board create requires provenance.workspace_id (workspace authorization witness for a board that does not exist yet)',
        });
      }
    }

    // `enrich` only ever fills an exactly empty native cover. A non-empty
    // pre-image can never be applied, so it is refused at validation instead of
    // failing mid-apply.
    if (op.operation === 'enrich' && hasExactFields(op.expected_target_fields, CARD_COVER_FIELDS)) {
      const preimage = op.expected_target_fields;
      if (
        preimage.cover_attachment_id !== null ||
        preimage.cover_color !== null ||
        preimage.cover_size !== 'SMALL'
      ) {
        errors.push({
          op_id: opId,
          code: 'enrich-preimage-not-empty',
          message:
            'enrich requires the exact empty native cover pre-image {cover_attachment_id:null,cover_color:null,cover_size:"SMALL"}',
        });
      }
    }

    if (
      op.payload_ref !== null &&
      op.payload_ref !== undefined &&
      !isNonEmptyString(op.payload_ref)
    ) {
      errors.push({
        op_id: opId,
        code: 'payload-ref-invalid',
        message: 'payload_ref must be a non-empty string or null',
      });
    }

    // Composite-key (join-table) entities: the row identity IS the composite
    // key, and the destination table has no surrogate id column, so target_id
    // is mandatory and must decode into the declared key columns. The engine
    // never synthesises an id for these rows.
    if (isCompositeKeyEntity(op.entity_type)) {
      const columns = COMPOSITE_KEY_COLUMNS[op.entity_type] as readonly string[];
      if (!isNonEmptyString(op.target_id)) {
        errors.push({
          op_id: opId,
          code: 'composite-target-required',
          message: `${op.entity_type} requires target_id "${columns.join(':')}" (composite-key table without an id column)`,
        });
      } else {
        const decoded = tryDecodeCompositeTargetId(op.entity_type, op.target_id);
        if (decoded && 'error' in decoded) {
          errors.push({ op_id: opId, code: decoded.error.code, message: decoded.error.message });
        }
      }
    }

    if (!Array.isArray(op.dependencies)) {
      errors.push({
        op_id: opId,
        code: 'dependencies-invalid',
        message: 'dependencies must be an array of op_ids',
      });
    }

    // duplicate source identity within one plan — collected here, decided after
    // all operations are known (the constrained cover chain needs the whole plan)
    if (isNonEmptyString(op.source_id) && typeof op.entity_type === 'string') {
      const key = `${op.entity_type}:${op.source_id}`;
      const group = sourceKeyGroups.get(key);
      if (group) group.push(op);
      else sourceKeyGroups.set(key, [op]);
    }
  }

  // One source identity may appear twice in a plan ONLY as the constrained cover
  // chain: a card `create|link` materialisation and that same card's `enrich`.
  // [why] An attachment-backed cover needs card create -> attachment create ->
  // card enrich, and a second source id would conflict with the single unique
  // provenance claim for the target. Every other duplicate source/target case is
  // still rejected.
  const opsById = new Map<string, ImportOperation>();
  for (const op of p.operations) {
    if (op && typeof op === 'object' && isNonEmptyString(op.op_id) && !opsById.has(op.op_id)) {
      opsById.set(op.op_id, op);
    }
  }
  for (const [key, group] of sourceKeyGroups) {
    if (group.length < 2) continue;
    const materialisation = group[0] as ImportOperation;
    for (let i = 1; i < group.length; i++) {
      const duplicate = group[i] as ImportOperation;
      const violation =
        group.length === 2
          ? coverChainViolation(materialisation, duplicate, opsById)
          : { code: 'duplicate-source', message: `duplicate source entity ${key} within plan` };
      if (violation) {
        errors.push({ op_id: duplicate.op_id, code: violation.code, message: violation.message });
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
      adjacency.set(
        op.op_id,
        (op.dependencies ?? []).filter((d) => seenOpIds.has(d) && d !== op.op_id)
      );
    }
  }
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
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
  // Observe the destination only for a contract-valid plan: an invalid plan is
  // never applicable, and a malformed composite key would otherwise surface as
  // a second, confusing error.
  result.destination_fingerprint =
    errors.length === 0 ? await observeDestinationSafe(p, deps, errors) : '';
  result.ok = errors.length === 0;

  await deps.writeAudit({
    actor_user_id: actorUserId,
    action: 'validate',
    import_plan_hash: planHash,
    operations_total: result.operations_total,
    operations_applied: 0,
    operations_noop: 0,
    operations_failed: 0,
    detail: {
      ok: result.ok,
      errors: errors.length,
      warnings: warnings.length,
      plan_id: p.plan_id,
      snapshot_hash_pinned: result.snapshot_hash_pinned,
      external_input_hashes_verified: result.external_input_hashes_verified,
      destination_fingerprint: result.destination_fingerprint,
    },
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
  snapshotHash: string | null;
  destinationFingerprint: string;
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

  const reportCreateWithoutWrite = (
    op: ImportOperation,
    claimedTargetId: string,
    plannedTargetId: string
  ): void => {
    if (claimedTargetId !== plannedTargetId) {
      ctx.outcomes.push({
        status: 'blocked',
        op_id: op.op_id,
        reason: `provenance conflict: source ${op.entity_type}:${op.source_id} is already claimed by target ${claimedTargetId} — plan declares ${plannedTargetId}`,
      });
      ctx.counts.blocked++;
      return;
    }
    ctx.outcomes.push({
      status: 'noop',
      op_id: op.op_id,
      reason: 'already imported by this source (nothing written — idempotent)',
      target_id: claimedTargetId,
    });
    ctx.counts.noop++;
    appliedOrNoop.add(op.op_id);
  };

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

    // Existing-row mutations are delegated as one adapter transaction. This
    // branch must precede generic provenance dedupe: a rerun may already have
    // the source claim and still needs a post-image no-op check.
    if (op.operation === 'correct' || op.operation === 'enrich') {
      const mutationInput: MutationInput = {
        entity_type: op.entity_type,
        source_system: plan.source_system,
        source_id: op.source_id,
        target_id: op.target_id as string,
        payload_ref: op.payload_ref as string,
        plan_hash: planHash,
        operation: op.operation,
        expected_target_fields: op.expected_target_fields as Record<string, unknown>,
        expected_target_fingerprint: op.expected_target_fingerprint as string,
        ...(op.historical_author ? { historical_author: op.historical_author } : {}),
      };
      const result =
        ctx.mode === 'apply'
          ? await deps.mutateWithProvenance(mutationInput)
          : await deps.preflightMutation(mutationInput);
      if (result.status === 'blocked') {
        ctx.outcomes.push({ status: 'blocked', op_id: op.op_id, reason: result.reason });
        ctx.counts.blocked++;
        return;
      }
      if (result.status === 'noop') {
        ctx.outcomes.push({
          status: 'noop',
          op_id: op.op_id,
          reason: result.reason,
          target_id: result.target_id,
        });
        ctx.counts.noop++;
      } else {
        ctx.outcomes.push({ status: 'applied', op_id: op.op_id, target_id: result.target_id });
        ctx.counts.applied++;
      }
      appliedOrNoop.add(op.op_id);
      return;
    }

    // (1) existing provenance for this source => dedupe / idempotent re-run
    // Activity creates always re-enter the verified payload adapter on rerun so
    // immutable detached source references can be compared with stored
    // provenance. Other create/link operations retain the fast provenance path.
    const verifyActivitySourceReferences =
      op.operation === 'create' && op.entity_type === 'activity';
    const existing = await deps.fetchProvenance(op.entity_type, op.source_id);
    if (existing && !verifyActivitySourceReferences) {
      if (!claimIsOwn(op, existing, plan.source_system)) {
        ctx.outcomes.push({
          status: 'blocked',
          op_id: op.op_id,
          reason: `provenance conflict: source ${op.entity_type}:${op.source_id} is already claimed under ${existing.source_system}`,
        });
        ctx.counts.blocked++;
        return;
      }
      const pinnedTarget = typeof op.target_id === 'string' && op.target_id.length > 0;
      if (pinnedTarget && existing.target_id !== op.target_id) {
        ctx.outcomes.push({
          status: 'blocked',
          op_id: op.op_id,
          reason: `provenance conflict: source ${op.entity_type}:${op.source_id} is already claimed by target ${existing.target_id} — plan declares ${op.target_id}`,
        });
        ctx.counts.blocked++;
        return;
      }
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
      const declaredAuthor = (op as ImportOperation & { historical_author?: string })
        .historical_author;
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
        if (claimIsOwn(op, targetProv, plan.source_system)) {
          ctx.outcomes.push({
            status: 'noop',
            op_id: op.op_id,
            reason: `target already claimed by this source (${targetProv.source_system}:${targetProv.source_id})`,
            target_id: targetId,
          });
          ctx.counts.noop++;
          appliedOrNoop.add(op.op_id);
          return;
        }
        ctx.outcomes.push({
          status: 'blocked',
          op_id: op.op_id,
          reason: `provenance conflict: target ${op.entity_type}:${targetId} is already claimed by ${targetProv.source_system}:${targetProv.source_id} — one target cannot be claimed by two sources`,
        });
        ctx.counts.blocked++;
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
      const linkInput = {
        entity_type: op.entity_type,
        source_id: op.source_id,
        target_id: targetId,
        plan_hash: planHash,
      };
      if (ctx.mode === 'apply') await deps.linkProvenance(linkInput);
      else await deps.preflightLink(linkInput);
      ctx.outcomes.push({ status: 'applied', op_id: op.op_id, target_id: targetId });
      ctx.counts.applied++;
      appliedOrNoop.add(op.op_id);
      return;
    }

    // operation === 'create'
    // (3a) composite-key rows have no id column and no synthesised id: the
    // composite key is the identity, so it must have been resolved by the
    // plan (validation enforces this; this is defence in depth).
    if (!targetId && isCompositeKeyEntity(op.entity_type)) {
      ctx.outcomes.push({
        status: 'blocked',
        op_id: op.op_id,
        reason: `${op.entity_type} requires a composite target_id "<card_id>:<${(COMPOSITE_KEY_COLUMNS[op.entity_type] as readonly string[])[1] as string}>" (table has no id column)`,
      });
      ctx.counts.blocked++;
      return;
    }

    // (3a) if a target_id is pre-declared, it must not exist (no overwrite).
    if (targetId) {
      const existingRow = await deps.fetchTarget(op.entity_type, targetId);
      if (existingRow) {
        const claim = await deps.fetchProvenanceByTarget(op.entity_type, targetId);
        if (claim) {
          if (!claimIsOwn(op, claim, plan.source_system)) {
            ctx.outcomes.push({
              status: 'blocked',
              op_id: op.op_id,
              reason: `provenance conflict: target ${op.entity_type}:${targetId} is already claimed by ${claim.source_system}:${claim.source_id} — one target cannot be claimed by two sources`,
            });
            ctx.counts.blocked++;
            return;
          }
          if (!verifyActivitySourceReferences) {
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
        } else {
          ctx.outcomes.push({
            status: 'blocked',
            op_id: op.op_id,
            reason: `target ${op.entity_type}:${targetId} already exists without provenance (native or drifted content) — overwrite prohibited`,
          });
          ctx.counts.blocked++;
          return;
        }
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
      ...(op.provenance.board_id ? { board_id: op.provenance.board_id } : {}),
    };
    if (ctx.mode === 'apply') {
      const res = await deps.createWithProvenance(createInput);
      if (!res.created) {
        reportCreateWithoutWrite(op, res.target_id, newTargetId);
        return;
      }
      ctx.outcomes.push({ status: 'applied', op_id: op.op_id, target_id: res.target_id });
    } else {
      const preflight = await deps.preflightCreate(createInput);
      if (!preflight.ok) {
        // Let the common fail-fast handler emit the failed outcome and stop
        // scheduling, exactly as an apply-side INSERT error would.
        throw new Error(`dry-run preflight failed: ${preflight.reason}`);
      }
      if (preflight.created === false) {
        reportCreateWithoutWrite(op, preflight.target_id ?? newTargetId, newTargetId);
        return;
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
    snapshot_hash: ctx.snapshotHash,
    destination_fingerprint: ctx.destinationFingerprint,
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
  expectations?: PlanExpectations
): Promise<PlanApplyResult> {
  const validation = await validatePlan(plan, deps, actorUserId, expectations);
  if (!validation.ok) {
    return {
      mode: 'dry-run',
      plan_hash: validation.plan_hash,
      snapshot_hash: validation.snapshot_hash,
      destination_fingerprint: validation.destination_fingerprint,
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
    snapshotHash: validation.snapshot_hash,
    destinationFingerprint: validation.destination_fingerprint,
    deps,
    outcomes: [],
    counts: { applied: 0, noop: 0, blocked: 0, failed: 0 },
    appliedOps: new Set(),
  };
  // Rehearsal scope: every operation of the rehearsal runs inside one scope so
  // writes are visible to the operations that depend on them (a created card's
  // cover attachment and cover enrich can only be rehearsed against the plan's
  // own pending writes), while nothing durable survives the scope.
  await deps.beginDryRunScope?.();
  let result: PlanApplyResult;
  try {
    result = await executePlan(ctx);
  } finally {
    try {
      await deps.endDryRunScope?.();
    } catch (err: unknown) {
      console.error('[historicalImport] dry-run rehearsal scope cleanup failed:', err);
    }
  }
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
  // Destination-state witness: the fingerprint returned by validate/dry-run,
  // echoed back by the operator. Required (fail-closed) — a stale value means
  // the destination changed between confirmation and apply.
  confirmedDestinationFingerprint?: string | null;
  // Out-of-band expectations (frozen snapshot hash). Not plan-supplied.
  expectations?: PlanExpectations;
}

export async function applyPlan(
  plan: ImportPlan,
  gates: ApplyGates,
  deps: ImporterDeps,
  actorUserId: string
): Promise<PlanApplyResult | { error: string; code: string }> {
  if (!gates.applyEnabled) {
    return {
      error: 'apply is disabled: set HISTORICAL_IMPORT_APPLY_ENABLED=true to enable',
      code: 'apply-disabled',
    };
  }
  const validation = await validatePlan(plan, deps, actorUserId, gates.expectations);
  if (!validation.ok) {
    const snapshotError = validation.errors.find(
      (e) => e.code === 'snapshot-divergence' || e.code === 'snapshot-hash-invalid'
    );
    if (snapshotError) {
      return { error: snapshotError.message, code: 'snapshot-divergence' };
    }
    const externalInputError = validation.errors.find((e) => e.code.startsWith('external-input-'));
    if (externalInputError) {
      return { error: externalInputError.message, code: 'external-input-divergence' };
    }
    return { error: 'plan failed validation', code: 'plan-invalid' };
  }
  if (gates.confirmedPlanHash !== validation.plan_hash) {
    return {
      error: `confirmed_plan_hash does not match computed plan hash (${validation.plan_hash})`,
      code: 'plan-hash-mismatch',
    };
  }
  // Destination-state stop: apply only onto the exact state the operator
  // confirmed. Missing confirmation is refused, not defaulted.
  const confirmedDestination = gates.confirmedDestinationFingerprint ?? null;
  if (!confirmedDestination || !/^[0-9a-f]{64}$/.test(confirmedDestination)) {
    return {
      error:
        'confirmed_destination_fingerprint is required: re-run validate/dry-run and echo the returned destination_fingerprint',
      code: 'destination-state-unconfirmed',
    };
  }
  if (confirmedDestination !== validation.destination_fingerprint) {
    return {
      error: `destination state diverged: confirmed ${confirmedDestination.slice(0, 12)}… but observed ${validation.destination_fingerprint.slice(0, 12)}… — re-run validate/dry-run`,
      code: 'destination-state-divergence',
    };
  }
  const ctx: ExecutionContext = {
    mode: 'apply',
    plan,
    planHash: validation.plan_hash,
    snapshotHash: validation.snapshot_hash,
    destinationFingerprint: validation.destination_fingerprint,
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
      destination_fingerprint: result.destination_fingerprint,
      snapshot_hash: result.snapshot_hash,
    },
  });
  return result;
}

// ---------------------------------------------------------------------------
// Reset and recovery
// ---------------------------------------------------------------------------

export interface CreatedTargetRef {
  entity_type: string;
  target_id: string;
}

export interface ResetResult {
  cleared: number;
  // Rows created by this plan that still exist after a provenance-only reset.
  // They are the reason a plain reset cannot be re-applied: the engine refuses
  // to overwrite rows with no provenance. Reported so the operator is never
  // surprised by "already exists without provenance".
  created_targets_remaining: CreatedTargetRef[];
  recovery: 'provenance-only';
  recovery_note: string;
}

export interface RecoveryOptions {
  confirmDestructive: boolean; // caller must explicitly acknowledge deletions
  recoveryEnabled: boolean; // server gate HISTORICAL_IMPORT_RESET_RECOVERY_ENABLED
}

export interface RecoveryReport {
  ok: boolean;
  mode: 'recovery';
  deleted: number;
  provenance_cleared: number;
  already_absent: number;
  // Where the delete candidates came from: live provenance, or the audit trail
  // when a provenance-only reset already ran for this plan hash.
  candidates_from?: 'provenance' | 'audit';
  blockers: Array<{ code: string; detail: string }>;
}

// Reset: clears provenance for a plan hash so a corrected plan can be re-run.
// Never deletes native entity rows — only provenance; the entity rows created
// by the plan stay. Use recoverPlan() for the destructive variant.
export async function resetPlan(
  planHash: string,
  deps: ImporterDeps,
  actorUserId: string
): Promise<ResetResult> {
  const created = await listCreatedTargets(deps, planHash);
  const cleared = await depsClearProvenance(deps, planHash);
  await deps.writeAudit({
    actor_user_id: actorUserId,
    action: 'reset',
    import_plan_hash: planHash,
    operations_total: 0,
    operations_applied: 0,
    operations_noop: 0,
    operations_failed: 0,
    detail: {
      cleared,
      mode: 'provenance-only',
      created_targets_remaining: created.length,
      // The authoritative record of what this plan created. Kept in the
      // append-only audit log so an operator who resets first (before
      // recovering) can still recover afterwards: the adapter reconstructs its
      // delete candidates from here when provenance is already gone.
      created_targets: created,
    },
  });
  return {
    cleared,
    created_targets_remaining: created,
    recovery: 'provenance-only',
    recovery_note:
      'provenance-only reset: entity rows created by this plan remain and will block a re-apply ("already exists without provenance"). Recover by restoring the pre-apply backup, or use reset with recovery=true + confirm_destructive=true when the plan rows are leaf-owned (see docs/historical-import.md).',
  };
}

// Destructive recovery: delete the rows this plan CREATED, then clear its
// provenance, so the same (corrected) plan can be re-executed without a
// restore. Every safety check lives in the adapter, which refuses (and rolls
// back) whenever a row outside the plan's own creation set would be affected.
export async function recoverPlan(
  planHash: string,
  deps: ImporterDeps,
  actorUserId: string,
  options: RecoveryOptions
): Promise<RecoveryReport | { error: string; code: string }> {
  if (!options.recoveryEnabled) {
    return {
      error:
        'destructive recovery is disabled: set HISTORICAL_IMPORT_RESET_RECOVERY_ENABLED=true (restore-based recovery does not need it)',
      code: 'recovery-disabled',
    };
  }
  if (!options.confirmDestructive) {
    return {
      error:
        'recovery deletes entity rows created by this plan: pass confirm_destructive=true to acknowledge',
      code: 'destructive-confirmation-required',
    };
  }
  const recover = (deps as RecoverableDeps).recoverByPlan;
  if (typeof recover !== 'function') {
    return { error: 'adapter does not support destructive recovery', code: 'recovery-unsupported' };
  }
  // Keep the receiver: the hook may be implemented as a class method (tests do)
  // that relies on `this`; the knex adapter's is a module-level function.
  // eslint-disable-next-line @typescript-eslint/unbound-method -- see above
  const report = await recover.call(deps, planHash);
  await deps.writeAudit({
    actor_user_id: actorUserId,
    action: 'reset',
    import_plan_hash: planHash,
    operations_total: 0,
    operations_applied: 0,
    operations_noop: 0,
    operations_failed: 0,
    detail: {
      mode: 'recovery',
      ok: report.ok,
      deleted: report.deleted,
      provenance_cleared: report.provenance_cleared,
      already_absent: report.already_absent,
      blockers: report.blockers.map((b) => b.code),
    },
  });
  return report;
}

// Adapter hooks — production implements them (./adapters.ts); tests stub them.
interface ClearableDeps extends ImporterDeps {
  clearProvenanceByPlan?(planHash: string): Promise<number>;
  listProvenanceByPlan?(planHash: string): Promise<ProvenanceRow[]>;
  recoverByPlan?(planHash: string): Promise<RecoveryReport>;
}
type RecoverableDeps = ClearableDeps;

function depsClearProvenance(deps: ImporterDeps, planHash: string): Promise<number> {
  const c = deps as ClearableDeps;
  if (typeof c.clearProvenanceByPlan === 'function') return c.clearProvenanceByPlan(planHash);
  return Promise.resolve(0);
}

async function listCreatedTargets(
  deps: ImporterDeps,
  planHash: string
): Promise<CreatedTargetRef[]> {
  const c = deps as ClearableDeps;
  if (typeof c.listProvenanceByPlan !== 'function') return [];
  const rows = await c.listProvenanceByPlan(planHash);
  return rows
    .filter((row) => row.operation === 'create')
    .map((row) => ({ entity_type: row.entity_type, target_id: row.target_id }));
}
