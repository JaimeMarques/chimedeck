import type { Knex } from 'knex';

const WORKSPACE_MEMBERSHIP_LOCK_NAMESPACE = 'workspace-memberships';

// All membership changes and board-member writes acquire this lock before any
// board lock. The single order prevents stale-role authorization, orphan rows,
// and workspace↔board lock-order deadlocks.
export async function lockWorkspaceMembershipMutations(
  trx: Knex.Transaction,
  workspaceId: string
): Promise<void> {
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [
    `${WORKSPACE_MEMBERSHIP_LOCK_NAMESPACE}:${workspaceId}`,
  ]);
}
