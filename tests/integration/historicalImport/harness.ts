// tests/integration/historicalImport/harness.ts
// In-memory ImporterDeps for exercising the plan engine without a DB.
import type {
  EntityType,
  ImporterDeps,
  Operation,
  ProvenanceRow,
} from '../../../server/extensions/historicalImport/core/plan';
import { randomUUID } from 'node:crypto';
import { SYNTH_PAYLOADS } from './fixtures';

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

  constructor(identityMap: Record<string, string>, payloads?: Record<string, unknown>) {
    this.identityMap = new Map(Object.entries(identityMap));
    this.payloadStore = new Map(
      Object.entries(payloads ?? SYNTH_PAYLOADS).map(([ref, p]) => [ref, p as StagedPayload]),
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
    return this.provenance.find((p) => p.entity_type === entityType && p.source_id === sourceId) ?? null;
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
  }): Promise<{ ok: true } | { ok: false; reason: string }> {
    const key = `${input.entity_type}:${input.source_id}`;
    const payload = input.payload_ref ? this.payloadStore.get(input.payload_ref) : undefined;
    if (!payload) return { ok: false, reason: `no staged payload for ${key}` };
    if (payload.historical_author && !this.identityMap.has(payload.historical_author)) {
      return { ok: false, reason: `unresolved historical identity: ${payload.historical_author}` };
    }
    if (this.failCreateFor.has(key)) return { ok: false, reason: `injected failure creating ${key}` };
    return { ok: true };
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
    if (!payload) throw new Error(`no staged payload for ${key}`);

    let authorUserId: string | null = null;
    if (payload.historical_author) {
      authorUserId = this.identityMap.get(payload.historical_author) ?? null;
      if (!authorUserId) throw new Error(`unresolved historical identity: ${payload.historical_author}`);
    }

    const existing = this.provenance.find(
      (p) => p.entity_type === input.entity_type && p.source_id === input.source_id,
    );
    if (existing) return { target_id: existing.target_id, created: false };

    const row: Record<string, unknown> = { id: input.target_id, ...payload.fields };
    if (input.entity_type === 'comment') {
      if (!authorUserId) throw new Error('comment payload requires a resolved historical_author');
      row.user_id = authorUserId;
    }
    if (payload.created_at) row.created_at = payload.created_at;
    if (payload.updated_at) row.updated_at = payload.updated_at;
    this.rows.set(`${input.entity_type}:${input.target_id}`, row);

    this.provenance.push({
      id: randomUUID(),
      source_system: 'trello',
      entity_type: input.entity_type,
      source_id: input.source_id,
      target_id: input.target_id,
      target_ref: `${input.entity_type}:${input.target_id}`,
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
      target_ref: `${input.entity_type}:${input.target_id}`,
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
}
