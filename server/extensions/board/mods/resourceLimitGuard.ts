import { env } from '../../../config/env';
import { buildLimitResponse, type LimitKey } from '../../../middlewares/limitGuard';
import { getCurrentTier } from '../../subscription/common/subscriptionRepo';

// Resolve the upstream plan before opening a membership transaction. The guard
// itself is synchronous so a lock holder never needs a second pool connection
// while other requests occupy the pool waiting for that same advisory lock.
export async function prepareBoardLimitGuard(workspaceId: string) {
  if (!env.SUBSCRIPTIONS_ENABLED) return (_key: LimitKey, _usage: number): Response | null => null;
  const tier = await getCurrentTier(workspaceId);
  return (key: LimitKey, usage: number): Response | null =>
    buildLimitResponse(tier, key, usage, workspaceId);
}
