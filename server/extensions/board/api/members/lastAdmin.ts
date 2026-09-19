// Shared last-board-admin invariant.
//
// A board must always keep at least one ADMIN. Five writers can break that:
//   PATCH  /api/v1/boards/:id/members/:userId        (demote)
//   DELETE /api/v1/boards/:id/members/:userId        (remove)
//   PUT    /1/boards/:id/members/:idMember           (Trello compat, demote)
//   DELETE /1/boards/:id/members/:idMember           (Trello compat, remove)
//   POST   /api/v1/workspaces/:id/members            (GUEST conversion upsert)
//
// The check alone is not enough. Reading the admin count and then mutating in
// a separate statement lets two concurrent demotions both observe count = 2
// and each conclude it is safe, leaving zero admins. So the check and the
// write must happen inside one transaction, serialised per board.
import type { Knex } from 'knex';
import { db } from '../../../../common/db';

type BoardMemberRow = { board_id: string; user_id: string; role: string };
type CountRow = { count: string | number };

export const LAST_BOARD_ADMIN_DEMOTE_MESSAGE =
  'Cannot demote the last board admin. Promote another member first.';

export const LAST_BOARD_ADMIN_REMOVE_MESSAGE =
  'Cannot remove the last board admin. Promote another member to ADMIN first.';

/**
 * Serialise all admin-count-sensitive work for one board.
 *
 * PostgreSQL transaction-scoped advisory locks are keyed by bigint, so the
 * board id is hashed with hashtextextended(). Concurrent callers for the same
 * board queue; different boards never contend. The lock is released when the
 * transaction ends, including on error.
 */
async function withBoardLock<T>(
  boardId: string,
  fn: (trx: Knex.Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [boardId]);
    return fn(trx);
  });
}

/**
 * True when this change would leave the board with no ADMIN.
 *
 * `nextRole` is the role the member would end up with; pass `null` when they
 * are being removed from the board entirely. Returns false when the member
 * does not exist, is not an ADMIN, or stays an ADMIN — callers handle the
 * not-found case themselves.
 *
 * Pass the transaction that will perform the write, so the decision and the
 * mutation cannot interleave with another request. Prefer
 * `enforceLastBoardAdmin` unless you are composing a larger transaction.
 */
export async function wouldRemoveLastBoardAdmin(
  boardId: string,
  userId: string,
  nextRole: string | null,
  trx: Knex | Knex.Transaction = db,
): Promise<boolean> {
  const existing = await trx<BoardMemberRow>('board_members')
    .where({ board_id: boardId, user_id: userId })
    .first<BoardMemberRow | undefined>();

  // Not a member, or not an admin: this change cannot remove the last admin.
  if (!existing || existing.role !== 'ADMIN') return false;

  // Still an admin afterwards: nothing is lost.
  if (nextRole === 'ADMIN') return false;

  const adminCount = await trx('board_members')
    .where({ board_id: boardId, role: 'ADMIN' })
    .count('id as count')
    .first<CountRow | undefined>();

  return Number(adminCount?.count ?? 0) <= 1;
}

/**
 * Run `mutate` only if it would not strip the board of its last ADMIN.
 *
 * The guard and the write share one transaction under a per-board advisory
 * lock, so the invariant holds under concurrency. Returns null when the change
 * was refused; otherwise returns whatever `mutate` returned.
 */
export async function enforceLastBoardAdmin<T>(
  boardId: string,
  userId: string,
  nextRole: string | null,
  mutate: (trx: Knex.Transaction) => Promise<T>,
): Promise<T | null> {
  return withBoardLock(boardId, async (trx) => {
    if (await wouldRemoveLastBoardAdmin(boardId, userId, nextRole, trx)) return null;
    return mutate(trx);
  });
}

/**
 * Same guarantee for a writer that touches many boards at once: the whole set
 * is evaluated and written under one transaction, with each board locked in a
 * stable order so concurrent multi-board writers cannot deadlock.
 *
 * Returns the ids of boards whose change was refused; the rest are mutated.
 */
export async function enforceLastBoardAdminAcrossBoards(
  boardIds: string[],
  userId: string,
  nextRole: string | null,
  mutate: (trx: Knex.Transaction, allowedBoardIds: string[]) => Promise<void>,
): Promise<string[]> {
  const ordered = [...new Set(boardIds)].sort();
  if (ordered.length === 0) return [];

  return db.transaction(async (trx) => {
    for (const boardId of ordered) {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [boardId]);
    }

    const refused: string[] = [];
    const allowed: string[] = [];
    for (const boardId of ordered) {
      if (await wouldRemoveLastBoardAdmin(boardId, userId, nextRole, trx)) refused.push(boardId);
      else allowed.push(boardId);
    }

    if (allowed.length > 0) await mutate(trx, allowed);
    return refused;
  });
}
