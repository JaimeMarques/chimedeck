// DELETE /api/v1/boards/:id/members/:userId — remove a member from the board.
// Requires workspace ADMIN+.
// Invariant: the last ADMIN on the board cannot be removed.
import { db } from '../../../../common/db';
import type { AuthenticatedRequest } from '../../../auth/middlewares/authentication';
import type { BoardVisibilityScopedRequest } from '../../../../middlewares/boardVisibility';
import {
  requireRole,
  type WorkspaceScopedRequest,
} from '../../../../middlewares/permissionManager';
import { writeEvent } from '../../../../mods/events/index';
import { enforceLastBoardAdmin, LAST_BOARD_ADMIN_REMOVE_MESSAGE } from './lastAdmin';

export async function handleRemoveBoardMember(
  req: Request,
  boardId: string,
  userId: string,
): Promise<Response> {
  const scopedReq = req as BoardVisibilityScopedRequest;

  const roleError = requireRole(scopedReq as WorkspaceScopedRequest, 'ADMIN');
  if (roleError) return roleError;

  const existing = await db('board_members').where({ board_id: boardId, user_id: userId }).first();
  if (!existing) {
    return Response.json(
      { name: 'board-member-not-found', data: { message: 'This user is not a member of the board' } },
      { status: 404 },
    );
  }

  // [deny-first] Prevent removing the last ADMIN — board must always have at
  // least one. Guard and delete share a transaction under a per-board lock.
  const removed = await enforceLastBoardAdmin(boardId, userId, null, async (trx) => {
    await trx('board_members').where({ board_id: boardId, user_id: userId }).delete();
    return true;
  });

  if (removed === null) {
    return Response.json(
      { name: 'last-board-admin', data: { message: LAST_BOARD_ADMIN_REMOVE_MESSAGE } },
      { status: 409 },
    );
  }

  writeEvent({
    type: 'board_member_removed',
    boardId,
    entityId: boardId,
    actorId: (req as AuthenticatedRequest).currentUser!.id,
    payload: { userId },
  }).catch(() => {});

  return Response.json({ data: { boardId, userId, removed: true } });
}
