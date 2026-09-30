import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('attachments', (table) => {
    table.string('upload_context').notNullable().defaultTo('card');
    table.timestamp('upload_confirmed_at').nullable();
    table.timestamp('abandoned_at').nullable();
    table.string('comment_id').nullable().references('id').inTable('comments').onDelete('SET NULL');
    table.index(['comment_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('attachments', (table) => {
    table.dropColumn('comment_id');
    table.dropColumn('upload_context');
    table.dropColumn('upload_confirmed_at');
    table.dropColumn('abandoned_at');
  });
}
