// db/migrations/0119_historical_import.ts
// Historical import support — adds durable Trello provenance and a dedicated
// audit log for the administrative historical-import extension.
//
// [why] The trello-import.ts seed demonstrated that without durable provenance
// rows, re-runs cannot dedupe, cannot distinguish imported rows from native
// ones, and drift is silently overwritten. ImportProvenance is the single
// source of truth for "this row came from Trello entity X at import-plan Y".
//
// All tables are additive. Down migration drops them cleanly (they hold no
// native data — only provenance/audit metadata created by the import tools).
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Provenance: one row per (entity_type, source_id). The deterministic
  // target_ref = `${entity_type}:${target_id}` is unique, which enforces
  // "one source entity maps to at most one live row" for sources that
  // address by target (cards, comments, attachments...).
  await knex.schema.createTable('import_provenance', (table) => {
    table.string('id').primary();
    table.string('source_system').notNullable(); // e.g. 'trello'
    table.string('entity_type').notNullable(); // 'card' | 'comment' | 'attachment' | ...
    table.string('source_id').notNullable(); // Trello ID of the entity
    table.string('target_id').notNullable(); // ChimeDeck row ID
    table.string('target_ref').notNullable(); // `${entity_type}:${target_id}`
    table.string('import_plan_hash').notNullable();
    table.string('operation').notNullable(); // 'create' | 'link' | 'correct' | 'enrich'
    table.timestamp('imported_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('last_verified_at', { useTz: true }).nullable();

    table.unique(['source_system', 'entity_type', 'source_id']);
    table.unique(['target_ref']);
    table.index(['entity_type', 'target_id']);
    table.index(['import_plan_hash']);
  });

  // Audit log: append-only, one row per administrative action (plan validation,
  // dry-run, apply attempt, apply result). Payload is JSON, actor is the
  // authenticated operator — never the historical author.
  await knex.schema.createTable('import_audit_log', (table) => {
    table.string('id').primary();
    table.string('actor_user_id').notNullable();
    table.string('action').notNullable(); // 'validate' | 'dry_run' | 'apply' | 'reset'
    table.string('import_plan_hash').notNullable();
    table.integer('operations_total').notNullable().defaultTo(0);
    table.integer('operations_applied').notNullable().defaultTo(0);
    table.integer('operations_noop').notNullable().defaultTo(0);
    table.integer('operations_failed').notNullable().defaultTo(0);
    table.jsonb('detail').notNullable().defaultTo('{}'); // summary JSON (no payloads)
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['import_plan_hash', 'created_at']);
    table.index(['actor_user_id', 'created_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('import_audit_log');
  await knex.schema.dropTableIfExists('import_provenance');
}
