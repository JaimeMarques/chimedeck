// db/migrations/0125_card_created_by.ts
// Record who created each card. New inserts set created_by from the acting
// user; existing cards are backfilled from their card_created activity.
//
// [why] A card can carry several card_created rows (native event plus a Trello
// import). The Trello row, when present, names the original creator, so it
// wins; then the earliest. The winning actor is kept only when it is a real
// user: 'system' and unmapped source ids stay NULL rather than falling back to
// a weaker row (for an imported card that is usually the importer).
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Runs in the migration transaction (unlike 0109/0110), so the column and
  // its backfill land together; SET LOCAL keeps the timeouts off the pool.
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`SET LOCAL statement_timeout = '0'`);

  await knex.schema.alterTable('cards', (table) => {
    table.string('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
  });

  // jsonb_exists() is the `?` operator; a literal `?` would be a knex binding.
  await knex.raw(`
    UPDATE cards c
       SET created_by = creator.actor_id
      FROM (
        SELECT DISTINCT ON (a.entity_id) a.entity_id, a.actor_id
          FROM activities a
         WHERE a.entity_type = 'card' AND a.action = 'card_created'
         ORDER BY a.entity_id,
                  jsonb_exists(a.payload, 'trello_action_id') DESC,
                  a.created_at ASC,
                  a.id ASC
      ) creator
      JOIN users u ON u.id = creator.actor_id
     WHERE c.id = creator.entity_id
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('cards', (table) => {
    table.dropColumn('created_by');
  });
}
