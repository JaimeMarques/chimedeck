import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION enforce_card_assignment_eligibility()
    RETURNS trigger AS $$
    DECLARE
      target_user text;
      target_card text;
      target_board text;
      target_workspace text;
    BEGIN
      IF TG_TABLE_NAME = 'card_members' THEN
        target_user := NEW.user_id;
        target_card := NEW.card_id;
      ELSE
        target_user := NEW.assigned_member_id;
        target_card := NEW.card_id;
        IF target_user IS NULL THEN
          RETURN NEW;
        END IF;
      END IF;

      SELECT b.id, b.workspace_id
        INTO target_board, target_workspace
        FROM cards c
        JOIN lists l ON l.id = c.list_id
        JOIN boards b ON b.id = l.board_id
       WHERE c.id = target_card;

      IF target_board IS NULL OR target_workspace IS NULL THEN
        RAISE EXCEPTION 'assignment card context not found' USING ERRCODE = '23503';
      END IF;

      PERFORM pg_advisory_xact_lock(hashtext('workspace-memberships:' || target_workspace));
      PERFORM pg_advisory_xact_lock(hashtext('board-members:' || target_board));

      IF NOT EXISTS (
        SELECT 1
          FROM memberships m
         WHERE m.workspace_id = target_workspace
           AND m.user_id = target_user
           AND (
             m.role <> 'GUEST'
             OR EXISTS (
               SELECT 1 FROM board_guest_access bga
                WHERE bga.board_id = target_board
                  AND bga.user_id = target_user
             )
           )
      ) THEN
        RAISE EXCEPTION 'assignment target is not an active board participant'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER card_members_assignment_eligibility
      BEFORE INSERT OR UPDATE OF user_id, card_id ON card_members
      FOR EACH ROW EXECUTE FUNCTION enforce_card_assignment_eligibility();

    CREATE TRIGGER checklist_items_assignment_eligibility
      BEFORE INSERT OR UPDATE OF assigned_member_id, card_id ON checklist_items
      FOR EACH ROW EXECUTE FUNCTION enforce_card_assignment_eligibility();
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TRIGGER IF EXISTS checklist_items_assignment_eligibility ON checklist_items;
    DROP TRIGGER IF EXISTS card_members_assignment_eligibility ON card_members;
    DROP FUNCTION IF EXISTS enforce_card_assignment_eligibility();
  `);
}
