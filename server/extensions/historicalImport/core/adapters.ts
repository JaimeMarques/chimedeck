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
import {
  compositeKeyColumns,
  decodeCompositeTargetId,
  targetRef,
  ID_PART_PATTERN,
} from './composite';
import type {
  EntityType,
  ImporterDeps,
  Operation,
  ProvenanceRow,
  RecoveryReport,
} from './plan';

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

// Referenced-row pre-checks for composite-key (join-table) inserts. The import
// never creates the parents of a join row; a missing oracle row is a clean,
// explicit failure instead of a raw FK violation (23503).
const COMPOSITE_REFERENCES: Record<string, ReadonlyArray<{ column: string; table: string }>> = {
  card_label: [
    { column: 'card_id', table: 'cards' },
    { column: 'label_id', table: 'labels' },
  ],
  card_member: [
    { column: 'card_id', table: 'cards' },
    { column: 'user_id', table: 'users' },
  ],
};

// Valid id charset for composite parts (shared with the composite encoder).

export function createKnexDeps(identityMap: Map<string, string>): ImporterDeps {
  const trxOf = async (): Promise<Knex.Transaction> => db.transaction();

  return {
    async fetchTarget(entityType, targetId) {
      const table = ENTITY_TABLES[entityType];
      // Join tables (card_labels, card_members) have no id column: address the
      // row by its composite key instead of `where({ id })`.
      const keyColumns = compositeKeyColumns(entityType);
      if (keyColumns) {
        const key = decodeCompositeTargetId(entityType, targetId);
        const row = await db(table).where(key).first();
        return (row as Record<string, unknown>) ?? null;
      }
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
        .where({ target_ref: targetRef(entityType, targetId) })
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
      const table = ENTITY_TABLES[entity_type];
      const keyColumns = compositeKeyColumns(entity_type);
      const compositeKey = keyColumns ? decodeCompositeTargetId(entity_type, target_id) : null;
      // Composite rows carry only key columns in the destination table, so a
      // staged payload is optional for them (nothing else to fill in).
      const payload = payload_ref ? await resolveStagedPayload(payload_ref) : null;
      if (!payload && !compositeKey) {
        throw new Error(`no staged payload resolved for ${entity_type}:${source_id} (payload_ref=${payload_ref})`);
      }

      // Historical author must resolve to an existing user (if declared).
      let authorUserId: string | null = null;
      if (payload?.historical_author) {
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

        let row: Record<string, unknown>;
        if (compositeKey && keyColumns) {
          const fields = { ...(payload?.fields ?? {}) };
          for (const column of keyColumns) {
            const provided = fields[column];
            if (provided !== undefined && String(provided as string) !== compositeKey[column]) {
              throw new Error(
                `payload field ${column} (${JSON.stringify(provided)}) disagrees with the target_id key (${compositeKey[column]})`,
              );
            }
          }
          // Never write an `id` column on a table that has none.
          delete fields.id;
          for (const ref of COMPOSITE_REFERENCES[entity_type] ?? []) {
            const value = compositeKey[ref.column];
            if (!value || !ID_PART_PATTERN.test(value)) {
              throw new Error(`${entity_type} target_id is missing a valid ${ref.column}`);
            }
            const referenced = await trx(ref.table).where({ id: value }).first();
            if (!referenced) {
              throw new Error(`referenced ${ref.table}.${ref.column} ${value} does not exist (the import never creates it)`);
            }
          }
          row = { ...fields, ...compositeKey };
        } else {
          row = {
            id: target_id,
            ...(payload?.fields ?? {}),
          };
          // Comments/attachments carry the historical author column directly;
          // other entities keep the operator as creator in activity, authorship
          // lives in provenance + payload (documented in capability matrix).
          if (entity_type === 'comment') {
            if (!authorUserId) throw new Error('comment payload requires a resolved historical_author');
            row.user_id = authorUserId;
          }
          if (payload?.created_at) row.created_at = payload.created_at;
          if (payload?.updated_at) row.updated_at = payload.updated_at;
        }

        await trx(table).insert(row);
        await trx('import_provenance').insert({
          id: randomUUID(),
          source_system: 'trello',
          entity_type,
          source_id,
          target_id,
          target_ref: targetRef(entity_type, target_id),
          import_plan_hash: plan_hash,
          operation,
        });
        await trx.commit();
        return { target_id, created: true };
      } catch (err) {
        await trx.rollback();
        // Concurrency: another writer claimed the same source or the same
        // composite row between our read and our insert. The unique
        // constraints are the authority — re-read provenance and report the
        // existing materialisation instead of failing the operation.
        if (isUniqueViolation(err)) {
          const winner = await db('import_provenance')
            .where({ entity_type, source_id })
            .first();
          if (winner) return { target_id: (winner as ProvenanceRow).target_id, created: false };
        }
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
          target_ref: targetRef(entity_type, target_id),
          import_plan_hash: plan_hash,
          operation: 'link' satisfies Operation,
        });
        await trx.commit();
      } catch (err) {
        await trx.rollback();
        if (isUniqueViolation(err)) {
          throw new Error(
            `target ${targetRef(entity_type, target_id)} was claimed by another import between observation and link`,
          );
        }
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

    async listProvenanceByPlan(planHash) {
      const rows = await db('import_provenance').where({ import_plan_hash: planHash });
      return rows as ProvenanceRow[];
    },

    async recoverByPlan(planHash) {
      return recoverByPlan(planHash);
    },
  } as ImporterDeps & {
    clearProvenanceByPlan(planHash: string): Promise<number>;
    listProvenanceByPlan(planHash: string): Promise<ProvenanceRow[]>;
    recoverByPlan(planHash: string): Promise<RecoveryReport>;
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

// ---------------------------------------------------------------------------
// Destructive recovery (reset with recovery semantics)
// ---------------------------------------------------------------------------
//
// Deletes ONLY the rows this plan created (provenance operation='create'),
// dependents first, then clears the plan's provenance — so the same corrected
// plan can be re-executed without a restore.
//
// Safety model (all fail-closed, single transaction, nothing deleted on refusal):
// 1. only rows this plan created are candidates; rows imported by other plans or
//    native rows are never candidates;
// 2. FK edges are read from the live schema (pg_constraint), never hardcoded;
// 3. non-cascade edges (SET NULL / RESTRICT / NO ACTION) pointing at a deleted
//    row => refuse (a SET NULL would silently mutate content we did not create);
// 4. after deleting, row counts of every table reachable by CASCADE from a
//    deleted row must drop by exactly the number of rows we deleted => any
//    stronger cascade (native or foreign-plan children) rolls the whole
//    transaction back and reports a blocker.

interface FkEdge {
  name: string;
  child_table: string;
  child_columns: string[];
  parent_table: string;
  parent_columns: string[];
  on_delete: string; // 'c' cascade, 'n' set null, 'r' restrict, 'a' no action
}

async function loadForeignKeyEdges(trx: Knex.Transaction, parentTables: string[]): Promise<FkEdge[]> {
  if (parentTables.length === 0) return [];
  const placeholders = parentTables.map(() => '?').join(',');
  const result = await trx.raw(
    `select con.conname as name,
            child.relname as child_table,
            parent.relname as parent_table,
            con.confdeltype as on_delete,
            array_agg(child_col.attname::text order by ck.ord)::text[] as child_columns,
            array_agg(parent_col.attname::text order by pk.ord)::text[] as parent_columns
       from pg_constraint con
       join pg_class child on child.oid = con.conrelid
       join pg_class parent on parent.oid = con.confrelid
       join pg_namespace n on n.oid = child.relnamespace
       join lateral unnest(con.conkey) with ordinality as ck(attnum, ord) on true
       join lateral unnest(con.confkey) with ordinality as pk(attnum, ord) on pk.ord = ck.ord
       join pg_attribute child_col on child_col.attrelid = child.oid and child_col.attnum = ck.attnum
       join pg_attribute parent_col on parent_col.attrelid = parent.oid and parent_col.attnum = pk.attnum
      where con.contype = 'f' and n.nspname = 'public' and parent.relname in (${placeholders})
      group by 1, 2, 3, 4`,
    parentTables,
  );
  return ((result.rows ?? []) as Array<Record<string, unknown>>).map((row) => ({
    name: String(row['name']),
    child_table: String(row['child_table']),
    child_columns: toColumnList(row['child_columns']),
    parent_table: String(row['parent_table']),
    parent_columns: toColumnList(row['parent_columns']),
    on_delete: String(row['on_delete']),
  }));
}

// pg returns `text[]` as a JS array but `name[]` (the pre-cast form) as the
// literal "{a,b}" string — normalise both so no FK edge is silently skipped.
function toColumnList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === 'string') {
    const trimmed = value.replace(/^\{/, '').replace(/\}$/, '');
    return trimmed.length === 0 ? [] : trimmed.split(',').map((v) => v.replace(/^"|"$/g, ''));
  }
  return [];
}

// Topological order over the tables we delete from: children before parents.
function deleteOrder(tables: string[], edges: FkEdge[]): string[] | null {
  const inDelete = new Set(tables);
  const parentsOf = new Map<string, Set<string>>(); // child -> parents
  const childrenOf = new Map<string, Set<string>>(); // parent -> children
  for (const t of tables) {
    parentsOf.set(t, parentsOf.get(t) ?? new Set());
    childrenOf.set(t, childrenOf.get(t) ?? new Set());
  }
  for (const edge of edges) {
    if (!inDelete.has(edge.child_table) || !inDelete.has(edge.parent_table)) continue;
    if (edge.child_table === edge.parent_table) continue; // self reference
    parentsOf.get(edge.child_table)?.add(edge.parent_table);
    childrenOf.get(edge.parent_table)?.add(edge.child_table);
  }
  const pending = new Map<string, number>(); // table -> number of children still to delete
  for (const t of tables) pending.set(t, (childrenOf.get(t) ?? new Set()).size);
  const ready = tables.filter((t) => (pending.get(t) ?? 0) === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    const table = ready.shift() as string;
    if (order.includes(table)) continue;
    order.push(table);
    for (const parent of parentsOf.get(table) ?? []) {
      const remaining = (pending.get(parent) ?? 0) - 1;
      pending.set(parent, remaining);
      if (remaining === 0) ready.push(parent);
    }
  }
  return order.length === tables.length ? order : null;
}

function cascadeClosure(tables: string[], edges: FkEdge[]): string[] {
  const seen = new Set(tables);
  const queue = [...tables];
  while (queue.length > 0) {
    const table = queue.shift() as string;
    for (const edge of edges) {
      if (edge.parent_table !== table || edge.on_delete !== 'c') continue;
      if (seen.has(edge.child_table)) continue;
      seen.add(edge.child_table);
      queue.push(edge.child_table);
    }
  }
  return [...seen];
}

async function countRows(trx: Knex.Transaction, table: string): Promise<number> {
  const row = (await trx(table).count({ n: '*' }).first()) as { n?: string | number } | undefined;
  return Number(row?.n ?? 0);
}

async function recoverByPlan(planHash: string): Promise<RecoveryReport> {
  const trx = await db.transaction();
  const blockers: RecoveryReport['blockers'] = [];
  try {
    const provenance = (await trx('import_provenance').where({ import_plan_hash: planHash })) as ProvenanceRow[];
    let created: Array<{ entity_type: string; target_id: string }> = provenance
      .filter((row) => row.operation === 'create')
      .map((row) => ({ entity_type: row.entity_type, target_id: row.target_id }));
    let candidatesFrom: 'provenance' | 'audit' = 'provenance';

    // A provenance-only reset removes the only live record of what the plan
    // created. The append-only audit log keeps it, so an operator who reset
    // first can still recover (remediation QA-6: recovery must not require a
    // database restore).
    if (created.length === 0) {
      const audits = (await trx('import_audit_log')
        .where({ import_plan_hash: planHash, action: 'reset' })
        .orderBy('created_at', 'desc')) as Array<{ detail: unknown }>;
      for (const audit of audits) {
        const detail = typeof audit.detail === 'string' ? (JSON.parse(audit.detail) as Record<string, unknown>) : (audit.detail as Record<string, unknown> | null);
        const recorded = detail?.['created_targets'];
        if (Array.isArray(recorded) && recorded.length > 0) {
          created = (recorded as Array<{ entity_type: string; target_id: string }>).filter(
            (r) => typeof r?.entity_type === 'string' && typeof r?.target_id === 'string',
          );
          candidatesFrom = 'audit';
          break;
        }
      }
    }

    // Candidate delete set: rows this plan created, addressed by primary key
    // (id column, or the composite key for join tables).
    const candidates = new Map<string, Array<Record<string, string>>>();
    for (const row of created) {
      const table = ENTITY_TABLES[row.entity_type as EntityType];
      if (!table) {
        blockers.push({
          code: 'recovery-unknown-entity-type',
          detail: `${row.entity_type} has no destination table`,
        });
        continue;
      }
      let key: Record<string, string>;
      try {
        key = compositeKeyColumns(row.entity_type)
          ? decodeCompositeTargetId(row.entity_type, row.target_id)
          : { id: row.target_id };
      } catch (err) {
        blockers.push({
          code: 'recovery-invalid-provenance-key',
          detail: `${row.entity_type} provenance row has an invalid target_id: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
      const list = candidates.get(table) ?? [];
      list.push(key);
      candidates.set(table, list);
    }

    // Only rows that still exist are deletable; missing ones are reported.
    const deletable = new Map<string, Array<Record<string, string>>>();
    let alreadyAbsent = 0;
    for (const [table, keys] of candidates) {
      const present: Array<Record<string, string>> = [];
      for (const key of keys) {
        const found = await trx(table).where(key).first();
        if (found) present.push(key);
        else alreadyAbsent++;
      }
      if (present.length > 0) deletable.set(table, present);
    }

    const edges = await loadForeignKeyEdges(trx, [...deletable.keys()]);

    // (3) non-cascade edges: never let recovery mutate content we did not create.
    for (const edge of edges) {
      if (edge.on_delete === 'c') continue;
      if (edge.parent_columns.length !== 1) {
        blockers.push({
          code: 'recovery-unverifiable-fk-edge',
          detail: `${edge.name}: composite parent key cannot be verified`,
        });
        continue;
      }
      const parentColumn = edge.parent_columns[0] as string;
      const values = [...new Set((deletable.get(edge.parent_table) ?? []).map((k) => k[parentColumn]).filter(Boolean))];
      if (values.length === 0) continue;
      const childColumn = edge.child_columns[0] as string;
      const row = (await trx(edge.child_table)
        .whereIn(childColumn, values as string[])
        .count({ n: '*' })
        .first()) as { n?: string | number } | undefined;
      const count = Number(row?.n ?? 0);
      if (count > 0) {
        blockers.push({
          code: 'recovery-non-cascade-dependency',
          detail: `${edge.child_table}.${childColumn} references ${edge.parent_table} rows this plan created (on delete ${edge.on_delete}); ${String(count)} row(s) would be mutated or orphaned`,
        });
      }
    }

    const order = deleteOrder([...deletable.keys()], edges);
    if (!order) {
      blockers.push({ code: 'recovery-fk-cycle', detail: 'destination FK graph contains a cycle between plan rows' });
    }

    if (blockers.length === 0 && order) {
      const closure = cascadeClosure([...deletable.keys()], edges);
      const before = new Map<string, number>();
      for (const table of closure) before.set(table, await countRows(trx, table));

      let deleted = 0;
      for (const table of order) {
        for (const key of deletable.get(table) ?? []) {
          // knex/pg returns the affected row count as a number.
          const n: number = await trx(table).where(key).del();
          deleted += n;
        }
      }

      // (4) cascade postcondition: no table may lose more rows than we deleted.
      for (const table of closure) {
        const after = await countRows(trx, table);
        const expected = (before.get(table) ?? 0) - (deletable.get(table)?.length ?? 0);
        if (after !== expected) {
          blockers.push({
            code: 'recovery-unexpected-cascade',
            detail: `${table}: expected ${String(expected)} row(s) after recovery, found ${String(after)} — rows outside this plan were affected`,
          });
        }
      }

      if (blockers.length === 0) {
        const cleared: number = await trx('import_provenance').where({ import_plan_hash: planHash }).del();
        await trx.commit();
        return {
          ok: true,
          mode: 'recovery',
          deleted,
          provenance_cleared: cleared,
          already_absent: alreadyAbsent,
          candidates_from: candidatesFrom,
          blockers: [],
        };
      }
    }

    await trx.rollback();
    return {
      ok: false,
      mode: 'recovery',
      deleted: 0,
      provenance_cleared: 0,
      already_absent: alreadyAbsent,
      candidates_from: candidatesFrom,
      blockers,
    };
  } catch (err) {
    await trx.rollback();
    throw err;
  }
}
