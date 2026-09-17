// db/migrations/0121_historical_import_actor_provenance.ts
// Preserve a source actor and its reviewed destination identity mapping without
// rewriting a pre-existing destination row's native author/uploader columns.
//
// [why] A historical attachment may link to an already-existing byte-identical
// destination row whose uploaded_by records the native upload event. Import
// provenance must retain the independently verified Trello actor and mapped
// ChimeDeck user while leaving that native row untouched. The two ids form one
// immutable evidence pair and intentionally have no foreign keys: provenance
// must survive source detachment and later destination-user lifecycle changes.
import type { Knex } from 'knex';

const TRIGGER = 'import_provenance_historical_actor_immutable';
const FUNCTION = 'reject_import_provenance_historical_actor_update';
const CONSTRAINT = 'import_provenance_historical_actor_pair';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('import_provenance', (table) => {
    table.string('historical_source_actor_id').nullable();
    table.string('historical_target_actor_id').nullable();
  });
  await knex.raw(`
    ALTER TABLE import_provenance
      ADD CONSTRAINT ${CONSTRAINT}
      CHECK (
        (historical_source_actor_id IS NULL) =
        (historical_target_actor_id IS NULL)
      )
  `);
  await knex.raw(`
    CREATE FUNCTION ${FUNCTION}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.historical_source_actor_id IS DISTINCT FROM OLD.historical_source_actor_id
         OR NEW.historical_target_actor_id IS DISTINCT FROM OLD.historical_target_actor_id THEN
        RAISE EXCEPTION 'historical actor provenance is immutable';
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await knex.raw(`
    CREATE TRIGGER ${TRIGGER}
    BEFORE UPDATE OF historical_source_actor_id, historical_target_actor_id
    ON import_provenance
    FOR EACH ROW EXECUTE FUNCTION ${FUNCTION}()
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TRIGGER IF EXISTS ${TRIGGER} ON import_provenance`);
  await knex.raw(`DROP FUNCTION IF EXISTS ${FUNCTION}()`);
  await knex.raw(`ALTER TABLE import_provenance DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`);
  await knex.schema.alterTable('import_provenance', (table) => {
    table.dropColumn('historical_target_actor_id');
    table.dropColumn('historical_source_actor_id');
  });
}
