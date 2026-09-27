import type { Knex } from 'knex';

// Assignments and moves take workspace then board then card locks. Re-read the
// card after waiting: a move can commit while an assignment waits for its old
// board lock, so validation must fail/retry rather than trust that stale board.
function assignmentGuardSql(lockCard: boolean): string {
  const cardLock = lockCard
    ? `
      PERFORM pg_advisory_xact_lock(hashtext('card-assignments:' || target_card));
      SELECT b.id, b.workspace_id INTO locked_board, locked_workspace
        FROM cards c JOIN lists l ON l.id = c.list_id
        JOIN boards b ON b.id = l.board_id WHERE c.id = target_card;
      IF locked_board IS DISTINCT FROM target_board
         OR locked_workspace IS DISTINCT FROM target_workspace THEN
        RAISE EXCEPTION 'assignment card location changed while waiting for locks'
          USING ERRCODE = '40001';
      END IF;`
    : '';
  const lockedBoardFields = lockCard ? 'locked_board text; locked_workspace text;' : '';
  return `
    CREATE OR REPLACE FUNCTION enforce_card_assignment_eligibility()
    RETURNS trigger AS $$
    DECLARE
      target_user text;
      target_card text;
      target_board text;
      target_workspace text;
      ${lockedBoardFields}
    BEGIN
      IF TG_TABLE_NAME = 'card_members' THEN
        target_user := NEW.user_id;
        target_card := NEW.card_id;
      ELSE
        target_user := NEW.assigned_member_id;
        target_card := NEW.card_id;
        IF target_user IS NULL THEN RETURN NEW; END IF;
      END IF;

      SELECT b.id, b.workspace_id INTO target_board, target_workspace
        FROM cards c JOIN lists l ON l.id = c.list_id
        JOIN boards b ON b.id = l.board_id
       WHERE c.id = target_card;
      IF target_board IS NULL OR target_workspace IS NULL THEN
        RAISE EXCEPTION 'assignment card context not found' USING ERRCODE = '23503';
      END IF;

      PERFORM pg_advisory_xact_lock(hashtext('workspace-memberships:' || target_workspace));
      PERFORM pg_advisory_xact_lock(hashtext('board-members:' || target_board));
      ${cardLock}
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

      PERFORM pg_advisory_xact_lock(hashtext('workspace-memberships:' || target_workspace));
      PERFORM pg_advisory_xact_lock(hashtext('board-members:' || target_board));
      PERFORM pg_advisory_xact_lock(hashtext('card-assignments:' || NEW.id));
      IF EXISTS (
        SELECT 1 FROM card_labels cl LEFT JOIN labels lab ON lab.id = cl.label_id
         WHERE cl.card_id = NEW.id AND lab.board_id IS DISTINCT FROM target_board
      ) THEN
        RAISE EXCEPTION 'card move would retain a label from another board'
          USING ERRCODE = '23514', CONSTRAINT = 'card_move_label_ownership';
      END IF;
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

    CREATE FUNCTION enforce_card_label_ownership()
    RETURNS trigger AS $$
    DECLARE
      card_board text;
      label_board text;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtext('card-assignments:' || NEW.card_id));
      SELECT l.board_id INTO card_board
        FROM cards c JOIN lists l ON l.id = c.list_id WHERE c.id = NEW.card_id;
      SELECT board_id INTO label_board FROM labels WHERE id = NEW.label_id;
      IF card_board IS NULL OR label_board IS NULL THEN
        RAISE EXCEPTION 'card label context not found' USING ERRCODE = '23503';
      END IF;
      IF card_board <> label_board THEN
        RAISE EXCEPTION 'card label belongs to another board'
          USING ERRCODE = '23514', CONSTRAINT = 'card_move_label_ownership';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER card_label_ownership
      BEFORE INSERT OR UPDATE OF card_id, label_id ON card_labels
      FOR EACH ROW EXECUTE FUNCTION enforce_card_label_ownership();

    CREATE FUNCTION serialize_state_transition_writes()
    RETURNS trigger AS $$
    DECLARE
      workspace_id_for_board text;
    BEGIN
      SELECT workspace_id INTO workspace_id_for_board FROM boards WHERE id = NEW.board_id;
      IF workspace_id_for_board IS NULL THEN
        RAISE EXCEPTION 'state-transition board context not found' USING ERRCODE = '23503';
      END IF;
      PERFORM pg_advisory_xact_lock(hashtext('workspace-memberships:' || workspace_id_for_board));
      PERFORM pg_advisory_xact_lock(hashtext('board-members:' || NEW.board_id));
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER state_transition_write_locks
      BEFORE INSERT OR UPDATE ON board_state_transitions
      FOR EACH ROW EXECUTE FUNCTION serialize_state_transition_writes();
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TRIGGER IF EXISTS state_transition_write_locks ON board_state_transitions;
    DROP FUNCTION IF EXISTS serialize_state_transition_writes();
    DROP TRIGGER IF EXISTS card_label_ownership ON card_labels;
    DROP FUNCTION IF EXISTS enforce_card_label_ownership();
    DROP TRIGGER IF EXISTS card_move_assignment_eligibility ON cards;
    DROP FUNCTION IF EXISTS enforce_card_move_assignment_eligibility();
  `);
  await knex.raw(assignmentGuardSql(false));
}
