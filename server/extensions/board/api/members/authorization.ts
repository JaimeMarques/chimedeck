import { db } from '../../../../common/db';
import type { Knex } from 'knex';
import type { BoardVisibilityScopedRequest } from '../../../../middlewares/boardVisibility';
import { resolveHighestRole } from '../../../../middlewares/permissionManager';

type BoardMemberManagerRow = { board_id: string; user_id: string; role: string };

export async function getCurrentWorkspaceRole(
  connection: Knex | Knex.Transaction,
  workspaceId: string,
  userId: string
) {
  const memberships = await connection('memberships')
    .where({ workspace_id: workspaceId, user_id: userId })
    .select('role');
  return resolveHighestRole(memberships.map((membership: { role: string }) => membership.role));
}

// Workspace ADMIN+ may manage every board. Lower workspace roles require an
// explicit ADMIN row on this board; GUEST never inherits privileges from a
// stale board_members row left behind by an earlier workspace membership.
export async function requireBoardMemberManager(
  scopedReq: BoardVisibilityScopedRequest,
  boardId: string,
  currentUserId: string,
  connection: Knex | Knex.Transaction = db
): Promise<Response | null> {
  const workspaceId = scopedReq.board?.workspace_id;
  const currentWorkspaceRole = workspaceId
    ? await getCurrentWorkspaceRole(connection, workspaceId, currentUserId)
    : null;
  if (currentWorkspaceRole === 'OWNER' || currentWorkspaceRole === 'ADMIN') return null;

  const forbidden = Response.json(
    {
      error: {
        code: 'insufficient-role',
        message: 'Requires ADMIN role or higher',
        requiredRole: 'ADMIN',
        currentRole: currentWorkspaceRole,
      },
    },
    { status: 403 }
  );
  if (!currentWorkspaceRole || currentWorkspaceRole === 'GUEST') return forbidden;

  const actingBoardMember = await connection<BoardMemberManagerRow>('board_members')
    .where({ board_id: boardId, user_id: currentUserId })
    .select('role')
    .first();

  return actingBoardMember?.role === 'ADMIN' ? null : forbidden;
}
