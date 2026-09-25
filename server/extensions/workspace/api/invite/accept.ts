// POST /api/v1/invites/:token/accept — accept an invite; caller must be authenticated.
import { authenticate, type AuthenticatedRequest } from '../../../auth/middlewares/authentication';
import { validateInvite } from '../../mods/invite/validate';
import { consumeInvite } from '../../mods/invite/consume';
import { writeEvent } from '../../../../mods/events/index';
import { db } from '../../../../common/db';

export async function handleAcceptInvite(req: Request, token: string): Promise<Response> {
  const authError = await authenticate(req as AuthenticatedRequest);
  if (authError) return authError;

  const { currentUser } = req as AuthenticatedRequest;
  if (!currentUser) {
    return Response.json(
      { error: { code: 'unauthorized', message: 'Authentication required' } },
      { status: 401 },
    );
  }

  const result = await validateInvite({ token });

  if (!result.ok) {
    if (result.reason === 'not-found') {
      return Response.json(
        { error: { code: 'invite-not-found', message: 'Invite not found' } },
        { status: 404 },
      );
    }
    if (result.reason === 'invite-expired') {
      return Response.json(
        { error: { code: 'invite-expired', message: 'Invite has expired' } },
        { status: 410 },
      );
    }
    if (result.reason === 'invite-already-used') {
      return Response.json(
        { error: { code: 'invite-already-used', message: 'Invite has already been used' } },
        { status: 409 },
      );
    }
  }

  const { invite } = result as Extract<typeof result, { ok: true }>;

  if (invite.invited_email.trim().toLowerCase() !== currentUser.email.trim().toLowerCase()) {
    return Response.json(
      { error: { code: 'invite-email-mismatch', message: 'This invite belongs to another email address' } },
      { status: 403 },
    );
  }

  const consumed = await consumeInvite({ invite, userId: currentUser.id });
  if (!consumed) {
    return Response.json(
      { error: { code: 'invite-already-used', message: 'Invite has already been used or expired' } },
      { status: 409 },
    );
  }

  // Emit real-time event so connected clients learn about the new workspace member (§8).
  // Resolve displayName from the users table since the JWT only carries id + email.
  const user = await db('users').where({ id: currentUser.id }).first();
  const displayName = (user?.name as string | undefined) ?? currentUser.email;
  await writeEvent({
    type: 'member_joined',
    boardId: null,
    entityId: invite.workspace_id,
    actorId: currentUser.id,
    payload: {
      scope: 'workspace',
      userId: currentUser.id,
      displayName,
      role: invite.role,
      joinedAt: new Date().toISOString(),
    },
  });

  return Response.json({
    data: {
      workspace_id: invite.workspace_id,
      role: invite.role,
    },
  });
}
