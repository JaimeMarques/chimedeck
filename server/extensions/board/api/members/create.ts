// POST /api/v1/boards/:id/members — add a workspace member to the board with an explicit role.
// Requires board ADMIN role (or workspace OWNER/ADMIN).
// Body: { userId?: string, email?: string, role?: 'ADMIN' | 'MEMBER' }
//
// The target may be identified by userId or by email — the MCP invite_to_board
// tool sends an email. userId wins when both are supplied.
//
// Adding someone who is already a board member is a conflict, not a role change:
// a silent role update here would bypass the last-ADMIN guard that
// members/update.ts enforces on the dedicated role-change route.
import { randomUUID } from 'crypto';
import { db } from '../../../../common/db';
import type { AuthenticatedRequest } from '../../../auth/middlewares/authentication';
import type { BoardVisibilityScopedRequest } from '../../../../middlewares/boardVisibility';
import {
  requireRole,
  type WorkspaceScopedRequest,
} from '../../../../middlewares/permissionManager';
import { dispatchEvent } from '../../../../mods/events/dispatch';

type BoardMemberRole = 'ADMIN' | 'MEMBER';
type UserRow = { id: string };
const VALID_ROLES = new Set<BoardMemberRole>(['ADMIN', 'MEMBER']);

// Callers send roles in mixed case (the MCP invite tool sends lowercase), so
// match case-insensitively and reject anything this table cannot store rather
// than silently coercing it to MEMBER.
function normalizeRole(value: unknown): BoardMemberRole | null {
  if (value === undefined || value === null) return 'MEMBER';
  if (typeof value !== 'string') return null;
  const upper = value.trim().toUpperCase();
  return VALID_ROLES.has(upper as BoardMemberRole) ? (upper as BoardMemberRole) : null;
}

export async function handleAddBoardMember(req: Request, boardId: string): Promise<Response> {
  const scopedReq = req as BoardVisibilityScopedRequest;
  const board = scopedReq.board!;
  const currentUserId = (req as AuthenticatedRequest).currentUser?.id;

  if (!currentUserId) {
    return Response.json(
      { name: 'unauthorized', data: { message: 'Authentication required' } },
      { status: 401 },
    );
  }

  // Board membership can be managed by workspace ADMIN+ or explicit board ADMIN/OWNER.
  const workspaceRoleError = requireRole(scopedReq as WorkspaceScopedRequest, 'ADMIN');
  if (workspaceRoleError) {
    const actingBoardMember = await db('board_members')
      .where({ board_id: boardId, user_id: currentUserId })
      .first();
    const actingBoardRole = actingBoardMember?.role as string | undefined;
    const isBoardAdmin = actingBoardRole === 'ADMIN' || actingBoardRole === 'OWNER';
    if (!isBoardAdmin) return workspaceRoleError;
  }

  let body: { userId?: string; email?: string; role?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { name: 'invalid-request-body', data: { message: 'Request body must be valid JSON' } },
      { status: 400 },
    );
  }

  // Identify the target by userId, or by email when no userId is supplied.
  //
  // The email lookup is scoped to the board's workspace and joined through
  // memberships, so an ineligible address and an unknown one are
  // indistinguishable to the caller: resolving globally would let a board admin
  // probe whether an arbitrary address has an account anywhere on the instance
  // (404 for no account vs 422 for an account outside the workspace).
  //
  // Comparison is case-insensitive on both sides. Registration and OAuth store
  // whatever casing the user supplied, and users.email is unique only on the
  // raw casing, so `Mixed@Example.com` must still be found by
  // `mixed@example.com` — and `Alice@example.com` and `alice@example.com` can
  // both exist. Where two accounts share a normalized address, there is no
  // correct answer and picking one could grant board ADMIN to the wrong
  // person, so the ambiguity is reported instead of resolved. Pass `userId` to
  // name the account explicitly.
  let userId = typeof body.userId === 'string' ? body.userId : undefined;
  if (!userId) {
    if (typeof body.email !== 'string' || body.email.trim() === '') {
      return Response.json(
        { name: 'missing-user-id', data: { message: 'userId or email is required' } },
        { status: 400 },
      );
    }

    const email = body.email.trim().toLowerCase();
    const matches = (await db('users as u')
      .join('memberships as m', 'm.user_id', 'u.id')
      .where('m.workspace_id', board.workspace_id)
      .whereNot('m.role', 'GUEST')
      .whereRaw('LOWER(u.email) = ?', [email])
      .distinct('u.id')
      .select('u.id')) as UserRow[];

    if (matches.length > 1) {
      return Response.json(
        {
          name: 'ambiguous-email',
          data: {
            message:
              'Several accounts in this workspace share that email address. Add the member by userId instead.',
          },
        },
        { status: 409 },
      );
    }

    const eligible = matches[0];
    if (!eligible) {
      return Response.json(
        {
          name: 'user-not-workspace-member',
          data: { message: 'User must be a workspace member before being added to a board' },
        },
        { status: 422 },
      );
    }

    userId = eligible.id;
  }

  const role = normalizeRole(body.role);
  if (role === null) {
    return Response.json(
      { name: 'invalid-role', data: { message: 'role must be ADMIN or MEMBER' } },
      { status: 400 },
    );
  }

  // Target user must be a workspace member (not a guest) to be added to a board.
  const workspaceMembership = await db('memberships')
    .where({ user_id: userId, workspace_id: board.workspace_id })
    .whereNot('role', 'GUEST')
    .first();

  if (!workspaceMembership) {
    return Response.json(
      { name: 'user-not-workspace-member', data: { message: 'User must be a workspace member before being added to a board' } },
      { status: 422 },
    );
  }

  // Adding an existing member is a conflict — changing a role goes through
  // PATCH /boards/:id/members/:userId, which enforces the last-ADMIN invariant.
  //
  // The insert is the authority, not a preceding read: board_members carries
  // UNIQUE (board_id, user_id) (migration 0040), so two concurrent adds would
  // both pass a read-then-insert check and one would surface 23505 as a 500.
  // ignore() turns the losing insert into zero rows, which we report as 409.
  const inserted = await db('board_members')
    .insert({
      id: randomUUID(),
      board_id: boardId,
      user_id: userId,
      role,
    })
    .onConflict(['board_id', 'user_id'])
    .ignore()
    .returning('id');

  if (inserted.length === 0) {
    return Response.json(
      {
        name: 'board-member-exists',
        data: {
          message:
            'User is already a member of this board. Use PATCH /api/v1/boards/:boardId/members/:userId to change their role.',
        },
      },
      { status: 409 },
    );
  }

  const member = await db('board_members as bm')
    .join('users as u', 'bm.user_id', 'u.id')
    .where({ 'bm.board_id': boardId, 'bm.user_id': userId })
    .select(
      db.raw('u.id as id'),
      'u.email',
      db.raw("COALESCE(u.name, u.email) as name"),
      'u.nickname',
      'bm.role',
      'bm.created_at',
    )
    .first();

  dispatchEvent({
    type: 'board_member_added',
    boardId,
    entityId: boardId,
    actorId: currentUserId,
    payload: { userId, role },
  }).catch(() => {});

  return Response.json({ data: member }, { status: 201 });
}
