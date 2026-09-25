import { randomUUID } from 'crypto';
import { db } from '../../../common/db';
import { authenticate, type AuthenticatedRequest } from '../../auth/middlewares/authentication';
import {
  requireWorkspaceMembership,
  requireRole,
  type WorkspaceScopedRequest,
} from '../../../middlewares/permissionManager';

import { dispatchEvent } from '../../../mods/events/dispatch';
import type { BoardVisibility } from '../types';
import { sanitizeText, sanitizeRichText } from '../../../common/sanitize';
import { generateUniqueShortId } from '../../../common/ids/shortId';
import { getCurrentWorkspaceRole } from './members/authorization';
import { lockWorkspaceMembershipMutations } from '../../workspace/api/members/lock';

const VALID_VISIBILITY: BoardVisibility[] = ['PUBLIC', 'PRIVATE', 'WORKSPACE'];

export async function handleCreateBoard(req: Request, workspaceId: string): Promise<Response> {
  const authError = await authenticate(req as AuthenticatedRequest);
  if (authError) return authError;

  const scopedReq = req as WorkspaceScopedRequest;
  const membershipError = await requireWorkspaceMembership(scopedReq, workspaceId);
  if (membershipError) return membershipError;

  const roleError = requireRole(scopedReq, 'MEMBER');
  if (roleError) return roleError;

  let body: { title?: string; visibility?: BoardVisibility; description?: string; background?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json(
      { error: { code: 'bad-request', message: 'Invalid JSON body' } },
      { status: 400 },
    );
  }

  if (!body.title || typeof body.title !== 'string' || body.title.trim() === '') {
    return Response.json(
      { error: { code: 'bad-request', message: 'title is required' } },
      { status: 400 },
    );
  }

  if (body.visibility !== undefined && !VALID_VISIBILITY.includes(body.visibility)) {
    return Response.json(
      { error: { code: 'bad-request', message: "visibility must be 'PUBLIC', 'PRIVATE', or 'WORKSPACE'" } },
      { status: 400 },
    );
  }

  const creatorId = (req as AuthenticatedRequest).currentUser!.id;
  const title = body.title.trim();
  const id = randomUUID();
  const shortId = await generateUniqueShortId('boards');

  // Wrap board creation + initial member insert in a transaction so no partial state is persisted.
  const creationError = await db.transaction(async (trx) => {
    await lockWorkspaceMembershipMutations(trx, workspaceId);
    const currentRole = await getCurrentWorkspaceRole(trx, workspaceId, creatorId);
    if (currentRole !== 'OWNER' && currentRole !== 'ADMIN' && currentRole !== 'MEMBER') {
      return Response.json(
        { error: { code: 'forbidden', message: 'Requires MEMBER role or higher' } },
        { status: 403 },
      );
    }
    await trx('boards').insert({
      id,
      short_id: shortId,
      workspace_id: workspaceId,
      title: sanitizeText(title),
      state: 'ACTIVE',
      visibility: body.visibility ?? 'PRIVATE',
      description: body.description ? sanitizeRichText(body.description.trim()) : null,
      background: body.background?.trim() ?? null,
    });

    // Auto-insert the creator as ADMIN of the new board.
    await trx('board_members').insert({
      id: randomUUID(),
      board_id: id,
      user_id: creatorId,
      role: 'ADMIN',
    });
    return null;
  });
  if (creationError) return creationError;

  const board = await db('boards').where({ id }).first();

  // Stub event emission — replaced by activity log in sprint 10.
  await dispatchEvent({ type: 'board_created', boardId: id, entityId: id, actorId: creatorId, payload: { workspaceId } });

  return Response.json({ data: board }, { status: 201 });
}
