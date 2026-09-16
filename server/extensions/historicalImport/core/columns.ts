// server/extensions/historicalImport/core/columns.ts
// Destination column metadata for staged historical timestamps.
//
// [why] A staged payload may declare historical created_at/updated_at for ANY
// entity type (the StagedPayload contract in docs/historical-import.md carries
// them at the top level), but only some destination tables actually have those
// columns. `lists`, `checklist_items`, `labels` and `card_custom_field_values`
// have neither; `boards`, `comment_reactions`, `custom_fields`, `activities`
// and `mentions` have `created_at` but no `updated_at`; `cards`, `comments`,
// `attachments`, `checklists` have both. Writing a declared timestamp into a row
// whose table has no such column makes the INSERT fail
// (`column "created_at" of relation "lists" does not exist`) and, with
// fail-fast, a single such row aborts the whole apply — while the planner's plan
// legitimately contains tens of lists.
//
// [why live schema, not a hardcoded table list] The set of timestamp columns is
// a property of the destination schema, and migrations change it (e.g. the
// timestamp columns of most tables were converted to `timestamptz` after their
// original migration). A hardcoded allowlist would silently stop preserving
// history the day a column is added. The projection therefore asks the live
// schema (information_schema), exactly like the destructive-recovery path reads
// FK edges from pg_constraint instead of a fixed list. Nothing here ever creates,
// renames or guesses a column.
//
// [why fail-closed] An empty metadata result means the lookup itself failed
// (unknown table, wrong schema/search_path, introspection error). Treating it as
// "column absent" would silently drop historical timestamps, so it is a hard
// error instead: only a *proven* absence drops a declared timestamp, and a
// dropped timestamp is reported by the caller rather than disappearing quietly.
import type { Knex } from 'knex';

export const HISTORICAL_TIMESTAMP_FIELDS = ['created_at', 'updated_at'] as const;

export type HistoricalTimestampField = (typeof HISTORICAL_TIMESTAMP_FIELDS)[number];

// The fields of a staged payload this module is allowed to look at. Kept
// structural (not StagedPayload) so the projection can be unit-tested without a
// payload file on disk.
export interface StagedTimestampFields {
  created_at?: unknown;
  updated_at?: unknown;
}

// Resolve the real column names of one destination table.
export type ColumnProbe = (trx: Knex.Transaction, table: string) => Promise<ReadonlySet<string>>;

// Destination schema the importer writes to. Postgres is the only supported
// destination (the project is Postgres-only) and the migrations create their
// tables in `public`.
export const COLUMN_METADATA_SCHEMA = 'public';

export async function queryTableColumns(
  trx: Knex.Transaction,
  table: string
): Promise<ReadonlySet<string>> {
  const rows = (await trx('information_schema.columns')
    .where({ table_schema: COLUMN_METADATA_SCHEMA, table_name: table })
    .select('column_name')) as Array<{ column_name?: unknown }>;
  const columns = new Set(rows.map((row) => String(row['column_name'] ?? '')).filter((c) => c));
  if (columns.size === 0) {
    // Never treat "metadata unavailable" as "column absent": that would drop
    // historical timestamps silently. Fail closed instead.
    throw new Error(
      `column metadata unavailable for table ${COLUMN_METADATA_SCHEMA}.${table}`
    );
  }
  return columns;
}

// One metadata query per table per deps instance (a plan run creates its deps
// once): a plan with 77 list creates introspects `lists` exactly once.
//
// Failures are never memoised: a transient introspection error must fail that
// operation, and the next operation has to try again rather than inherit a
// poisoned cache.
export function createCachedColumnProbe(probe: ColumnProbe): ColumnProbe {
  const cache = new Map<string, ReadonlySet<string>>();
  return async (trx: Knex.Transaction, table: string) => {
    const cached = cache.get(table);
    if (cached) return cached;
    const columns = await probe(trx, table);
    cache.set(table, columns);
    return columns;
  };
}

export interface TimestampProjection {
  // Declared historical timestamps that reached the row.
  applied: HistoricalTimestampField[];
  // Declared historical timestamps whose column provably does not exist in the
  // destination table: omitted (never invented, never renamed), reported by the
  // caller.
  omitted: HistoricalTimestampField[];
}

// Pure projection: exact column-name matching only, over the two documented
// historical timestamp fields. A declared value is copied verbatim; a missing
// column is reported and the row keeps no trace of it (no homonymous column is
// written, no existing column is reused).
export function projectHistoricalTimestamps(
  row: Record<string, unknown>,
  declared: StagedTimestampFields | null | undefined,
  columns: ReadonlySet<string>
): TimestampProjection {
  const applied: HistoricalTimestampField[] = [];
  const omitted: HistoricalTimestampField[] = [];
  for (const field of HISTORICAL_TIMESTAMP_FIELDS) {
    const value = declared ? declared[field] : undefined;
    // Same gate as the previous unconditional assignment: only a declared,
    // non-empty value counts as a historical timestamp.
    if (!value) continue;
    if (!columns.has(field)) {
      omitted.push(field);
      continue;
    }
    row[field] = value;
    applied.push(field);
  }
  return { applied, omitted };
}

// Probe-backed projection used by the create path. The schema is only consulted
// when the payload actually declares a timestamp, so the vast majority of
// operations pay no extra query.
export async function applyHistoricalTimestamps(
  probe: ColumnProbe,
  trx: Knex.Transaction,
  table: string,
  row: Record<string, unknown>,
  declared: StagedTimestampFields | null | undefined
): Promise<TimestampProjection> {
  const declaredCount = HISTORICAL_TIMESTAMP_FIELDS.filter((field) => declared?.[field]).length;
  if (declaredCount === 0) return { applied: [], omitted: [] };
  const columns = await probe(trx, table);
  return projectHistoricalTimestamps(row, declared, columns);
}
