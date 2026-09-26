// Encapsulates invite creation: generate token, persist to DB, store in cache.
import { randomUUID } from 'crypto';
import { db } from '../../../../common/db';
import { memCache } from '../../../../mods/cache/index';
import { inviteConfig } from '../../common/config/invite';
import { roleRank, type Role } from '../../../../middlewares/permissionManager';
import { getCurrentWorkspaceRole } from '../../../board/api/members/authorization';
import { lockWorkspaceMembershipMutations } from '../../api/members/lock';

interface CreateInviteParams {
  workspaceId: string;
  invitedEmail: string;
  role: Role;
  actorId: string;
}

interface CreatedInvite {
  id: string;
  token: string;
  expiresAt: Date;
}

export async function createInvite({
  workspaceId,
  invitedEmail,
  role,
  actorId,
}: CreateInviteParams): Promise<CreatedInvite> {
  const id = randomUUID();
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + inviteConfig.ttlSeconds * 1000);

  const allowed = await db.transaction(async (trx) => {
    await lockWorkspaceMembershipMutations(trx, workspaceId);
    const actorRole = await getCurrentWorkspaceRole(trx, workspaceId, actorId);
    if (!actorRole || roleRank(actorRole) < roleRank('ADMIN') || roleRank(role) > roleRank(actorRole)) {
      return false;
    }
    await trx('invites').insert({
      id,
      workspace_id: workspaceId,
      invited_email: invitedEmail,
      token,
      role,
      expires_at: expiresAt,
    });
    return true;
  });
  if (!allowed) throw new InviteRoleForbiddenError();

  // Fast-path: cache the token so validation skips a DB round-trip.
  memCache.set(
    `${inviteConfig.cacheKeyPrefix}${token}`,
    JSON.stringify({ id, workspaceId, invitedEmail, role, expiresAt: expiresAt.toISOString() }),
    inviteConfig.ttlSeconds,
  );

  return { id, token, expiresAt };
}

export class InviteRoleForbiddenError extends Error {
  constructor() {
    super('The current user cannot create this invite');
    this.name = 'InviteRoleForbiddenError';
  }
}
