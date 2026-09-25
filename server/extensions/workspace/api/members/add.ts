// POST /api/v1/workspaces/:id/members — directly add an existing user by email; min role: MEMBER.
// Members may only assign roles equal to or less privileged than their own.
import { randomUUID } from 'crypto';
import { db } from '../../../../common/db';
import { authenticate, type AuthenticatedRequest } from '../../../auth/middlewares/authentication';
import {
  requireWorkspaceMembership,
  requireRole,
  roleRank,
  type WorkspaceScopedRequest,
  type Role,
} from '../../../../middlewares/permissionManager';
import { writeEvent } from '../../../../mods/events/index';
import { getCurrentWorkspaceRole } from '../../../board/api/members/authorization';
import { lockBoardMemberMutations } from '../../../board/api/members/lock';
import { lockWorkspaceMembershipMutations } from './lock';

const VALID_ROLES = new Set<Role>(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']);

export async function handleAddMember(req: Request, workspaceId: string): Promise<Response> {
  const authError = await authenticate(req as AuthenticatedRequest);
  if (authError) return authError;

  const scopedReq = req as WorkspaceScopedRequest;
  const membershipError = await requireWorkspaceMembership(scopedReq, workspaceId);
  if (membershipError) return membershipError;

  const roleError = requireRole(scopedReq, 'ADMIN');
  if (roleError) return roleError;
  const actorId = scopedReq.currentUser?.id;
  const callerRole = scopedReq.callerRole;
  if (!actorId || !callerRole) {
    return Response.json(
      { error: { code: 'unauthorized', message: 'Authentication required' } },
      { status: 401 },
    );
  }

  let body: { email?: string; role?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json(
      { error: { code: 'bad-request', message: 'Invalid JSON body' } },
      { status: 400 },
    );
  }

  if (!body.email || typeof body.email !== 'string') {
    return Response.json(
      { error: { code: 'bad-request', message: 'email is required' } },
      { status: 400 },
    );
  }

  const role: Role = (VALID_ROLES.has(body.role as Role) ? body.role : 'MEMBER') as Role;

  // Members can only assign roles that are equal to or less privileged than their own.
  if (roleRank(role) > roleRank(callerRole)) {
    return Response.json(
      { error: { code: 'role-exceeds-caller-privilege', message: `You cannot assign a role higher than your own (${callerRole})` } },
      { status: 403 },
    );
  }
  const email = body.email.trim().toLowerCase();

  // Look up the target user by email
  const user = await db('users').where({ email }).first();
  if (!user) {
    return Response.json(
      { error: { code: 'user-not-found', message: `No account found for ${email}. Ask them to sign up first.` } },
      { status: 404 },
    );
  }

  // Check if already a member
  const existing = await db('memberships')
    .where({ workspace_id: workspaceId, user_id: user.id })
    .first();

  if (existing) {
    if (existing.role === 'GUEST') {
      const boardRole = role === 'OWNER' || role === 'ADMIN' ? 'ADMIN' : 'MEMBER';
      const now = new Date().toISOString();

      const promotionError = await db.transaction(async (trx) => {
        await lockWorkspaceMembershipMutations(trx, workspaceId);
        const currentRole = await getCurrentWorkspaceRole(
          trx,
          workspaceId,
          actorId,
        );
        if (!currentRole || roleRank(currentRole) < roleRank('ADMIN')) {
          return Response.json(
            { error: { code: 'forbidden', message: 'Requires ADMIN role or higher' } },
            { status: 403 },
          );
        }
        if (roleRank(role) > roleRank(currentRole)) {
          return Response.json(
            { error: { code: 'role-exceeds-caller-privilege', message: `You cannot assign a role higher than your own (${currentRole})` } },
            { status: 403 },
          );
        }
        const freshExisting = await trx('memberships')
          .where({ workspace_id: workspaceId, user_id: user.id })
          .first();
        if (freshExisting?.role !== 'GUEST') {
          return Response.json(
            { error: { code: 'membership-changed', message: 'The target workspace membership changed; retry the request.' } },
            { status: 409 },
          );
        }
        const boards = await trx('boards')
          .join('board_guest_access', 'board_guest_access.board_id', 'boards.id')
          .where({
            'boards.workspace_id': workspaceId,
            'board_guest_access.user_id': user.id,
          })
          .select('boards.id')
          .orderBy('boards.id');
        const staleBoards = await trx('boards')
          .join('board_members', 'board_members.board_id', 'boards.id')
          .where({
            'boards.workspace_id': workspaceId,
            'board_members.user_id': user.id,
          })
          .select('boards.id');
        const lockedBoardIds = [...new Set([...boards, ...staleBoards].map((board) => board.id))].sort();
        for (const lockedBoardId of lockedBoardIds) {
          await lockBoardMemberMutations(trx, lockedBoardId);
        }

        // GUEST board-member rows are ineligible and may be stale. Remove all
        // of them before changing the workspace role so unrelated private-board
        // authority cannot reactivate, then recreate only explicit guest grants.
        if (lockedBoardIds.length > 0) {
          await trx('board_members')
            .where({ user_id: user.id })
            .whereIn('board_id', lockedBoardIds)
            .delete();
        }

        await trx('memberships')
          .where({ workspace_id: workspaceId, user_id: user.id })
          .update({ role });

        if (boards.length > 0) {
          await trx('board_members')
            .insert(
              boards.map((board) => ({
                id: randomUUID(),
                board_id: board.id,
                user_id: user.id,
                role: boardRole,
                created_at: now,
                updated_at: now,
              })),
            )
            .onConflict(['board_id', 'user_id'])
            .merge({ role: boardRole, updated_at: now });
        }

        await trx('board_guest_access')
          .where({ user_id: user.id })
          .whereIn(
            'board_id',
            trx('boards').where({ workspace_id: workspaceId }).select('id'),
          )
          .delete();
        return null;
      });
      if (promotionError) return promotionError;

      const member = {
        userId: user.id,
        email: user.email,
        name: user.name ?? user.email,
        role,
      };

      writeEvent({
        type: 'member_joined',
        boardId: null,
        entityId: workspaceId,
        actorId,
        payload: {
          scope: 'workspace',
          userId: user.id,
          displayName: (user.name as string | undefined) ?? user.email,
          role,
          joinedAt: new Date().toISOString(),
        },
      }).catch(() => {});

      return Response.json({ data: member });
    }

    return Response.json(
      { error: { code: 'already-a-member', message: `${email} is already a member of this workspace.` } },
      { status: 409 },
    );
  }

  const insertError = await db.transaction(async (trx) => {
    await lockWorkspaceMembershipMutations(trx, workspaceId);
    const currentRole = await getCurrentWorkspaceRole(
      trx,
      workspaceId,
      actorId,
    );
    if (!currentRole || roleRank(currentRole) < roleRank('ADMIN')) {
      return Response.json(
        { error: { code: 'forbidden', message: 'Requires ADMIN role or higher' } },
        { status: 403 },
      );
    }
    if (roleRank(role) > roleRank(currentRole)) {
      return Response.json(
        { error: { code: 'role-exceeds-caller-privilege', message: `You cannot assign a role higher than your own (${currentRole})` } },
        { status: 403 },
      );
    }
    const freshExisting = await trx('memberships')
      .where({ workspace_id: workspaceId, user_id: user.id })
      .first();
    if (freshExisting) {
      return Response.json(
        { error: { code: 'already-a-member', message: `${email} is already a member of this workspace.` } },
        { status: 409 },
      );
    }
    await trx('memberships').insert({ workspace_id: workspaceId, user_id: user.id, role });
    return null;
  });
  if (insertError) return insertError;

  const member = {
    userId: user.id,
    email: user.email,
    name: user.name ?? user.email,
    role,
  };

  // Emit real-time event so connected clients learn about the new workspace member (§8).
  writeEvent({
    type: 'member_joined',
    boardId: null,
    entityId: workspaceId,
    actorId,
    payload: {
      scope: 'workspace',
      userId: user.id,
      displayName: (user.name as string | undefined) ?? user.email,
      role,
      joinedAt: new Date().toISOString(),
    },
  }).catch(() => {});

  return Response.json({ data: member }, { status: 201 });
}
