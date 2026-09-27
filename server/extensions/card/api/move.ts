// PATCH /api/v1/cards/:id/move — move card to any accessible list (same or different board); min role: MEMBER.
import { db } from '../../../common/db';
import { authenticate, type AuthenticatedRequest } from '../../auth/middlewares/authentication';
import { dispatchEvent } from '../../../mods/events/dispatch';
import { publisher } from '../../../mods/pubsub/publisher';
import {
  requireWorkspaceMembership,
  requireMemberOrBoardGuestMember,
  resolveHighestRole,
  hasRole,
  type WorkspaceScopedRequest,
} from '../../../middlewares/permissionManager';
import { requireCardWritable, type CardScopedRequest } from '../middlewares/requireCardWritable';
import { applyBoardVisibility } from '../../../middlewares/boardVisibility';
import { between, HIGH_SENTINEL, generatePositions } from '../../list/mods/fractional';
import { recordConflict } from '../../realtime/mods/conflictHandler';
import { emitCardMoved } from '../../activity/mods/createActivityEvent';
import { StateTransitionForbiddenError } from '../../stateTransitions/common/errors';
import { emitCardMoveBlockedActivity } from '../../stateTransitions/common/activityLog';
import { validateGraphShape } from '../../stateTransitions/common/validator';
import { syncGraphWithLists } from '../../stateTransitions/common/sync';
import { deriveRulesFromGraph } from '../../stateTransitions/common/serializer';
import { featureFlags } from '../../../config/featureFlags';
import { lockWorkspaceMembershipMutations } from '../../workspace/api/members/lock';
import { lockBoardMemberMutations } from '../../board/api/members/lock';
import type { Knex } from 'knex';
import { buildAvatarProxyUrlsInCollection } from '../../../common/avatar/resolveAvatarUrl';
import { resolveCoverImageUrl } from '../../../common/cards/cover';

type MoveBody = { targetListId: string; afterCardId?: string | null };

type CardRow = {
  id: string;
  list_id: string;
  position: string;
  title: string;
  [key: string]: unknown;
};

type ListRow = {
  id: string;
  board_id: string;
  title?: string | null;
  archived?: boolean;
  [key: string]: unknown;
};

type BoardRow = {
  id: string;
  workspace_id: string;
  state: 'ACTIVE' | 'ARCHIVED';
  visibility: 'PRIVATE' | 'WORKSPACE' | 'PUBLIC';
};

function denied(code: string, message: string, status = 403): Response {
  return Response.json({ error: { code, message } }, { status });
}

// Run only after the workspace and board locks. The request's callerRole and
// guestType are snapshots from middleware and can be revoked while waiting.
async function authorizeBoardMove(trx: Knex.Transaction, board: BoardRow, userId: string, role: NonNullable<ReturnType<typeof resolveHighestRole>>): Promise<Response | null> {
  if (role === 'GUEST') {
    const grant = await trx('board_guest_access').where({ user_id: userId, board_id: board.id }).first() as { guest_type?: string } | undefined;
    return grant?.guest_type?.toUpperCase() === 'MEMBER'
      ? null : denied('insufficient-role', 'Requires at least MEMBER role');
  }
  if (!hasRole(role, 'MEMBER')) return denied('insufficient-role', 'Requires at least MEMBER role');
  if (board.visibility === 'PRIVATE' && role !== 'OWNER' && role !== 'ADMIN') {
    const member = await trx<{ user_id: string; board_id: string }>('board_members').where({ user_id: userId, board_id: board.id }).first();
    if (!member) return denied('board-access-denied', 'You do not have access to this board');
  }
  return null;
}

async function checkFreshTransition(trx: Knex.Transaction, boardId: string, sourceList: ListRow, targetList: ListRow): Promise<Response | null> {
  if (!featureFlags.STATE_TRANSITIONS_ENABLED || sourceList.id === targetList.id) return null;
  // Plain SELECT: transition UPDATE locks its row before its advisory-lock trigger.
  // A FOR SHARE here would invert that order and deadlock.
  const row = await trx('board_state_transitions').where({ board_id: boardId }).first() as { enabled: boolean; graph_data: unknown } | undefined;
  if (!row?.enabled) return null;
  const parsed = validateGraphShape(row.graph_data);
  if (!parsed.ok) return denied('state-transition-rules-invalid', 'Enabled board transition rules are invalid', 422);
  const activeLists = await trx('lists').where({ board_id: boardId, archived: false }).orderBy('position', 'asc').select('id', 'title') as Array<{ id: string; title: string }>;
  const graph = syncGraphWithLists(parsed.graph, activeLists).graph;
  if (!graph.nodes.some((node) => node.listId === sourceList.id)) return null;
  const rules = deriveRulesFromGraph(graph);
  const rule = rules.find((candidate) => candidate.current_state_id === sourceList.id);
  if (rule?.allowed_next_state_ids.includes(targetList.id)) return null;
  const names = new Map(graph.nodes.map((node) => [node.listId, node.label]));
  throw new StateTransitionForbiddenError({
    boardId, fromListId: sourceList.id, toListId: targetList.id,
    fromListName: names.get(sourceList.id) ?? sourceList.title ?? sourceList.id,
    toListName: names.get(targetList.id) ?? targetList.title ?? targetList.id,
    allowedNextStates: (rule?.allowed_next_state_ids ?? []).map((id) => ({ id, name: names.get(id) ?? id })),
  });
}

async function parseMoveBody(req: Request): Promise<MoveBody | Response> {
  try {
    const body = (await req.json()) as MoveBody;
    if (!body.targetListId) {
      return Response.json(
        { error: { code: 'bad-request', message: 'targetListId is required' } },
        { status: 400 },
      );
    }
    return body;
  } catch {
    return Response.json(
      { error: { code: 'bad-request', message: 'Invalid JSON body' } },
      { status: 400 },
    );
  }
}

async function validateMoveLists({
  card,
  targetListId,
}: {
  card: { list_id: string };
  targetListId: string;
}): Promise<{ targetList: ListRow; sourceList: ListRow } | Response> {
  const targetList = await db<ListRow>('lists').where({ id: targetListId }).first();
  if (!targetList) {
    return Response.json(
      { error: { code: 'target-list-not-found', message: 'Target list not found' } },
      { status: 404 },
    );
  }

  const sourceList = await db<ListRow>('lists').where({ id: card.list_id }).first();
  if (!sourceList) {
    return Response.json(
      { error: { code: 'source-list-not-found', message: 'Source list not found' } },
      { status: 404 },
    );
  }

  return { targetList, sourceList };
}

function resolveInsertIndex({
  afterCardId,
  targetCards,
}: {
  afterCardId: string | null | undefined;
  targetCards: CardRow[];
}): number | null {
  if (afterCardId === null) return 0;
  if (afterCardId === undefined) return targetCards.length;
  const afterIndex = targetCards.findIndex((c) => c.id === afterCardId);
  return afterIndex === -1 ? null : afterIndex + 1;
}

function computeStrictPositionBetween({ left, right }: { left: string; right: string }): string | null {
  try {
    const candidate = between(left, right);
    const leftOk = left === '' ? true : left < candidate;
    const rightOk = right === HIGH_SENTINEL ? candidate < HIGH_SENTINEL : candidate < right;
    return leftOk && rightOk ? candidate : null;
  } catch {
    return null;
  }
}

class CardLocationChangedError extends Error {}

async function rebalanceAndMoveCard({
  connection,
  cardId,
  expectedListId,
  targetListId,
  insertIndex,
  targetCards,
  now,
}: {
  connection: Knex.Transaction;
  cardId: string;
  expectedListId: string;
  targetListId: string;
  insertIndex: number;
  targetCards: CardRow[];
  now: string;
}): Promise<CardRow | null> {
  const orderedIds = [
    ...targetCards.slice(0, insertIndex).map((c) => c.id),
    cardId,
    ...targetCards.slice(insertIndex).map((c) => c.id),
  ];
  const newPositions = generatePositions(orderedIds.length);

  const activePosition = newPositions[insertIndex];
  if (!activePosition) throw new Error('Failed to generate card position');
  // The caller holds the workspace/board locks and one outer transaction.
  const moved = await connection('cards')
    .where({ id: cardId, list_id: expectedListId })
    .update({ list_id: targetListId, position: activePosition, updated_at: now });
  if (!moved) throw new CardLocationChangedError('Card location changed during move');
  for (const [idx, id] of orderedIds.entries()) {
    if (id === cardId) continue;
    const nextPosition = newPositions[idx];
    if (!nextPosition) throw new Error('Failed to generate card position');
    await connection('cards').where({ id }).update({ position: nextPosition, updated_at: now });
  }

  const refreshed = await connection<CardRow>('cards').where({ id: cardId }).first();
  return refreshed ?? null;
}

async function persistMove({
  connection,
  cardId,
  expectedListId,
  targetListId,
  insertIndex,
  targetCards,
  now,
  position,
}: {
  connection: Knex.Transaction;
  cardId: string;
  expectedListId: string;
  targetListId: string;
  insertIndex: number;
  targetCards: CardRow[];
  now: string;
  position: string | null;
}): Promise<CardRow | null> {
  if (position === null) {
    return rebalanceAndMoveCard({ connection, cardId, expectedListId, targetListId, insertIndex, targetCards, now });
  }

  const updated = (await connection<CardRow>('cards')
    .where({ id: cardId, list_id: expectedListId })
    .update({ list_id: targetListId, position, updated_at: now }, ['*'])) as CardRow[];
  return updated[0] ?? null;
}

// A newly arriving card is not already in the destination board's cache.
// Supply the same relationship/cover fields as GET /lists/:id/cards.
async function cardForDestination(card: CardRow) {
  const [cardLabels, cardMembers, comments, attachments, checklists] = await Promise.all([
    db('card_labels').where({ card_id: card.id }) as Promise<Array<{ label_id: string }>>,
    db('card_members').where({ card_id: card.id }) as Promise<Array<{ user_id: string }>>,
    db('comments').where({ card_id: card.id, deleted: false }) as Promise<Array<{ id: string }>>,
    db('attachments').where({ card_id: card.id, status: 'READY' }) as Promise<Array<{ referenced_card_id: string | null }>>,
    db('checklists').where({ card_id: card.id }).select('id') as Promise<Array<{ id: string }>>,
  ]);
  const checklistItems = checklists.length > 0
    ? await db('checklist_items').whereIn('checklist_id', checklists.map(({ id }) => id)) as Array<{ checked: boolean }>
    : [];
  const labels = cardLabels.length
    ? await db('labels').whereIn('id', cardLabels.map((row) => row.label_id)) as Array<{ id: string; name: string; color: string }>
    : [];
  const users = cardMembers.length
    ? await db('users').whereIn('id', cardMembers.map((row) => row.user_id)) as Array<{ id: string; email: string; name: string; avatar_url: string | null }>
    : [];
  return resolveCoverImageUrl({
    ...card,
    comment_count: comments.length,
    attachment_count: attachments.filter(({ referenced_card_id }) => referenced_card_id === null).length,
    linked_card_count: attachments.filter(({ referenced_card_id }) => referenced_card_id !== null).length,
    checklist_total: checklistItems.length,
    checklist_done: checklistItems.filter(({ checked }) => checked).length,
    labels: labels.map(({ id, name, color }) => ({ id, name, color })),
    members: buildAvatarProxyUrlsInCollection(users.map(({ id, email, name, avatar_url }) => ({ id, email, name, avatar_url }))),
  });
}

export async function handleMoveCard(req: Request, cardId: string): Promise<Response> {
  const authError = await authenticate(req as AuthenticatedRequest);
  if (authError) return authError;

  const cardReq = req as CardScopedRequest;
  const writableError = await requireCardWritable(cardReq, cardId);
  if (writableError) return writableError;

  const writableCardReq = cardReq as CardScopedRequest & { card: CardRow; board: BoardRow };
  const card = writableCardReq.card;
  const board = writableCardReq.board;

  const scopedReq = req as WorkspaceScopedRequest;
  const membershipError = await requireWorkspaceMembership(scopedReq, board.workspace_id);
  if (membershipError) return membershipError;

  const roleError = await requireMemberOrBoardGuestMember(scopedReq, board.id);
  if (roleError) return roleError;

  const bodyOrError = await parseMoveBody(req);
  if (bodyOrError instanceof Response) return bodyOrError;
  const body = bodyOrError;

  const listsOrError = await validateMoveLists({ card, targetListId: body.targetListId });
  if (listsOrError instanceof Response) return listsOrError;
  const { targetList, sourceList } = listsOrError;

  // For cross-board moves, verify the caller has write access on the target board before
  // evaluating state-transition rules so an inaccessible destination cannot leak list metadata.
  const isCrossBoard = sourceList.board_id !== targetList.board_id;
  if (isCrossBoard) {
    const targetBoard = await db<BoardRow>('boards').where({ id: targetList.board_id }).first();
    if (!targetBoard) {
      return Response.json({ error: { name: 'target-board-not-found' } }, { status: 404 });
    }
    if (targetBoard.workspace_id !== board.workspace_id) {
      return Response.json(
        {
          error: {
            code: 'cross-workspace-move-forbidden',
            message: 'Cards can only be moved between boards in the same workspace',
          },
        },
        { status: 403 },
      );
    }
    const targetVisibilityError = await applyBoardVisibility(req, targetBoard.id);
    if (targetVisibilityError) return targetVisibilityError;
    if (targetBoard.state === 'ARCHIVED') {
      return Response.json(
        { error: { code: 'board-is-archived', message: 'The target board is archived and cannot be modified' } },
        { status: 403 },
      );
    }
    const targetScopedReq = req as WorkspaceScopedRequest;
    const targetRoleError = await requireMemberOrBoardGuestMember(targetScopedReq, targetBoard.id);
    if (targetRoleError) return targetRoleError;
  }

  // The preflight above is deliberately cheap; all decisions governing the write
  // must be made again inside one transaction after the membership/board locks.
  let outcome: Response | { updatedCard: CardRow; sourceList: ListRow; targetList: ListRow; board: BoardRow; isCrossBoard: boolean; fromListId: string };
  try {
    outcome = await db.transaction(async (trx) => {
      await lockWorkspaceMembershipMutations(trx, board.workspace_id);
      for (const boardId of [...new Set([board.id, targetList.board_id])].sort()) {
        await lockBoardMemberMutations(trx, boardId);
      }

      const currentCard = await trx<CardRow>('cards').where({ id: cardId }).first();
      if (!currentCard) return denied('card-not-found', 'Card not found', 404);
      if (currentCard.list_id !== card.list_id) return denied('card-location-changed', 'Card location changed; reload and retry', 409);
      if (currentCard.archived) return denied('card-archived', 'Card is archived and cannot be modified');
      const currentSource = await trx<ListRow>('lists').where({ id: currentCard.list_id }).first();
      const currentTarget = await trx<ListRow>('lists').where({ id: body.targetListId }).first();
      if (!currentSource || currentSource.board_id !== board.id) return denied('card-location-changed', 'Card location changed; reload and retry', 409);
      if (!currentTarget) return denied('target-list-not-found', 'Target list not found', 404);
      if (currentTarget.board_id !== targetList.board_id) return denied('target-list-changed', 'Target list changed; reload and retry', 409);
      const currentBoard = await trx<BoardRow>('boards').where({ id: currentSource.board_id }).first();
      const currentTargetBoard = currentTarget.board_id === currentSource.board_id
        ? currentBoard : await trx<BoardRow>('boards').where({ id: currentTarget.board_id }).first();
      if (!currentBoard || !currentTargetBoard) return denied('board-not-found', 'Board not found', 404);
      if (currentBoard.workspace_id !== board.workspace_id || currentTargetBoard.workspace_id !== board.workspace_id) {
        return denied('cross-workspace-move-forbidden', 'Cards can only be moved between boards in the same workspace');
      }
      if (currentBoard.state === 'ARCHIVED') return denied('board-is-archived', 'This board is archived and cannot be modified.');
      const userId = (req as AuthenticatedRequest).currentUser?.id;
      if (!userId) return denied('unauthorized', 'Authentication required', 401);
      const memberships = await trx('memberships').where({ user_id: userId, workspace_id: board.workspace_id }).select('role') as Array<{ role: string }>;
      const role = resolveHighestRole(memberships.map((membership) => membership.role));
      if (!role) return denied('insufficient-role', 'You are not a member of this workspace');
      const sourceAccess = await authorizeBoardMove(trx, currentBoard, userId, role);
      if (sourceAccess) return sourceAccess;
      const crossBoard = currentSource.board_id !== currentTarget.board_id;
      if (crossBoard) {
        const targetAccess = await authorizeBoardMove(trx, currentTargetBoard, userId, role);
        if (targetAccess) return targetAccess;
        if (currentTargetBoard.state === 'ARCHIVED') return denied('board-is-archived', 'The target board is archived and cannot be modified');
      }
      if (currentTarget.archived) return denied('target-list-archived', 'The target list is archived');

      if (crossBoard) {
        // Plain SELECT under A/B advisory locks, never FOR SHARE (row-lock inversion).
        const enabled = await trx<{ board_id: string; enabled: boolean }>('board_state_transitions')
          .whereIn('board_id', [currentBoard.id, currentTargetBoard.id])
          .where({ enabled: true }).first();
        if (enabled) return denied('cross-board-transition-unsupported', 'Disable board transition rules before moving cards between these boards', 422);
      } else {
        const transitionError = await checkFreshTransition(trx, currentBoard.id, currentSource, currentTarget);
        if (transitionError) return transitionError;
      }

      const targetCards = await trx<CardRow>('cards')
        .where({ list_id: body.targetListId, archived: false })
        .whereNot({ id: cardId }).orderBy('position', 'asc');
      const insertIndex = resolveInsertIndex({ afterCardId: body.afterCardId, targetCards });
      if (insertIndex === null) return denied('card-not-found', 'afterCardId not found in target list', 404);
      if (currentCard.list_id === body.targetListId) {
        const currentIds = await trx('cards').where({ list_id: currentCard.list_id, archived: false })
          .orderBy('position', 'asc').select('id') as Array<{ id: string }>;
        if (currentIds.findIndex((entry) => entry.id === cardId) === insertIndex) {
          return Response.json({ data: currentCard });
        }
      }
      const left = insertIndex > 0 ? targetCards[insertIndex - 1]?.position ?? '' : '';
      const right = insertIndex < targetCards.length ? targetCards[insertIndex]?.position ?? HIGH_SENTINEL : HIGH_SENTINEL;
      const position = computeStrictPositionBetween({ left, right });
      if (crossBoard) {
        const cardLabels = await trx('card_labels').where({ card_id: cardId }) as Array<{ label_id: string }>;
        if (cardLabels.length) {
          const labels = await trx('labels').whereIn('id', cardLabels.map((label) => label.label_id)) as Array<{ board_id: string }>;
          if (labels.length !== cardLabels.length || labels.some((label) => label.board_id !== currentTarget.board_id)) {
            return denied('label-target-ineligible', 'Card labels must belong to the target board', 422);
          }
        }
      }
      const fromListId = currentCard.list_id;
      const updatedCard = await persistMove({ connection: trx, cardId, expectedListId: fromListId,
        targetListId: body.targetListId, insertIndex, targetCards, now: new Date().toISOString(), position });
      if (!updatedCard) throw new CardLocationChangedError('Card location changed during move');
      return { updatedCard, sourceList: currentSource, targetList: currentTarget, board: currentBoard,
        isCrossBoard: crossBoard, fromListId };
    });
  } catch (error) {
    if (error instanceof StateTransitionForbiddenError) {
      await emitCardMoveBlockedActivity({
        cardId, boardId: error.boardId,
        actorId: (req as AuthenticatedRequest).currentUser?.id ?? 'system',
        fromListId: error.fromListId, fromListName: error.fromListName,
        toListId: error.toListId, toListName: error.toListName,
        ipAddress: req.headers.get('x-forwarded-for') ?? req.headers.get('cf-connecting-ip') ?? null,
        userAgent: req.headers.get('user-agent') ?? null,
      });
      return Response.json({ name: 'state-transition-forbidden', data: {
        boardId: error.boardId, fromListId: error.fromListId, fromListName: error.fromListName,
        toListId: error.toListId, toListName: error.toListName,
        allowedNextStates: error.allowedNextStates,
      } }, { status: 422 });
    }
    if (error instanceof CardLocationChangedError) return denied('card-location-changed', 'Card location changed; reload and retry', 409);
    const pgError = error as { code?: string; constraint?: string };
    if (pgError.code === '23514' && pgError.constraint === 'card_move_assignment_eligibility') {
      return denied('assignment-target-ineligible', 'An assigned member cannot access the target board', 422);
    }
    if (pgError.code === '23514' && pgError.constraint === 'card_move_label_ownership') {
      return denied('label-target-ineligible', 'Card labels must belong to the target board', 422);
    }
    throw error;
  }
  if (outcome instanceof Response) return outcome;
  const { updatedCard, sourceList: committedSourceList, targetList: committedTargetList,
    board: committedBoard, isCrossBoard: committedCrossBoard, fromListId } = outcome;
  const updatedPosition = updatedCard.position;

  // Detect position collision: if another card already occupies the computed position
  // (concurrent move race), record it as a conflict before broadcasting the resolution.
  const collision = await db<CardRow>('cards')
    .where({ list_id: body.targetListId, position: updatedPosition, archived: false })
    .whereNot({ id: cardId })
    .first();
  if (collision) recordConflict({ boardId: committedBoard.id, entityType: 'card' });

  // Client expects { card, fromListId } to update both card slice and board slice
  const actorId = (req as AuthenticatedRequest).currentUser?.id ?? 'system';

  if (fromListId !== updatedCard.list_id) {
    await Promise.all([
      dispatchEvent({ type: 'card.moved', boardId: committedBoard.id, entityId: cardId, actorId, payload: { card: updatedCard, fromListId, toListId: updatedCard.list_id } }),
      emitCardMoved({
        actorId,
        cardId,
        cardTitle: updatedCard.title,
        fromListId,
        fromListName: committedSourceList.title ?? null,
        toListId: updatedCard.list_id,
        toListName: committedCrossBoard ? null : committedTargetList.title ?? null,
        boardId: committedBoard.id,
        workspaceId: committedBoard.workspace_id,
        ipAddress: req.headers.get('x-forwarded-for') ?? req.headers.get('cf-connecting-ip') ?? null,
        userAgent: req.headers.get('user-agent') ?? null,
      }),
    ]);
  }

  // Broadcast to the source board so its kanban view removes/moves the card in real time.
  publisher.publish(
    committedBoard.id,
    JSON.stringify({ type: 'card_moved', payload: { card: updatedCard, fromListId } }),
  ).catch(() => {});

  // For cross-board moves also notify the target board's subscribers.
  if (committedCrossBoard) {
    const destinationCard = await cardForDestination(updatedCard);
    publisher.publish(
      committedTargetList.board_id,
      JSON.stringify({ type: 'card_moved', payload: { card: destinationCard, fromListId } }),
    ).catch(() => {});
  }

  return Response.json({ data: updatedCard });
}
