import type { Knex } from 'knex';

const BOARD_MEMBER_LOCK_NAMESPACE = 'board-members';

// Serialize role changes/removals for one board so every last-ADMIN decision
// observes the result of the preceding mutation. A transaction-scoped advisory
// lock avoids a read-count-write race without blocking unrelated boards.
export async function lockBoardMemberMutations(
  trx: Knex.Transaction,
  boardId: string
): Promise<void> {
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [
    `${BOARD_MEMBER_LOCK_NAMESPACE}:${boardId}`,
  ]);
}

// Only non-GUEST workspace members can exercise an explicit board ADMIN role.
// Excluding orphaned/guest rows keeps the last-admin guard aligned with the
// authorization policy instead of treating unusable legacy rows as backups.
export async function countEligibleBoardAdmins(
  trx: Knex.Transaction,
  boardId: string,
  workspaceId: string
): Promise<number> {
  const result = await trx('board_members as bm')
    .join('memberships as m', function joinActiveMembership() {
      this.on('m.user_id', '=', 'bm.user_id').andOnVal('m.workspace_id', '=', workspaceId);
    })
    .where({ 'bm.board_id': boardId, 'bm.role': 'ADMIN' })
    .whereNot('m.role', 'GUEST')
    .countDistinct('bm.user_id as count')
    .first();

  return Number((result as { count?: string | number } | undefined)?.count ?? 0);
}

export async function removeBoardUserAssignments(
  trx: Knex.Transaction,
  boardIds: string[],
  userId: string
): Promise<void> {
  if (boardIds.length === 0) return;
  const cardIds = () =>
    trx('cards')
      .join('lists', 'lists.id', 'cards.list_id')
      .whereIn('lists.board_id', boardIds)
      .select('cards.id');
  await trx('card_members').where({ user_id: userId }).whereIn('card_id', cardIds()).delete();
  await trx('checklist_items')
    .where({ assigned_member_id: userId })
    .andWhere(function itemsOnBoards() {
      this.whereIn('card_id', cardIds()).orWhereIn(
        'checklist_id',
        trx('checklists').whereIn('card_id', cardIds()).select('id')
      );
    })
    .update({ assigned_member_id: null });
}
