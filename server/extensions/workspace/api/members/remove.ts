// DELETE /api/v1/workspaces/:id/members/:userId — remove member; min role: ADMIN.
// Invariant: cannot remove the last OWNER.
import { db } from '../../../../common/db';
import { authenticate, type AuthenticatedRequest } from '../../../auth/middlewares/authentication';
import {
  requireWorkspaceMembership,
  requireRole,
  type WorkspaceScopedRequest,
} from '../../../../middlewares/permissionManager';
import { getCurrentWorkspaceRole } from '../../../board/api/members/authorization';
import { lockWorkspaceMembershipMutations } from './lock';
import { removeWorkspaceMemberInTransaction } from './removeService';

export async function handleRemoveMember(
  req: Request,
  workspaceId: string,
  userId: string
): Promise<Response> {
  const authError = await authenticate(req as AuthenticatedRequest);
  if (authError) return authError;

  const scopedReq = req as WorkspaceScopedRequest;
  const membershipError = await requireWorkspaceMembership(scopedReq, workspaceId);
  if (membershipError) return membershipError;

  const roleError = requireRole(scopedReq, 'ADMIN');
  if (roleError) return roleError;

  const currentUserId = scopedReq.currentUser!.id;

  const mutationError = await db.transaction(async (trx) => {
    await lockWorkspaceMembershipMutations(trx, workspaceId);
    const currentRole = await getCurrentWorkspaceRole(trx, workspaceId, currentUserId);
    if (currentRole !== 'OWNER' && currentRole !== 'ADMIN') {
      return Response.json(
        {
          error: {
            code: 'forbidden',
            message: 'Requires ADMIN role or higher',
            requiredRole: 'ADMIN',
            currentRole,
          },
        },
        { status: 403 }
      );
    }
    return removeWorkspaceMemberInTransaction(trx, workspaceId, userId, currentUserId);
  });

  if (mutationError) return mutationError;

  return new Response(null, { status: 204 });
}
