// server/extensions/historicalImport/core/adapters.ts
// Production knex-backed ImporterDeps. Each entity create is a transaction:
// insert entity row + insert provenance, or neither.
//
// Payload resolution: payload_ref is a PRIVATE locator (e.g.
// "file:///var/lib/chimedeck/import-payloads/<plan>/<op>.json"). The server
// never receives payloads through the API — the operator stages them on the
// server host and grants access via filesystem. This keeps payloads out of
// logs, proxies and the tool transport entirely.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Knex } from 'knex';
import { db } from '../../../common/db';
import type { EntityType, ImporterDeps, Operation, ProvenanceRow } from './plan';

export const PAYLOAD_STAGING_ROOT = Bun.env['HISTORICAL_IMPORT_PAYLOAD_ROOT'] ?? '';

// Identity map: Trello member id -> ChimeDeck user id. Loaded from a JSON
// artifact on the server host (operator-staged, private). Identities absent
// from the map are UNRESOLVED and must block operations referencing them.
export const IDENTITY_MAP_PATH = Bun.env['HISTORICAL_IMPORT_IDENTITY_MAP'] ?? '';

export async function loadIdentityMap(): Promise<Map<string, string>> {
  if (!IDENTITY_MAP_PATH) return new Map();
  try {
    const text = await readFile(IDENTITY_MAP_PATH, 'utf8');
    const parsed = JSON.parse(text) as Record<string, string>;
    return new Map(Object.entries(parsed));
  } catch (err) {
    console.error('[historicalImport] failed to load identity map:', err);
    return new Map();
  }
}

const ENTITY_TABLES: Record<EntityType, string> = {
  board: 'boards',
  list: 'lists',
  card: 'cards',
  comment: 'comments',
  comment_reaction: 'comment_reactions',
  attachment: 'attachments',
  checklist: 'checklists',
  checklist_item: 'checklist_items',
  label: 'labels',
  card_label: 'card_labels',
  card_member: 'card_members',
  custom_field: 'custom_fields',
  custom_field_value: 'card_custom_field_values',
  activity: 'activities',
  mention: 'mentions',
};

// Payload staged-file shape. The staged file carries the historical author
// and timestamps; the API/manifest only carries the reference.
export interface StagedPayload {
  entity_type: EntityType;
  source_id: string;
  historical_author?: string; // Trello member id
  created_at?: string; // ISO
  updated_at?: string; // ISO
  fields: Record<string, unknown>; // entity column => value
}

export async function resolveStagedPayload(payloadRef: string | null): Promise<StagedPayload | null> {
  if (!payloadRef) return null;
  if (!PAYLOAD_STAGING_ROOT) {
    throw new Error('HISTORICAL_IMPORT_PAYLOAD_ROOT is not configured on the server');
  }
  // Only file: refs under the configured staging root are allowed — no
  // arbitrary filesystem reads.
  if (!payloadRef.startsWith('file://')) {
    throw new Error(`unsupported payload_ref scheme: ${payloadRef.split(':')[0]}`);
  }
  const rawPath = payloadRef.slice('file://'.length);
  const { resolve, sep } = await import('node:path');
  const stagingRoot = resolve(PAYLOAD_STAGING_ROOT);
  const absPath = resolve(rawPath);
  if (absPath !== stagingRoot && !absPath.startsWith(stagingRoot + sep)) {
    throw new Error('payload_ref escapes the configured staging root');
  }
  const text = await readFile(absPath, 'utf8');
  return JSON.parse(text) as StagedPayload;
}

export function createKnexDeps(identityMap: Map<string, string>): ImporterDeps {
  const trxOf = async (): Promise<Knex.Transaction> => db.transaction();

  return {
    async fetchTarget(entityType, targetId) {
      const table = ENTITY_TABLES[entityType];
      const row = await db(table).where({ id: targetId }).first();
      return (row as Record<string, unknown>) ?? null;
    },

    async fetchProvenance(entityType, sourceId) {
      const row = await db('import_provenance')
        .where({ entity_type: entityType, source_id: sourceId })
        .first();
      return (row as ProvenanceRow) ?? null;
    },

    async fetchProvenanceByTarget(entityType, targetId) {
      const row = await db('import_provenance')
        .where({ target_ref: `${entityType}:${targetId}` })
        .first();
      return (row as ProvenanceRow) ?? null;
    },

    resolveIdentity(sourceSystem, sourceUserId) {
      // Identity map is supplied by the operator (validated identity map
      // artifact); unresolved identities are absent => null => op blocked.
      void sourceSystem;
      return Promise.resolve(identityMap.get(sourceUserId) ?? null);
    },

    async createWithProvenance({ entity_type, source_id, target_id, payload_ref, plan_hash, operation }) {
      const payload = await resolveStagedPayload(payload_ref);
      if (!payload) {
        throw new Error(`no staged payload resolved for ${entity_type}:${source_id} (payload_ref=${payload_ref})`);
      }
      const table = ENTITY_TABLES[entity_type];

      // Historical author must resolve to an existing user (if declared).
      let authorUserId: string | null = null;
      if (payload.historical_author) {
        authorUserId = identityMap.get(payload.historical_author) ?? null;
        if (!authorUserId) {
          throw new Error(`unresolved historical identity: ${payload.historical_author}`);
        }
        const user = await db('users').where({ id: authorUserId }).first();
        if (!user) throw new Error(`mapped user ${authorUserId} does not exist`);
      }

      const trx = await trxOf();
      try {
        const existingProv = await trx('import_provenance')
          .where({ entity_type, source_id })
          .first();
        if (existingProv) {
          await trx.rollback();
          return { target_id: existingProv.target_id, created: false };
        }

        const row: Record<string, unknown> = {
          id: target_id,
          ...payload.fields,
        };
        // Comments/attachments carry the historical author column directly;
        // other entities keep the operator as creator in activity, authorship
        // lives in provenance + payload (documented in capability matrix).
        if (entity_type === 'comment') {
          if (!authorUserId) throw new Error('comment payload requires a resolved historical_author');
          row.user_id = authorUserId;
        }
        if (payload.created_at) row.created_at = payload.created_at;
        if (payload.updated_at) row.updated_at = payload.updated_at;

        await trx(table).insert(row);
        await trx('import_provenance').insert({
          id: randomUUID(),
          source_system: 'trello',
          entity_type,
          source_id,
          target_id,
          target_ref: `${entity_type}:${target_id}`,
          import_plan_hash: plan_hash,
          operation,
        });
        await trx.commit();
        return { target_id, created: true };
      } catch (err) {
        await trx.rollback();
        throw err;
      }
    },

    async linkProvenance({ entity_type, source_id, target_id, plan_hash }) {
      const trx = await trxOf();
      try {
        await trx('import_provenance').insert({
          id: randomUUID(),
          source_system: 'trello',
          entity_type,
          source_id,
          target_id,
          target_ref: `${entity_type}:${target_id}`,
          import_plan_hash: plan_hash,
          operation: 'link' satisfies Operation,
        });
        await trx.commit();
      } catch (err) {
        await trx.rollback();
        throw err;
      }
    },

    async writeAudit(entry) {
      // Append-only; audit failures must not break the engine but are logged.
      try {
        await db('import_audit_log').insert({
          id: randomUUID(),
          actor_user_id: entry.actor_user_id,
          action: entry.action,
          import_plan_hash: entry.import_plan_hash,
          operations_total: entry.operations_total,
          operations_applied: entry.operations_applied,
          operations_noop: entry.operations_noop,
          operations_failed: entry.operations_failed,
          detail: JSON.stringify(entry.detail),
        });
      } catch (err) {
        console.error('[historicalImport] audit write failed:', err);
      }
    },

    async clearProvenanceByPlan(planHash) {
      return db('import_provenance').where({ import_plan_hash: planHash }).del() as unknown as Promise<number>;
    },
  } as ImporterDeps & { clearProvenanceByPlan(planHash: string): Promise<number> };
}
