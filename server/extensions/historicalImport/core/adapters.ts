// server/extensions/historicalImport/core/adapters.ts
// Production knex-backed ImporterDeps. Each entity create is a transaction:
// insert entity row + insert provenance, or neither.
//
// Payload resolution: payload_ref is a PRIVATE locator (e.g.
// "file:///var/lib/chimedeck/import-payloads/<plan>/<op>.json"). The server
// never receives payloads through the API — the operator stages them on the
// server host and grants access via filesystem. This keeps payloads out of
// logs, proxies and the tool transport entirely.
// [why parity] The dry-run preflight and the real apply share ONE body
// (`performCreate`): the only difference is commit vs rollback. A dry-run
// therefore fails exactly where an apply would fail, with the same error
// message — payload unreadable/absent, payload/manifest SHA-256 mismatch,
// unresolved historical identity, column/constraint/FK violation, or a
// provenance uniqueness conflict. Drift between rehearsal and apply is
// structural, not merely tested.
//
// Payload resolution lives in ./payload.ts (staging-root containment +
// manifest SHA-256 verification) and is re-exported here for callers that
// used to import it from this module.
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Knex } from 'knex';
import { db } from '../../../common/db';
import type { EntityType, ImporterDeps, Operation, ProvenanceRow } from './plan';
import { readVerifiedStagedPayload } from './payload';

export {
  PAYLOAD_STAGING_ROOT,
  PAYLOAD_MANIFEST_PATH,
  resolveStagedPayload,
  type StagedPayload,
} from './payload';

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

const SHORT_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const SHORT_ID_LENGTH = 8;

function generatedShortId(): string {
  const bytes = randomBytes(SHORT_ID_LENGTH);
  return Array.from(bytes, (byte) => SHORT_ID_ALPHABET[byte % SHORT_ID_ALPHABET.length]).join('');
}

// Resolve cards.short_id before entering the INSERT. The deploy schema uses a
// CHECK (short_id IS NOT NULL) and a partial unique index; imported Trello
// shortLink is preserved where it has the native eight-character form and is
// free, otherwise the importer allocates a collision-resistant native id.
// The unique index remains the concurrency authority: a race causes the
// transaction to roll back and is surfaced by the dry-run/apply equally.
async function ensureCardShortId(trx: Knex.Transaction, row: Record<string, unknown>): Promise<void> {
  const supplied = row.short_id;
  if (typeof supplied === 'string' && /^[A-Za-z0-9]{8}$/.test(supplied)) return;
  if (supplied !== undefined && supplied !== null) {
    throw new Error('card payload short_id must be an 8-character alphanumeric string');
  }

  const preferred = row.short_link;
  if (typeof preferred === 'string' && /^[A-Za-z0-9]{8}$/.test(preferred)) {
    const existing = await trx('cards').where({ short_id: preferred }).first();
    if (!existing) {
      row.short_id = preferred;
      return;
    }
  }
  // A persisted collision between retries is extremely unlikely, but the
  // explicit bounded retry prevents an unbounded import worker loop.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = generatedShortId();
    const existing = await trx('cards').where({ short_id: candidate }).first();
    if (!existing) {
      row.short_id = candidate;
      return;
    }
  }
  throw new Error('failed-to-generate-unique-short-id:cards');
}

export interface CreateWithProvenanceInput {
  entity_type: EntityType;
  source_id: string;
  target_id: string;
  payload_ref: string | null;
  plan_hash: string;
  operation: Operation;
}

// Shared create body: resolve + verify the staged payload, resolve the
// historical author, then (in one transaction) insert the entity row and its
// provenance row. `mode: 'dry-run'` rolls the transaction back instead of
// committing, so nothing durable is written.
async function performCreate(
  input: CreateWithProvenanceInput,
  mode: 'apply' | 'dry-run',
  identityMap: Map<string, string>,
): Promise<{ target_id: string; created: boolean }> {
  const { entity_type, source_id, target_id, payload_ref, plan_hash, operation } = input;
  const payload = await readVerifiedStagedPayload(payload_ref);
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

  const trx = await db.transaction();
  try {
    const existingProv = await trx('import_provenance').where({ entity_type, source_id }).first();
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
    if (entity_type === 'card') await ensureCardShortId(trx, row);

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
    if (mode === 'dry-run') {
      // Rehearsal: the write path above is validated by the real schema
      // (NOT NULL/CHECK/FK/unique), then discarded.
      await trx.rollback();
      return { target_id, created: false };
    }
    await trx.commit();
    return { target_id, created: true };
  } catch (err) {
    await trx.rollback();
    throw err;
  }
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

    createWithProvenance(input) {
      return performCreate(input, 'apply', identityMap);
    },

    // Dry-run preflight: same body, rolled back. Never throws — the engine
    // turns a failure into the `failed` outcome a real apply would produce.
    async preflightCreate(input) {
      try {
        await performCreate(input, 'dry-run', identityMap);
        return { ok: true } as const;
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) } as const;
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
