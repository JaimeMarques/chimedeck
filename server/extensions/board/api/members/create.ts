// POST /api/v1/boards/:id/members — add a workspace member to the board with an explicit role.
// Requires board ADMIN role (or workspace OWNER/ADMIN).
// Body: { userId?: string, email?: string, role?: 'ADMIN' | 'MEMBER' }
//
// Adding someone who is already a board member is a conflict, not a role change:
// a silent role update here would bypass the last-ADMIN guard that
// members/update.ts enforces on the dedicated role-change route.
import { randomUUID } from 'crypto';
import { db } from '../../../../common/db';
import type { AuthenticatedRequest } from '../../../auth/middlewares/authentication';
import type { BoardVisibilityScopedRequest } from '../../../../middlewares/boardVisibility';
import { dispatchEvent } from '../../../../mods/events/dispatch';
import { requireBoardMemberManager } from './authorization';
import { normalizeBoardMemberRole } from './role';
import { lockWorkspaceMembershipMutations } from '../../../workspace/api/members/lock';
import { lockBoardMemberMutations } from './lock';

export async function handleAddBoardMember(req: Request, boardId: string): Promise<Response> {
  const scopedReq = req as BoardVisibilityScopedRequest;
  const board = scopedReq.board!;
  const currentUserId = (req as AuthenticatedRequest).currentUser?.id;

  if (!currentUserId) {
    return Response.json(
      { name: 'unauthorized', data: { message: 'Authentication required' } },
      { status: 401 }
    );
  }

  const managerError = await requireBoardMemberManager(scopedReq, boardId, currentUserId);
  if (managerError) return managerError;

  let body: { userId?: string; email?: string; role?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { name: 'invalid-request-body', data: { message: 'Request body must be valid JSON' } },
      { status: 400 }
    );
  }

  let userId = typeof body.userId === 'string' ? body.userId : undefined;
  if (!userId && typeof body.email === 'string' && body.email.trim() !== '') {
    const user = await db('users').where({ email: body.email.trim().toLowerCase() }).first();
    userId = typeof user?.id === 'string' ? user.id : undefined;
    if (!userId) {
      return Response.json(
        { name: 'user-not-found', data: { message: 'No user found for the supplied email' } },
        { status: 404 }
      );
    }
  }
  if (!userId) {
    return Response.json(
      { name: 'missing-user-id', data: { message: 'userId or email is required' } },
      { status: 400 }
    );
  }

  const role = normalizeBoardMemberRole(body.role, 'MEMBER');
  if (role === null) {
    return Response.json(
      { name: 'invalid-role', data: { message: 'role must be ADMIN or MEMBER' } },
      { status: 400 }
    );
  }

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

    const freshManagerError = await requireBoardMemberManager(
      scopedReq,
      boardId,
      currentUserId,
      trx
    );
    if (freshManagerError) return { error: freshManagerError };

    // Target eligibility and insertion share the workspace lock with removals.
    const workspaceMembership = await trx('memberships')
      .where({ user_id: userId, workspace_id: board.workspace_id })
      .whereNot('role', 'GUEST')
      .first();
    if (!workspaceMembership) {
      return {
        error: Response.json(
          {
            name: 'user-not-workspace-member',
            data: { message: 'User must be a workspace member before being added to a board' },
          },
          { status: 422 }
        ),
      };
    }

    const inserted = await trx('board_members')
      .insert({ id: randomUUID(), board_id: boardId, user_id: userId, role })
      .onConflict(['board_id', 'user_id'])
      .ignore()
      .returning('id');
    if (inserted.length === 0) {
      return {
        error: Response.json(
          {
            name: 'board-member-exists',
            data: {
              message:
                'User is already a member of this board. Use PATCH /api/v1/boards/:boardId/members/:userId to change their role.',
            },
          },
          { status: 409 }
        ),
      };
    }

    const member = await trx('board_members as bm')
      .join('users as u', 'bm.user_id', 'u.id')
      .where({ 'bm.board_id': boardId, 'bm.user_id': userId })
      .select(
        trx.raw('u.id as id'),
        'u.email',
        trx.raw('COALESCE(u.name, u.email) as name'),
        'u.nickname',
        'bm.role',
        'bm.created_at'
      )
      .first();
    return { member };
  });

  if ('error' in result && result.error) return result.error;
  const { member } = result;

  await dispatchEvent({
    type: 'board_member_added',
    boardId,
    entityId: boardId,
    actorId: currentUserId,
    // memberId is the automation contract; userId preserves the existing
    // realtime/webhook payload contract.
    payload: { memberId: userId, userId, role },
  });

  return Response.json({ data: member }, { status: 201 });
}
