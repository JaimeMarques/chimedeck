import { applyBoardVisibility } from '../../../middlewares/boardVisibility';
import { requireWorkspaceMembership, type WorkspaceScopedRequest } from '../../../middlewares/permissionManager';
import type { AuthenticatedRequest } from '../../auth/middlewares/authentication';

// Both raw and thumbnail proxies must apply the same board and draft-image
// boundaries. A comment image is private to its uploader until posted.
export async function authorizeAttachmentRead(
  req: Request,
  board: { id: string; workspace_id: string },
  attachment: { upload_context: string; comment_id: string | null; uploaded_by: string },
): Promise<Response | null> {
  const membershipError = await requireWorkspaceMembership(req as WorkspaceScopedRequest, board.workspace_id);
  if (membershipError) return membershipError;
  const visibilityError = await applyBoardVisibility(req, board.id);
  if (visibilityError) return visibilityError;
  if (attachment.upload_context === 'comment' && !attachment.comment_id &&
      attachment.uploaded_by !== (req as AuthenticatedRequest).currentUser?.id) {
    return Response.json({ error: { code: 'comment-image-draft-private', message: 'This image has not been posted' } }, { status: 403 });
  }
  return null;
}
