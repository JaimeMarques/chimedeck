// DELETE /api/v1/boards/:id — hard-delete a board; min role: ADMIN.
// Requires confirm:true in the request body when the board contains lists or cards.
import { db } from '../../../common/db';
import { authenticate, type AuthenticatedRequest } from '../../auth/middlewares/authentication';
import { publishBoardDeleted } from '../../events/mods/publishBoardDeleted';
import {
  requireWorkspaceMembership,
  requireRole,
  type WorkspaceScopedRequest,
} from '../../../middlewares/permissionManager';
import { guestGuard } from '../../../middlewares/guestGuard';
import { getCurrentWorkspaceRole } from './members/authorization';
import { lockBoardMemberMutations } from './members/lock';
import { lockWorkspaceMembershipMutations } from '../../workspace/api/members/lock';

export async function handleDeleteBoard(req: Request, boardId: string): Promise<Response> {
  const authError = await authenticate(req as AuthenticatedRequest);
  if (authError) return authError;

  const board = await db('boards').where({ id: boardId }).first();
  if (!board) {
    return Response.json(
      { error: { code: 'board-not-found', message: 'Board not found' } },
      { status: 404 },
    );
  }

  const scopedReq = req as WorkspaceScopedRequest;
  const membershipError = await requireWorkspaceMembership(scopedReq, board.workspace_id);
  if (membershipError) return membershipError;

  const guestError = guestGuard(scopedReq);
  if (guestError) return guestError;

  const roleError = requireRole(scopedReq, 'ADMIN');
  if (roleError) return roleError;

  let body: { confirm?: boolean } = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text) as typeof body;
  } catch {
    // Treat unparseable body as no confirmation.
  }

  const actorId = (req as AuthenticatedRequest).currentUser?.id;
  if (!actorId) {
    return Response.json(
      { error: { code: 'unauthorized', message: 'Authentication required' } },
      { status: 401 },
    );
  }

  let recipientIds: string[] = [];
  const deleteError = await db.transaction(async (trx) => {
    await lockWorkspaceMembershipMutations(trx, board.workspace_id);
    await lockBoardMemberMutations(trx, boardId);
    const freshBoard = await trx('boards')
      .where({ id: boardId, workspace_id: board.workspace_id })
      .forUpdate()
      .first();
    if (!freshBoard) {
      return Response.json(
        { error: { code: 'board-not-found', message: 'Board not found' } },
        { status: 404 },
      );
    }
    const currentRole = await getCurrentWorkspaceRole(
      trx,
      board.workspace_id,
      actorId,
    );
    if (currentRole !== 'OWNER' && currentRole !== 'ADMIN') {
      return Response.json(
        { error: { code: 'insufficient-role', message: 'Requires ADMIN role or higher' } },
        { status: 403 },
      );
    }
    const listRows = await trx('lists').where({ board_id: boardId }).count('id as count').first();
    const cardRows = await trx('cards')
      .whereIn('list_id', trx('lists').where({ board_id: boardId }).select('id'))
      .count('id as count')
      .first();
    const listCount = Number(listRows?.count ?? 0);
    const cardCount = Number(cardRows?.count ?? 0);
    if ((listCount > 0 || cardCount > 0) && !body.confirm) {
      return Response.json(
        { name: 'delete-requires-confirmation', data: { listCount, cardCount } },
        { status: 409 },
      );
    }
    const guestRows = (await trx('board_guest_access')
      .where({ board_id: boardId })
      .select('user_id')) as Array<{ user_id: string }>;
    if (freshBoard.visibility === 'PRIVATE') {
      const recipients = (await trx('memberships as m')
        .leftJoin('board_members as bm', function joinBoardMember() {
          this.on('bm.user_id', '=', 'm.user_id').andOnVal('bm.board_id', '=', boardId);
        })
        .leftJoin('board_guest_access as bga', function joinGuest() {
          this.on('bga.user_id', '=', 'm.user_id').andOnVal('bga.board_id', '=', boardId);
        })
        .where('m.workspace_id', board.workspace_id)
        .andWhere(function authorizedPrivateRecipient() {
          this.whereIn('m.role', ['OWNER', 'ADMIN'])
            .orWhereNotNull('bm.user_id')
            .orWhereNotNull('bga.user_id');
        })
        .distinct('m.user_id')) as Array<{ user_id: string }>;
      recipientIds = recipients.map((recipient) => recipient.user_id);
    } else {
      const recipients = (await trx('memberships')
        .where({ workspace_id: board.workspace_id })
        .select('user_id')) as Array<{ user_id: string }>;
      recipientIds = recipients.map((recipient) => recipient.user_id);
    }
    const deleted = await trx('boards')
      .where({ id: boardId, workspace_id: board.workspace_id })
      .del();
    if (!deleted) {
      return Response.json(
        { error: { code: 'board-not-found', message: 'Board not found' } },
        { status: 404 },
      );
    }
    for (const guest of guestRows) {
      const remainingGrant = await trx('board_guest_access as bga')
        .join('boards as b', 'b.id', 'bga.board_id')
        .where({ 'b.workspace_id': board.workspace_id, 'bga.user_id': guest.user_id })
        .first();
      if (!remainingGrant) {
        await trx('memberships')
          .where({ workspace_id: board.workspace_id, user_id: guest.user_id, role: 'GUEST' })
          .delete();
      }
    }
    return null;
  });
  if (deleteError) return deleteError;

  // Publish board_deleted event and notify all workspace members in real-time.
  await publishBoardDeleted({
    boardId,
    workspaceId: board.workspace_id,
    actorId,
    recipientIds,
  });

  return new Response(null, { status: 204 });
}
