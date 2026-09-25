import type { Knex } from 'knex';
import { db } from '../../common/db';
import { resolveHighestRole } from '../../middlewares/permissionManager';

export type BoardAccessRow = {
  id: string;
  workspace_id: string;
  visibility: 'PUBLIC' | 'PRIVATE' | 'WORKSPACE';
};

export async function canUserAccessBoard(
  userId: string,
  board: BoardAccessRow,
  connection: Knex | Knex.Transaction = db,
  options: { allowPublicOutsider?: boolean } = { allowPublicOutsider: true }
): Promise<boolean> {
  const rawMemberships: unknown = await connection('memberships')
    .where({ user_id: userId, workspace_id: board.workspace_id })
    .select('role');
  const roles = Array.isArray(rawMemberships)
    ? rawMemberships.flatMap((membership: unknown) => {
        if (
          typeof membership === 'object' &&
          membership !== null &&
          'role' in membership &&
          typeof membership.role === 'string'
        ) {
          return [membership.role];
        }
        return [];
      })
    : [];
  const workspaceRole = resolveHighestRole(roles);

  if (workspaceRole === 'OWNER' || workspaceRole === 'ADMIN') return true;
  if (board.visibility === 'PUBLIC' && options.allowPublicOutsider !== false) return true;
  if (workspaceRole === 'GUEST') {
    const guestAccess = (await connection('board_guest_access')
      .where({ user_id: userId, board_id: board.id })
      .first()) as { id: string } | undefined;
    return Boolean(guestAccess);
  }
  if (!workspaceRole) return false;
  if (board.visibility === 'WORKSPACE' || board.visibility === 'PUBLIC') return true;

  const boardMember = (await connection('board_members')
    .where({ user_id: userId, board_id: board.id })
    .first()) as { id: string } | undefined;
  return Boolean(boardMember);
}

export async function canUserReceiveBoardWebhook(
  userId: string,
  board: BoardAccessRow,
  connection: Knex | Knex.Transaction = db
): Promise<boolean> {
  return canUserAccessBoard(userId, board, connection, { allowPublicOutsider: false });
}
