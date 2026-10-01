// DELETE /api/v1/lists/:id — hard-delete a list (cascades cards); min role: ADMIN.
// Requires confirm:true in the request body when the list contains cards.
import { db } from '../../../common/db';
import { authenticate, type AuthenticatedRequest } from '../../auth/middlewares/authentication';
import { writeEvent } from '../../../mods/events/write';
import {
  requireWorkspaceMembership,
  requireRole,
  type WorkspaceScopedRequest,
} from '../../../middlewares/permissionManager';
import { requireBoardWritable, type BoardScopedRequest } from '../../board/middlewares/requireBoardWritable';
import { featureFlags } from '../../../config/featureFlags';
import { syncStateTransitionsOnListDelete } from '../../stateTransitions/hooks/listSync';

type ListRow = {
  id: string;
  board_id: string;
};

type AuthenticatedBoardRequest = AuthenticatedRequest & BoardScopedRequest & {
  board: NonNullable<BoardScopedRequest['board']>;
  currentUser: { id: string };
};

export async function handleDeleteList(req: Request, listId: string): Promise<Response> {
  const authError = await authenticate(req as AuthenticatedRequest);
  if (authError) return authError;

  const list = await db<ListRow>('lists').where({ id: listId }).first();
  if (!list) {
    return Response.json(
      { error: { code: 'list-not-found', message: 'List not found' } },
      { status: 404 },
    );
  }

  const boardReq = req as BoardScopedRequest;
  const writableError = await requireBoardWritable(boardReq, list.board_id);
  if (writableError) return writableError;

  const board = boardReq.board as NonNullable<BoardScopedRequest['board']>;

  const scopedReq = req as WorkspaceScopedRequest;
  const membershipError = await requireWorkspaceMembership(scopedReq, board.workspace_id);
  if (membershipError) return membershipError;

  const roleError = requireRole(scopedReq, 'ADMIN');
  if (roleError) return roleError;

  // Parse request body — DELETE with a body is valid per HTTP spec.
  let body: { confirm?: boolean } = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text) as typeof body;
  } catch {
    // Treat unparseable body as no confirmation.
  }

  // Count and delete under one row lock on the list. Card inserts/moves into this list
  // take a FK KEY SHARE lock on the list row, which conflicts with FOR UPDATE, so no card
  // can land between the confirmation check and the cascading delete.
  const confirmationResponse = await db.transaction(async (trx) => {
    const lockedList = await trx<ListRow>('lists').where({ id: listId }).forUpdate().first();
    if (!lockedList) return null;
    // PUT /lists/:id/idBoard may have moved the list after authorization; never delete it there.
    if (lockedList.board_id !== list.board_id) {
      return Response.json(
        { error: { code: 'target-list-changed', message: 'List changed; reload and retry' } },
        { status: 409 },
      );
    }

    // Count cards in the list to determine if confirmation is required.
    const cardRows = await trx('cards').where({ list_id: listId }).count('id as count').first();
    const cardCount = Number(cardRows?.count ?? 0);

    if (cardCount > 0 && !body.confirm) {
      return Response.json(
        { name: 'delete-requires-confirmation', data: { cardCount } },
        { status: 409 },
      );
    }

    await trx('lists').where({ id: listId }).del();
    return null;
  });
  if (confirmationResponse) return confirmationResponse;

  if (featureFlags.STATE_TRANSITIONS_ENABLED) {
    await syncStateTransitionsOnListDelete(list.board_id);
  }

  // Stub event emission.
  const authenticatedRequest = req as AuthenticatedBoardRequest;
  await writeEvent({ type: 'list_deleted', boardId: list.board_id, entityId: listId, actorId: authenticatedRequest.currentUser.id, payload: {} });

  return new Response(null, { status: 204 });
}
