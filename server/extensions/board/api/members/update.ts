// PATCH /api/v1/boards/:id/members/:userId — update a board member's role.
// Requires explicit board ADMIN or workspace ADMIN+.
// Invariant: the last ADMIN on the board cannot be demoted.
// Body: { role: 'ADMIN' | 'MEMBER' }
import { db } from '../../../../common/db';
import type { BoardVisibilityScopedRequest } from '../../../../middlewares/boardVisibility';
import { writeEvent } from '../../../../mods/events/index';
import type { AuthenticatedRequest } from '../../../auth/middlewares/authentication';
import { getCurrentWorkspaceRole, requireBoardMemberManager } from './authorization';
import { countEligibleBoardAdmins, lockBoardMemberMutations } from './lock';
import { normalizeBoardMemberRole } from './role';
import { lockWorkspaceMembershipMutations } from '../../../workspace/api/members/lock';

type UpdatedBoardMember = Record<string, unknown> | undefined;

export async function handleUpdateBoardMember(
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

  let body: { role?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { name: 'invalid-request-body', data: { message: 'Request body must be valid JSON' } },
      { status: 400 }
    );
  }

  const newRole = normalizeBoardMemberRole(body.role);
  if (newRole === null) {
    return Response.json(
      { name: 'invalid-role', data: { message: 'role must be ADMIN or MEMBER' } },
      { status: 400 }
    );
  }

  const result = await db.transaction(async (trx) => {
    await lockWorkspaceMembershipMutations(trx, workspaceId);
    await lockBoardMemberMutations(trx, boardId);

    // Re-check explicit board authority after acquiring the same lock used by
    // demotions/removals. A request queued behind its own revocation must not
    // continue with the role it held before waiting.
    const reauthorizationError = await requireBoardMemberManager(
      scopedReq,
      boardId,
      currentUserId,
      trx
    );
    if (reauthorizationError) return { response: reauthorizationError };

    const existing = await trx('board_members')
      .where({ board_id: boardId, user_id: userId })
      .first();
    if (!existing) {
      return {
        response: Response.json(
          {
            name: 'board-member-not-found',
            data: { message: 'This user is not a member of the board' },
          },
          { status: 404 }
        ),
      };
    }

    // [deny-first] Prevent demoting the last ADMIN — board must always have at least one.
    // The per-board transaction lock serializes this count with every ADMIN
    // demotion/removal, so concurrent requests cannot both pass on a stale count.
    const targetWorkspaceRole = await getCurrentWorkspaceRole(trx, workspaceId, userId);
    const targetIsEligibleAdmin =
      existing.role === 'ADMIN' && targetWorkspaceRole !== null && targetWorkspaceRole !== 'GUEST';
    if (targetIsEligibleAdmin && newRole !== 'ADMIN') {
      const count = await countEligibleBoardAdmins(trx, boardId, workspaceId);
      if (count <= 1) {
        return {
          response: Response.json(
            {
              name: 'last-board-admin',
              data: {
                message: 'Cannot demote the last board admin. Promote another member first.',
              },
            },
            { status: 409 }
          ),
        };
      }
    }

    await trx('board_members')
      .where({ board_id: boardId, user_id: userId })
      .update({ role: newRole, updated_at: new Date().toISOString() });

    const member = await trx('board_members as bm')
      .join('users as u', 'bm.user_id', 'u.id')
      .where({ 'bm.board_id': boardId, 'bm.user_id': userId })
      .select(
        trx.raw('u.id as id'),
        'u.email',
        trx.raw('COALESCE(u.name, u.email) as name'),
        'u.nickname',
        'bm.role',
        'bm.updated_at'
      )
      .first();

    return { member: member as UpdatedBoardMember };
  });

  if ('response' in result && result.response) return result.response;

  await writeEvent({
    type: 'board_member_role_updated',
    boardId,
    entityId: boardId,
    actorId: (req as AuthenticatedRequest).currentUser!.id,
    payload: { userId, role: newRole },
  });

  return Response.json({ data: result.member });
}
