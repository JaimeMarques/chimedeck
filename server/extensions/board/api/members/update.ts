// PATCH /api/v1/boards/:id/members/:userId — update a board member's role.
// Requires workspace ADMIN+.
// Invariant: the last ADMIN on the board cannot be demoted.
// Body: { role: 'ADMIN' | 'MEMBER' }
import { db } from '../../../../common/db';
import type { BoardVisibilityScopedRequest } from '../../../../middlewares/boardVisibility';
import {
  requireRole,
  type WorkspaceScopedRequest,
} from '../../../../middlewares/permissionManager';
import { writeEvent } from '../../../../mods/events/index';
import type { AuthenticatedRequest } from '../../../auth/middlewares/authentication';
import { enforceLastBoardAdmin, LAST_BOARD_ADMIN_DEMOTE_MESSAGE } from './lastAdmin';

type BoardMemberRole = 'ADMIN' | 'MEMBER';
type BoardMemberRow = { board_id: string; user_id: string; role: string };
const VALID_ROLES = new Set<BoardMemberRole>(['ADMIN', 'MEMBER']);

export async function handleUpdateBoardMember(
  req: Request,
  boardId: string,
  userId: string,
): Promise<Response> {
  const scopedReq = req as BoardVisibilityScopedRequest;
  const currentUserId = (req as AuthenticatedRequest).currentUser?.id;

  if (!currentUserId) {
    return Response.json(
      { name: 'unauthorized', data: { message: 'Authentication required' } },
      { status: 401 },
    );
  }

  // Board membership can be managed by workspace ADMIN+ or explicit board
  // ADMIN/OWNER — the same policy POST /boards/:id/members applies. This route
  // is where callers are sent to change a role, so it must not be stricter
  // than the route that refers them here.
  const roleError = requireRole(scopedReq as WorkspaceScopedRequest, 'ADMIN');
  if (roleError) {
    const actingBoardMember = await db<BoardMemberRow>('board_members')
      .where({ board_id: boardId, user_id: currentUserId })
      .first();
    const actingBoardRole = actingBoardMember?.role;
    const isBoardAdmin = actingBoardRole === 'ADMIN' || actingBoardRole === 'OWNER';
    if (!isBoardAdmin) return roleError;
  }

  let body: { role?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { name: 'invalid-request-body', data: { message: 'Request body must be valid JSON' } },
      { status: 400 },
    );
  }

  if (!body.role || !VALID_ROLES.has(body.role as BoardMemberRole)) {
    return Response.json(
      { name: 'invalid-role', data: { message: 'role must be ADMIN or MEMBER' } },
      { status: 400 },
    );
  }

  const newRole = body.role as BoardMemberRole;

  const existing = await db('board_members').where({ board_id: boardId, user_id: userId }).first();
  if (!existing) {
    return Response.json(
      { name: 'board-member-not-found', data: { message: 'This user is not a member of the board' } },
      { status: 404 },
    );
  }

  // [deny-first] Prevent demoting the last ADMIN — board must always have at
  // least one. The guard and the write share a transaction under a per-board
  // lock, so two concurrent demotions cannot both see a safe count.
  const updated = await enforceLastBoardAdmin(boardId, userId, newRole, async (trx) => {
    await trx('board_members')
      .where({ board_id: boardId, user_id: userId })
      .update({ role: newRole, updated_at: new Date().toISOString() });
    return true;
  });

  if (updated === null) {
    return Response.json(
      { name: 'last-board-admin', data: { message: LAST_BOARD_ADMIN_DEMOTE_MESSAGE } },
      { status: 409 },
    );
  }

  const member = await db('board_members as bm')
    .join('users as u', 'bm.user_id', 'u.id')
    .where({ 'bm.board_id': boardId, 'bm.user_id': userId })
    .select(
      db.raw('u.id as id'),
      'u.email',
      db.raw("COALESCE(u.name, u.email) as name"),
      'u.nickname',
      'bm.role',
      'bm.updated_at',
    )
    .first();

  writeEvent({
    type: 'board_member_role_updated',
    boardId,
    entityId: boardId,
    actorId: (req as AuthenticatedRequest).currentUser!.id,
    payload: { userId, role: newRole },
  }).catch(() => {});

  return Response.json({ data: member });
}
