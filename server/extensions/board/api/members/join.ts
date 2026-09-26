// POST /api/v1/boards/:id/members/join — self-join a board.
// Allows any non-GUEST workspace member to add themselves to a WORKSPACE or PUBLIC board
// so they appear in mention suggestions and the members list.
// PRIVATE boards are rejected — only admins can add members to those.
import { randomUUID } from 'node:crypto';
import { db } from '../../../../common/db';
import type { AuthenticatedRequest } from '../../../auth/middlewares/authentication';
import type { BoardVisibilityScopedRequest } from '../../../../middlewares/boardVisibility';
import { dispatchEvent } from '../../../../mods/events/dispatch';
import { lockWorkspaceMembershipMutations } from '../../../workspace/api/members/lock';
import { lockBoardMemberMutations } from './lock';

export async function handleJoinBoard(req: Request, boardId: string): Promise<Response> {
  const scopedReq = req as BoardVisibilityScopedRequest;
  const board = scopedReq.board!;
  const currentUser = (req as AuthenticatedRequest).currentUser!;

  const result = await db.transaction(async (trx) => {
    await lockWorkspaceMembershipMutations(trx, board.workspace_id);
    await lockBoardMemberMutations(trx, boardId);
    const freshBoard = await trx('boards')
      .where({ id: boardId, workspace_id: board.workspace_id })
      .first();
    if (!freshBoard) {
      return {
        error: Response.json(
          { error: { code: 'board-not-found', message: 'Board not found' } },
          { status: 404 }
        ),
      };
    }

    // Re-read membership after the workspace lock. A request queued behind
    // removal must not insert a board row using authority it no longer has.
    const membership = await trx('memberships')
      .where({ user_id: currentUser.id, workspace_id: board.workspace_id })
      .whereNot('role', 'GUEST')
      .first();

    if (!membership) {
      return {
        error: Response.json(
          {
            name: 'not-a-workspace-member',
            data: { message: 'You must be a workspace member to join this board.' },
          },
          { status: 403 }
        ),
      };
    }

    const isWorkspaceAdminOrOwner = membership.role === 'OWNER' || membership.role === 'ADMIN';
    if (freshBoard.visibility === 'PRIVATE' && !isWorkspaceAdminOrOwner) {
      return {
        error: Response.json(
          {
            name: 'board-is-private',
            data: {
              message:
                'You can only self-join WORKSPACE or PUBLIC boards. Ask a board admin to add you to this board.',
            },
          },
          { status: 403 }
        ),
      };
    }

    const inserted = await trx('board_members')
      .insert({
        id: randomUUID(),
        board_id: boardId,
        user_id: currentUser.id,
        role: 'MEMBER',
      })
      .onConflict(['board_id', 'user_id'])
      .ignore()
      .returning('id');
    const created = inserted.length > 0;

    const member = await trx('board_members as bm')
      .join('users as u', 'bm.user_id', 'u.id')
      .where({ 'bm.board_id': boardId, 'bm.user_id': currentUser.id })
      .select(
        trx.raw('u.id as id'),
        'u.email',
        trx.raw('COALESCE(u.name, u.email) as name'),
        'u.nickname',
        'bm.role',
        'bm.created_at'
      )
      .first();
    return { created, member };
  });

  if ('error' in result && result.error) return result.error;
  const { created, member } = result;

  if (created) {
    await dispatchEvent({
      type: 'board_member_added',
      boardId,
      entityId: boardId,
      actorId: currentUser.id,
      payload: { memberId: currentUser.id, userId: currentUser.id, role: 'MEMBER' },
    });
  }

  return Response.json({ data: member }, { status: created ? 201 : 200 });
}
