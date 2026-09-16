// tests/integration/historicalImport/harness.ts
// In-memory ImporterDeps for exercising the plan engine without a DB.
import type {
  EntityType,
  ImporterDeps,
  Operation,
  ProvenanceRow,
  RecoveryReport,
  MutationInput,
  MutationResult,
} from '../../../server/extensions/historicalImport/core/plan';
import { randomUUID } from 'node:crypto';
import {
  compositeKeyColumns,
  decodeCompositeTargetId,
  targetRef,
} from '../../../server/extensions/historicalImport/core/composite';
import { SYNTH_PAYLOADS } from './fixtures';
import {
  CARD_COVER_FIELDS,
  COMMENT_CORRECTION_FIELDS,
  fingerprintFields,
} from '../../../server/extensions/historicalImport/core/fingerprint';

export interface StagedPayload {
  entity_type: EntityType;
  source_id: string;
  historical_author?: string;
  created_at?: string;
  updated_at?: string;
  fields: Record<string, unknown>;
}

export interface AuditEntry {
  actor_user_id: string;
  action: string;
  import_plan_hash: string;
  operations_total: number;
  operations_applied: number;
  operations_noop: number;
  operations_failed: number;
  detail: Record<string, unknown>;
}

export class MemoryImporterDeps implements ImporterDeps {
  rows = new Map<string, Record<string, unknown>>(); // `${entity_type}:${id}`
  provenance: ProvenanceRow[] = [];
  audit: AuditEntry[] = [];
  identityMap: Map<string, string>;
  payloadStore: Map<string, StagedPayload>;
  // failure injection
  failCreateFor = new Set<string>(); // source keys that throw on create
  dispatchedDomainEvents: string[] = []; // must stay empty (suppression proof)
  concurrencyOverwrite: 'none' | 'provenance-race' = 'none';

  // Authorization witness fixture for board creates: board source_id => the
  // workspace proven from the staged board payload + destination owner gate.
  // An absent entry means the witness cannot be proven (fail-closed) — the same
  // outcome as an unreadable, unverified or owner-incoherent staged payload.
  boardCreateWorkspaces = new Map<string, string>();

  // Dry-run rehearsal scope (mirrors the knex adapter's single rehearsal
  // transaction): writes performed inside the scope are visible to later
  // operations and are discarded when the scope ends.
  private scopeSnapshot: { rows: Map<string, Record<string, unknown>>; provenance: ProvenanceRow[] } | null =
    null;

  get inDryRunScope(): boolean {
    return this.scopeSnapshot !== null;
  }

  async beginDryRunScope(): Promise<void> {
    if (this.scopeSnapshot) throw new Error('nested dry-run scope');
    this.scopeSnapshot = { rows: new Map(this.rows), provenance: [...this.provenance] };
  }

  async endDryRunScope(): Promise<void> {
    const snapshot = this.scopeSnapshot;
    this.scopeSnapshot = null;
    if (!snapshot) return;
    this.rows = snapshot.rows;
    this.provenance = snapshot.provenance;
  }

  async resolveBoardCreateWorkspace(input: {
    source_id: string;
    payload_ref: string | null;
  }): Promise<{ workspace_id: string } | { error: string }> {
    if (!input.payload_ref) return { error: 'board create requires a staged board payload' };
    const payload = this.payloadStore.get(input.payload_ref);
    if (!payload || payload.entity_type !== 'board' || payload.source_id !== input.source_id) {
      return { error: 'staged payload identity does not match the board create operation' };
    }
    const workspaceId = this.boardCreateWorkspaces.get(input.source_id);
    if (!workspaceId) {
      return { error: 'board create witness cannot be proven from the staged payload' };
    }
    return { workspace_id: workspaceId };
  }

  constructor(identityMap: Record<string, string>, payloads?: Record<string, unknown>) {
    this.identityMap = new Map(Object.entries(identityMap));
    this.payloadStore = new Map(
      Object.entries(payloads ?? SYNTH_PAYLOADS).map(([ref, p]) => [ref, p as StagedPayload])
    );
    // Pre-seeded destination state: a label row that already exists natively
    // (e.g. created by hand) which the plan links to its Trello source.
    this.rows.set('label:lbl_synth_0001', {
      id: 'lbl_synth_0001',
      board_id: 'brd_synth_0001',
      name: 'Synth Label',
      color: '#61BD4F',
    });
  }

  async fetchTarget(entityType: EntityType, targetId: string) {
    return this.rows.get(`${entityType}:${targetId}`) ?? null;
  }

  async fetchProvenance(entityType: EntityType, sourceId: string) {
    return (
      this.provenance.find((p) => p.entity_type === entityType && p.source_id === sourceId) ?? null
    );
  }

  async fetchProvenanceByTarget(entityType: EntityType, targetId: string) {
    return this.provenance.find((p) => p.target_ref === `${entityType}:${targetId}`) ?? null;
  }

  async resolveIdentity(_sourceSystem: string, sourceUserId: string) {
    return this.identityMap.get(sourceUserId) ?? null;
  }

  async preflightCreate(input: {
    entity_type: EntityType;
    source_id: string;
    target_id: string;
    payload_ref: string | null;
    plan_hash: string;
    operation: Operation;
  }): Promise<
    | { ok: true; created?: boolean; target_id?: string }
    | { ok: false; reason: string }
  > {
    const key = `${input.entity_type}:${input.source_id}`;
    const payload = input.payload_ref ? this.payloadStore.get(input.payload_ref) : undefined;
    if (!payload) return { ok: false, reason: `no staged payload for ${key}` };
    if (payload.historical_author && !this.identityMap.has(payload.historical_author)) {
      return { ok: false, reason: `unresolved historical identity: ${payload.historical_author}` };
    }
    if (this.failCreateFor.has(key))
      return { ok: false, reason: `injected failure creating ${key}` };
    // Inside a rehearsal scope the real adapter runs the same INSERTs as apply
    // (visible to later ops, discarded when the scope ends), so the mirror does
    // too instead of only checking preconditions.
    if (this.scopeSnapshot) {
      try {
        const result = await this.createWithProvenance(input);
        return { ok: true, created: result.created, target_id: result.target_id };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    }
    return { ok: true, created: true, target_id: input.target_id };
  }

  async preflightMutation(input: MutationInput): Promise<MutationResult> {
    return this.performMutation(input, this.scopeSnapshot !== null);
  }

  async mutateWithProvenance(input: MutationInput): Promise<MutationResult> {
    return this.performMutation(input, true);
  }

  private async performMutation(input: MutationInput, commit: boolean): Promise<MutationResult> {
    const payload = this.payloadStore.get(input.payload_ref);
    if (!payload) throw new Error(`no staged payload for ${input.entity_type}:${input.source_id}`);
    if (payload.entity_type !== input.entity_type || payload.source_id !== input.source_id) {
      throw new Error('staged payload identity does not match mutation operation');
    }
    const rowKey = `${input.entity_type}:${input.target_id}`;
    const current = this.rows.get(rowKey);
    if (!current) return { status: 'blocked', reason: `mutation target ${rowKey} not found` };

    const sourceClaim = this.provenance.find(
      (p) => p.entity_type === input.entity_type && p.source_id === input.source_id
    );
    const targetClaim = this.provenance.find(
      (p) => p.target_ref === targetRef(input.entity_type, input.target_id)
    );
    if (sourceClaim && sourceClaim.target_id !== input.target_id) {
      return { status: 'blocked', reason: 'source is already claimed by another target' };
    }
    if (targetClaim && targetClaim.source_id !== input.source_id) {
      return { status: 'blocked', reason: 'target is already claimed by another source' };
    }

    const patch: Record<string, unknown> = {};
    const fields = input.operation === 'correct' ? COMMENT_CORRECTION_FIELDS : CARD_COVER_FIELDS;
    if (input.operation === 'correct') {
      const author = payload.historical_author;
      if (!author || author !== input.historical_author) {
        throw new Error('comment correction historical_author does not match its staged payload');
      }
      const userId = this.identityMap.get(author);
      if (!userId) throw new Error(`unresolved historical identity: ${author}`);
      if (typeof payload.fields.content !== 'string' || payload.fields.content.trim() === '') {
        throw new Error('comment correction requires non-empty content');
      }
      if (!payload.created_at || !payload.updated_at) {
        throw new Error('comment correction requires created_at and updated_at');
      }
      Object.assign(patch, {
        user_id: userId,
        content: payload.fields.content,
        parent_id: payload.fields.parent_id ?? null,
        created_at: payload.created_at,
        updated_at: payload.updated_at,
      });
    } else {
      Object.assign(patch, {
        cover_attachment_id: payload.fields.cover_attachment_id ?? null,
        cover_color: payload.fields.cover_color ?? null,
        cover_size: payload.fields.cover_size ?? 'SMALL',
      });
    }

    if (fingerprintFields(current, fields) === fingerprintFields(patch, fields) && sourceClaim) {
      return { status: 'noop', target_id: input.target_id, reason: 'mutation already applied' };
    }
    if (fingerprintFields(current, fields) !== input.expected_target_fingerprint) {
      return { status: 'blocked', reason: 'target fingerprint drift — mutation prohibited' };
    }

    if (commit) {
      this.rows.set(rowKey, { ...current, ...patch });
      if (!sourceClaim) {
        this.provenance.push({
          id: randomUUID(),
          source_system: input.source_system,
          entity_type: input.entity_type,
          source_id: input.source_id,
          target_id: input.target_id,
          target_ref: targetRef(input.entity_type, input.target_id),
          import_plan_hash: input.plan_hash,
          operation: input.operation,
        });
      }
    }
    return { status: 'applied', target_id: input.target_id };
  }

  async createWithProvenance(input: {
    entity_type: EntityType;
    source_id: string;
    target_id: string;
    payload_ref: string | null;
    plan_hash: string;
    operation: Operation;
  }): Promise<{ target_id: string; created: boolean }> {
    const key = `${input.entity_type}:${input.source_id}`;
    if (this.failCreateFor.has(key)) {
      throw new Error(`injected failure creating ${key}`);
    }
    // payload resolution (mirrors adapters.resolveStagedPayload)
    const payload = input.payload_ref ? this.payloadStore.get(input.payload_ref) : undefined;
    const keyColumns = compositeKeyColumns(input.entity_type);
    const compositeKey = keyColumns
      ? decodeCompositeTargetId(input.entity_type, input.target_id)
      : null;
    if (!payload && !compositeKey) throw new Error(`no staged payload for ${key}`);

    let authorUserId: string | null = null;
    if (payload?.historical_author) {
      authorUserId = this.identityMap.get(payload.historical_author) ?? null;
      if (!authorUserId)
        throw new Error(`unresolved historical identity: ${payload.historical_author}`);
    }

    const existing = this.provenance.find(
      (p) => p.entity_type === input.entity_type && p.source_id === input.source_id
    );
    if (existing) return { target_id: existing.target_id, created: false };

    const fields = { ...(payload?.fields ?? {}) };
    let row: Record<string, unknown>;
    if (compositeKey && keyColumns) {
      // Join rows: composite key columns only — never an `id`.
      for (const column of keyColumns) {
        const provided = fields[column];
        if (provided !== undefined && String(provided) !== compositeKey[column]) {
          throw new Error(`payload field ${column} disagrees with the target_id key`);
        }
      }
      delete fields.id;
      row = { ...fields, ...compositeKey };
    } else {
      // Mirror the destination schema defaults (migration 0090_card_cover): a
      // created card starts with an empty cover, which is the only pre-image the
      // cover enrich accepts.
      const cardDefaults =
        input.entity_type === 'card'
          ? { cover_attachment_id: null, cover_color: null, cover_size: 'SMALL' }
          : {};
      row = { id: input.target_id, ...cardDefaults, ...fields };
      if (input.entity_type === 'comment') {
        if (!authorUserId) throw new Error('comment payload requires a resolved historical_author');
        row.user_id = authorUserId;
      }
      if (payload?.created_at) row.created_at = payload.created_at;
      if (payload?.updated_at) row.updated_at = payload.updated_at;
    }
    this.rows.set(`${input.entity_type}:${input.target_id}`, row);

    this.provenance.push({
      id: randomUUID(),
      source_system: 'trello',
      entity_type: input.entity_type,
      source_id: input.source_id,
      target_id: input.target_id,
      target_ref: targetRef(input.entity_type, input.target_id),
      import_plan_hash: input.plan_hash,
      operation: input.operation,
    });
    return { target_id: input.target_id, created: true };
  }

  async linkProvenance(input: {
    entity_type: EntityType;
    source_id: string;
    target_id: string;
    plan_hash: string;
  }): Promise<void> {
    this.provenance.push({
      id: randomUUID(),
      source_system: 'trello',
      entity_type: input.entity_type,
      source_id: input.source_id,
      target_id: input.target_id,
      target_ref: targetRef(input.entity_type, input.target_id),
      import_plan_hash: input.plan_hash,
      operation: 'link',
    });
  }

  async writeAudit(entry: AuditEntry) {
    this.audit.push(entry);
  }

  async clearProvenanceByPlan(planHash: string): Promise<number> {
    const before = this.provenance.length;
    this.provenance = this.provenance.filter((p) => p.import_plan_hash !== planHash);
    return before - this.provenance.length;
  }

  async listProvenanceByPlan(planHash: string): Promise<ProvenanceRow[]> {
    return this.provenance.filter((p) => p.import_plan_hash === planHash);
  }

  // In-memory mirror of the knex recovery: deletes only rows this plan created
  // (+ provenance), and refuses when a blocker is injected (the real adapter
  // derives blockers from the live FK graph).
  injectedRecoveryBlockers: Array<{ code: string; detail: string }> = [];

  async recoverByPlan(planHash: string): Promise<RecoveryReport> {
    if (this.injectedRecoveryBlockers.length > 0) {
      return {
        ok: false,
        mode: 'recovery',
        deleted: 0,
        provenance_cleared: 0,
        already_absent: 0,
        blockers: this.injectedRecoveryBlockers,
      };
    }
    const created = this.provenance.filter(
      (p) => p.import_plan_hash === planHash && p.operation === 'create'
    );
    let deleted = 0;
    let alreadyAbsent = 0;
    const remaining = [...created];
    // Children before parents: reverse manifest order (provenance is appended
    // in execution order, which is already dependency-respecting).
    for (const prov of remaining.reverse()) {
      const key = `${prov.entity_type}:${prov.target_id}`;
      if (this.rows.delete(key)) deleted++;
      else alreadyAbsent++;
    }
    const cleared = await this.clearProvenanceByPlan(planHash);
    return {
      ok: true,
      mode: 'recovery',
      deleted,
      provenance_cleared: cleared,
      already_absent: alreadyAbsent,
      blockers: [],
    };
  }
}
