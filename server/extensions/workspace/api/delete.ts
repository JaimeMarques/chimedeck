// DELETE /api/v1/workspaces/:id — delete workspace; min role: OWNER.
import { db } from '../../../common/db';
import { authenticate, type AuthenticatedRequest } from '../../auth/middlewares/authentication';
import {
  requireWorkspaceMembership,
  requireRole,
  type WorkspaceScopedRequest,
} from '../../../middlewares/permissionManager';
import { getCurrentWorkspaceRole } from '../../board/api/members/authorization';
import { lockWorkspaceMembershipMutations } from './members/lock';

export async function handleDeleteWorkspace(req: Request, workspaceId: string): Promise<Response> {
  const authError = await authenticate(req as AuthenticatedRequest);
  if (authError) return authError;

  const scopedReq = req as WorkspaceScopedRequest;
  const membershipError = await requireWorkspaceMembership(scopedReq, workspaceId);
  if (membershipError) return membershipError;

  const roleError = requireRole(scopedReq, 'OWNER');
  if (roleError) return roleError;

  const result = await db.transaction(async (trx) => {
    await lockWorkspaceMembershipMutations(trx, workspaceId);
    const currentRole = await getCurrentWorkspaceRole(
      trx,
      workspaceId,
      (req as AuthenticatedRequest).currentUser!.id,
    );
    if (currentRole !== 'OWNER') return { authorized: false, deleted: 0 };
    const deleted = await trx('workspaces').where({ id: workspaceId }).del();
    return { authorized: true, deleted };
  });

  if (!result.authorized) {
    return Response.json(
      { error: { code: 'insufficient-role', message: 'Requires OWNER role' } },
      { status: 403 },
    );
  }

  if (!result.deleted) {
    return Response.json(
      { error: { code: 'workspace-not-found', message: 'Workspace not found' } },
      { status: 404 },
    );
  }

  return new Response(null, { status: 204 });
}
