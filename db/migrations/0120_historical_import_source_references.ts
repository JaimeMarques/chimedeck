// db/migrations/0120_historical_import_source_references.ts
// Preserve source entities that legitimately have no live destination row.
//
// [why] Some frozen Trello actions refer to lists that were deleted before the
// snapshot. Importing a fake live list would corrupt destination state, while
// dropping the list id/name loses history. The provenance row therefore carries
// validated detached JSON evidence with deliberately no destination FK. A DB
// trigger permits normal last_verified_at maintenance but makes these evidence
// bytes immutable once inserted.
import type { Knex } from 'knex';

const TRIGGER = 'import_provenance_source_references_immutable';
const FUNCTION = 'reject_import_provenance_source_reference_update';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('import_provenance', (table) => {
    table.jsonb('source_references').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
  });
  await knex.raw(`
    ALTER TABLE import_provenance
      ADD CONSTRAINT import_provenance_source_references_array
      CHECK (jsonb_typeof(source_references) = 'array')
  `);
  await knex.raw(`
    CREATE FUNCTION ${FUNCTION}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.source_references IS DISTINCT FROM OLD.source_references THEN
        RAISE EXCEPTION 'detached historical source references are immutable';
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await knex.raw(`
    CREATE TRIGGER ${TRIGGER}
    BEFORE UPDATE OF source_references ON import_provenance
    FOR EACH ROW EXECUTE FUNCTION ${FUNCTION}()
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TRIGGER IF EXISTS ${TRIGGER} ON import_provenance`);
  await knex.raw(`DROP FUNCTION IF EXISTS ${FUNCTION}()`);
  await knex.schema.alterTable('import_provenance', (table) => {
    table.dropColumn('source_references');
  });
}
