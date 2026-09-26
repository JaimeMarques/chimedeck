import type { Knex } from 'knex';

// Both assignment changes and card moves serialize by card *before* reading
// the card's board. A waiting assignment must not validate against the old
// board after a concurrent move commits.
function assignmentGuardSql(lockCard: boolean): string {
  const cardLock = lockCard
    ? "PERFORM pg_advisory_xact_lock(hashtext('card-assignments:' || target_card));"
    : '';
  return `
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
        IF target_user IS NULL THEN RETURN NEW; END IF;
      END IF;

      ${cardLock}
      SELECT b.id, b.workspace_id INTO target_board, target_workspace
        FROM cards c JOIN lists l ON l.id = c.list_id
        JOIN boards b ON b.id = l.board_id
       WHERE c.id = target_card;
      IF target_board IS NULL OR target_workspace IS NULL THEN
        RAISE EXCEPTION 'assignment card context not found' USING ERRCODE = '23503';
      END IF;

      PERFORM pg_advisory_xact_lock(hashtext('workspace-memberships:' || target_workspace));
      PERFORM pg_advisory_xact_lock(hashtext('board-members:' || target_board));
      IF NOT EXISTS (
        SELECT 1 FROM memberships m
         WHERE m.workspace_id = target_workspace AND m.user_id = target_user
           AND (m.role <> 'GUEST' OR EXISTS (
             SELECT 1 FROM board_guest_access bga
              WHERE bga.board_id = target_board AND bga.user_id = target_user
           ))
      ) THEN
        RAISE EXCEPTION 'assignment target is not an active board participant'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `;
}

export async function up(knex: Knex): Promise<void> {
  await knex.raw(assignmentGuardSql(true));
  await knex.raw(`
    CREATE FUNCTION enforce_card_move_assignment_eligibility()
    RETURNS trigger AS $$
    DECLARE
      source_board text;
      source_workspace text;
      target_board text;
      target_workspace text;
      target_visibility text;
    BEGIN
      IF NEW.list_id IS NOT DISTINCT FROM OLD.list_id THEN RETURN NEW; END IF;
      SELECT b.id, b.workspace_id INTO source_board, source_workspace
        FROM lists l JOIN boards b ON b.id = l.board_id WHERE l.id = OLD.list_id;
      SELECT b.id, b.workspace_id, b.visibility INTO target_board, target_workspace, target_visibility
        FROM lists l JOIN boards b ON b.id = l.board_id WHERE l.id = NEW.list_id;
      IF source_board IS NULL OR target_board IS NULL THEN
        RAISE EXCEPTION 'card move board context not found' USING ERRCODE = '23503';
      END IF;
      IF source_board = target_board THEN RETURN NEW; END IF;

      PERFORM pg_advisory_xact_lock(hashtext('card-assignments:' || NEW.id));
      PERFORM pg_advisory_xact_lock(hashtext('workspace-memberships:' || target_workspace));
      PERFORM pg_advisory_xact_lock(hashtext('board-members:' || target_board));
      IF source_workspace <> target_workspace OR EXISTS (
        SELECT 1 FROM (
          SELECT cm.user_id FROM card_members cm WHERE cm.card_id = NEW.id
          UNION ALL
          SELECT ci.assigned_member_id AS user_id FROM checklist_items ci
           WHERE ci.card_id = NEW.id AND ci.assigned_member_id IS NOT NULL
        ) assigned
        WHERE NOT EXISTS (
          SELECT 1 FROM memberships m
           WHERE m.workspace_id = target_workspace AND m.user_id = assigned.user_id
             AND (
               m.role IN ('OWNER', 'ADMIN')
               OR (m.role = 'GUEST' AND EXISTS (
                 SELECT 1 FROM board_guest_access bga
                  WHERE bga.board_id = target_board AND bga.user_id = assigned.user_id
               ))
               OR (m.role IN ('MEMBER', 'VIEWER') AND (
                 target_visibility <> 'PRIVATE' OR EXISTS (
                   SELECT 1 FROM board_members bm
                    WHERE bm.board_id = target_board AND bm.user_id = assigned.user_id
                 )
               ))
             )
        )
      ) THEN
        RAISE EXCEPTION 'card move would leave an ineligible assignment'
          USING ERRCODE = '23514', CONSTRAINT = 'card_move_assignment_eligibility';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER card_move_assignment_eligibility
      BEFORE UPDATE OF list_id ON cards
      FOR EACH ROW EXECUTE FUNCTION enforce_card_move_assignment_eligibility();
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TRIGGER IF EXISTS card_move_assignment_eligibility ON cards;
    DROP FUNCTION IF EXISTS enforce_card_move_assignment_eligibility();
  `);
  await knex.raw(assignmentGuardSql(false));
}
