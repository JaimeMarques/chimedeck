// PATCH /api/v1/workspaces/:id/members/:userId — change a member's role; min role: ADMIN.
// Invariant: demoting the last OWNER returns 409.
import { db } from '../../../../common/db';
import { authenticate, type AuthenticatedRequest } from '../../../auth/middlewares/authentication';
import {
  requireWorkspaceMembership,
  requireRole,
  type WorkspaceScopedRequest,
  type Role,
  roleRank,
} from '../../../../middlewares/permissionManager';
import { getCurrentWorkspaceRole } from '../../../board/api/members/authorization';
import { lockWorkspaceMembershipMutations } from './lock';

const VALID_ROLES: Role[] = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'];

export async function handleUpdateMemberRole(
  req: Request,
  workspaceId: string,
  userId: string,
): Promise<Response> {
  const authError = await authenticate(req as AuthenticatedRequest);
  if (authError) return authError;

  const scopedReq = req as WorkspaceScopedRequest;
  const membershipError = await requireWorkspaceMembership(scopedReq, workspaceId);
  if (membershipError) return membershipError;

  const roleError = requireRole(scopedReq, 'ADMIN');
  if (roleError) return roleError;

  let body: { role?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json(
      { error: { code: 'bad-request', message: 'Invalid JSON body' } },
      { status: 400 },
    );
  }

  if (!body.role || !VALID_ROLES.includes(body.role as Role)) {
    return Response.json(
      { error: { code: 'bad-request', message: `role must be one of: ${VALID_ROLES.join(', ')}` } },
      { status: 400 },
    );
  }

  const newRole = body.role as Role;
  const currentUserId = scopedReq.currentUser?.id;
  if (!currentUserId) {
    return Response.json(
      { error: { code: 'unauthorized', message: 'Authentication required' } },
      { status: 401 },
    );
  }
  const result = await db.transaction(async (trx) => {
    await lockWorkspaceMembershipMutations(trx, workspaceId);
    const currentRole = await getCurrentWorkspaceRole(trx, workspaceId, currentUserId);
    if (currentRole !== 'OWNER' && currentRole !== 'ADMIN') {
      return Response.json(
        { error: { code: 'forbidden', message: 'Requires ADMIN role or higher' } },
        { status: 403 },
      );
    }

    const targetMembership = await trx('memberships')
      .where({ user_id: userId, workspace_id: workspaceId })
      .first();
    if (!targetMembership) {
      return Response.json(
        { error: { code: 'member-not-found', message: 'User is not a member of this workspace' } },
        { status: 404 },
      );
    }

    if (targetMembership.role === 'GUEST') {
      return Response.json(
        { error: { code: 'guest-promotion-requires-add-member', message: 'Promote guests through the add-member flow' } },
        { status: 409 },
      );
    }

    if (
      roleRank(newRole) > roleRank(currentRole) ||
      roleRank(targetMembership.role as Role) > roleRank(currentRole)
    ) {
      return Response.json(
        { error: { code: 'role-exceeds-caller-privilege', message: 'You cannot assign or modify a role higher than your own' } },
        { status: 403 },
      );
    }

    if (targetMembership.role === 'OWNER' && newRole !== 'OWNER') {
      const ownerCount = await trx('memberships')
        .where({ workspace_id: workspaceId, role: 'OWNER' })
        .count('user_id as count')
        .first();
      if (Number(ownerCount?.count ?? 0) <= 1) {
        return Response.json(
          { error: { code: 'workspace-must-have-one-owner', message: 'A workspace must always have at least one Owner. Promote another member first.' } },
          { status: 422 },
        );
      }
    }

    const updated = await trx('memberships')
      .where({ user_id: userId, workspace_id: workspaceId })
      .update({ role: newRole }, ['*']);
    return updated[0];
  });

  if (result instanceof Response) return result;
  return Response.json({ data: result });
}
