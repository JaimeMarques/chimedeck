import type { Knex } from 'knex';
import { resolveHighestRole, roleRank, type Role } from '../../../../middlewares/permissionManager';
import {
  countEligibleBoardAdmins,
  lockBoardMemberMutations,
  removeBoardUserAssignments,
} from '../../../board/api/members/lock';

type BoardIdRow = { id: string; workspace_id: string };
type WorkspaceMembershipRow = { user_id: string; workspace_id: string; role: string };
type BoardMembershipRow = { board_id: string; role: string };

export async function removeWorkspaceMemberInTransaction(
  trx: Knex.Transaction,
  workspaceId: string,
  userId: string,
  actorUserId: string
): Promise<Response | null> {
  const boards = await trx<BoardIdRow>('boards')
    .where({ workspace_id: workspaceId })
    .select('id')
    .orderBy('id');
  for (const board of boards) {
    await lockBoardMemberMutations(trx, board.id);
  }

  const targetMembership = await trx<WorkspaceMembershipRow>('memberships')
    .where({ user_id: userId, workspace_id: workspaceId })
    .first();

  if (!targetMembership) {
    return Response.json(
      { error: { code: 'member-not-found', message: 'User is not a member of this workspace' } },
      { status: 404 }
    );
  }

  const actorMemberships = await trx<WorkspaceMembershipRow>('memberships')
    .where({ user_id: actorUserId, workspace_id: workspaceId })
    .select('role');
  const actorRole = resolveHighestRole(actorMemberships.map((membership) => membership.role));
  if (
    !actorRole ||
    roleRank(actorRole) < roleRank('ADMIN') ||
    roleRank(targetMembership.role as Role) > roleRank(actorRole)
  ) {
    return Response.json(
      {
        error: {
          code: 'role-exceeds-caller-privilege',
          message: 'You cannot remove a member with a role higher than your own',
        },
      },
      { status: 403 }
    );
  }

  if (targetMembership.role === 'OWNER') {
    const ownerCount = await trx('memberships')
      .where({ workspace_id: workspaceId, role: 'OWNER' })
      .count('user_id as count')
      .first();
    const count = Number((ownerCount as { count?: string | number } | undefined)?.count ?? 0);
    if (count <= 1) {
      return Response.json(
        {
          error: {
            code: 'workspace-must-have-one-owner',
            message:
              'A workspace must always have at least one Owner. Promote another member first.',
          },
        },
        { status: 422 }
      );
    }
  }

  const boardMemberships = await trx<BoardMembershipRow>('board_members')
    .join('boards', 'boards.id', 'board_members.board_id')
    .where({ 'boards.workspace_id': workspaceId, 'board_members.user_id': userId })
    .select('board_members.board_id', 'board_members.role');

  // A GUEST membership is ineligible by definition, so deleting its stale
  // ADMIN rows cannot reduce the eligible-admin cardinality.
  if (targetMembership.role !== 'GUEST') {
    for (const rawMembership of boardMemberships) {
      const membership = rawMembership as unknown as BoardMembershipRow;
      if (membership.role !== 'ADMIN') continue;
      const adminCount = await countEligibleBoardAdmins(trx, membership.board_id, workspaceId);
      if (adminCount <= 1) {
        return Response.json(
          {
            error: {
              code: 'last-board-admin',
              message: 'Promote another board member before removing this workspace member.',
            },
          },
          { status: 409 }
        );
      }
    }
  }

  const boardIds = boards.map((board) => board.id);
  if (boardIds.length > 0) {
    await removeBoardUserAssignments(trx, boardIds, userId);
    await trx('board_guest_access')
      .where({ user_id: userId })
      .whereIn('board_id', boardIds)
      .delete();
    await trx('board_members').where({ user_id: userId }).whereIn('board_id', boardIds).delete();
  }
  await trx('memberships').where({ user_id: userId, workspace_id: workspaceId }).delete();
  return null;
}
