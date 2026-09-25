// Encapsulates invite consumption: mark acceptedAt, create Membership, evict cache.
import { db } from '../../../../common/db';
import { memCache } from '../../../../mods/cache/index';
import { inviteConfig } from '../../common/config/invite';
import type { InviteRecord } from './validate';
import { lockWorkspaceMembershipMutations } from '../../api/members/lock';

interface ConsumeInviteParams {
  invite: InviteRecord;
  userId: string;
}

export async function consumeInvite({ invite, userId }: ConsumeInviteParams): Promise<boolean> {
  const consumed = await db.transaction(async (trx) => {
    await lockWorkspaceMembershipMutations(trx, invite.workspace_id);
    const existing = await trx('memberships')
      .where({ user_id: userId, workspace_id: invite.workspace_id })
      .first();
    // Guest conversion also needs board-grant reconciliation; keep the invite
    // unused and require the dedicated add-member promotion flow.
    if (existing?.role === 'GUEST') return false;

    // Atomically claim this single-use invite after acquiring the workspace lock.
    const claimed = await trx<InviteRecord>('invites')
      .where({ id: invite.id })
      .whereNull('accepted_at')
      .where('expires_at', '>', new Date())
      .update({ accepted_at: new Date() }, ['*']);
    const currentInvite = claimed[0];
    if (!currentInvite) return false;

    // Insert membership only when the user is not already a full member.
    if (!existing) {
      await trx('memberships').insert({
        user_id: userId,
        workspace_id: currentInvite.workspace_id,
        role: currentInvite.role,
      });
    }
    return true;
  });

  // Evict the token-keyed cache entry so validate() won't serve a stale hit.
  memCache.del(`${inviteConfig.cacheKeyPrefix}${invite.token}`);
  return consumed;
}
