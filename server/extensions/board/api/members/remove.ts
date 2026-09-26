// DELETE /api/v1/boards/:id/members/:userId — remove a member from the board.
// Requires explicit board ADMIN or workspace ADMIN+.
// Invariant: the last ADMIN on the board cannot be removed.
import { db } from '../../../../common/db';
import type { AuthenticatedRequest } from '../../../auth/middlewares/authentication';
import type { BoardVisibilityScopedRequest } from '../../../../middlewares/boardVisibility';
import { writeEvent } from '../../../../mods/events/index';
import { getCurrentWorkspaceRole, requireBoardMemberManager } from './authorization';
import {
  countEligibleBoardAdmins,
  lockBoardMemberMutations,
  removeBoardUserAssignments,
} from './lock';
import { lockWorkspaceMembershipMutations } from '../../../workspace/api/members/lock';

export async function handleRemoveBoardMember(
  req: Request,
  boardId: string,
  userId: string
): Promise<Response> {
  const scopedReq = req as BoardVisibilityScopedRequest;
  const currentUserId = (req as AuthenticatedRequest).currentUser?.id;

  if (!currentUserId) {
    return Response.json(
      { name: 'unauthorized', data: { message: 'Authentication required' } },
      { status: 401 }
    );
  }

  const workspaceId = scopedReq.board?.workspace_id;
  if (!workspaceId) {
    return Response.json(
      { name: 'board-not-found', data: { message: 'Board not found' } },
      { status: 404 }
    );
  }

  const managerError = await requireBoardMemberManager(scopedReq, boardId, currentUserId);
  if (managerError) return managerError;

  const result = await db.transaction(async (trx) => {
    await lockWorkspaceMembershipMutations(trx, workspaceId);
    await lockBoardMemberMutations(trx, boardId);

    const reauthorizationError = await requireBoardMemberManager(
      scopedReq,
      boardId,
      currentUserId,
      trx
    );
    if (reauthorizationError) return reauthorizationError;

    const existing = await trx('board_members')
      .where({ board_id: boardId, user_id: userId })
      .first();
    if (!existing) {
      return Response.json(
        {
          name: 'board-member-not-found',
          data: { message: 'This user is not a member of the board' },
        },
        { status: 404 }
      );
    }

    // [deny-first] Prevent removing the last ADMIN — board must always have at least one.
    // Share the update handler's per-board transaction lock so demotions and
    // removals cannot independently pass the invariant check.
    const targetWorkspaceRole = await getCurrentWorkspaceRole(trx, workspaceId, userId);
    const targetIsEligibleAdmin =
      existing.role === 'ADMIN' && targetWorkspaceRole !== null && targetWorkspaceRole !== 'GUEST';
    if (targetIsEligibleAdmin) {
      const count = await countEligibleBoardAdmins(trx, boardId, workspaceId);
      if (count <= 1) {
        return Response.json(
          {
            name: 'last-board-admin',
            data: {
              message: 'Cannot remove the last board admin. Promote another member to ADMIN first.',
            },
          },
          { status: 409 }
        );
      }
    }

    await removeBoardUserAssignments(trx, [boardId], userId);
    await trx('board_members').where({ board_id: boardId, user_id: userId }).delete();
    return null;
  });

  if (result) return result;

  await writeEvent({
    type: 'board_member_removed',
    boardId,
    entityId: boardId,
    actorId: currentUserId,
    payload: { userId },
  });

  return Response.json({ data: { boardId, userId, removed: true } });
}
