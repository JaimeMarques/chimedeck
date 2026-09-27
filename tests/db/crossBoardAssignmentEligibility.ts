// Real PostgreSQL regression: moving a card must not carry guest assignments
// onto a board where that guest has no access. Requires migrations through 0123.
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { db } from '../../server/common/db';
import { lockWorkspaceMembershipMutations } from '../../server/extensions/workspace/api/members/lock';
import { lockBoardMemberMutations } from '../../server/extensions/board/api/members/lock';

const workspaceId = randomUUID();
const ownerId = randomUUID();
const guestId = randomUUID();
const memberId = randomUUID();
const sourceBoardId = randomUUID();
const targetBoardId = randomUUID();
const sourceListId = randomUUID();
const targetListId = randomUUID();
const cardId = randomUUID();
const checklistId = randomUUID();
const itemId = randomUUID();
const labelId = randomUUID();
const shortId = () => randomUUID().slice(0, 8);

async function cleanup(): Promise<void> {
  await db('checklist_items').where({ id: itemId }).delete();
  await db('checklists').where({ id: checklistId }).delete();
  await db('card_members').where({ card_id: cardId }).delete();
  await db('card_labels').where({ card_id: cardId }).delete();
  await db('labels').where({ id: labelId }).delete();
  await db('board_members').whereIn('board_id', [sourceBoardId, targetBoardId]).delete();
  await db('board_state_transitions').where({ board_id: sourceBoardId }).delete();
  await db('cards').where({ id: cardId }).delete();
  await db('board_guest_access').whereIn('board_id', [sourceBoardId, targetBoardId]).delete();
  await db('lists').whereIn('id', [sourceListId, targetListId]).delete();
  await db('boards').whereIn('id', [sourceBoardId, targetBoardId]).delete();
  await db('memberships').where({ workspace_id: workspaceId }).delete();
  await db('workspaces').where({ id: workspaceId }).delete();
  await db('users').whereIn('id', [ownerId, guestId, memberId]).delete();
}

async function moveTo(listId: string): Promise<void> {
  await db('cards').where({ id: cardId }).update({ list_id: listId });
}

async function assertMoveDenied(expectedConstraint = 'card_move_assignment_eligibility'): Promise<void> {
  let error: unknown;
  try {
    await moveTo(targetListId);
  } catch (caught) {
    error = caught;
  }
  assert.equal((error as { code?: string } | undefined)?.code, '23514', 'move must fail closed');
  assert.equal(
    (error as { constraint?: string } | undefined)?.constraint,
    expectedConstraint,
  );
  const card = await db('cards').where({ id: cardId }).first<{ list_id: string }>();
  assert.equal(card?.list_id, sourceListId, 'rejected move must not mutate card location');
}

async function waitForAdvisoryWaiters(minimum: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await db.raw<{ rows: Array<{ waiters: string }> }>(`
      SELECT count(*) AS waiters FROM pg_locks
       WHERE locktype = 'advisory' AND NOT granted
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
    `);
    if (Number(result.rows[0]?.waiters) >= minimum) return;
    await Bun.sleep(20);
  }
  throw new Error(`Expected ${String(minimum)} advisory waiters`);
}

try {
  await db('users').insert([
    { id: ownerId, email: `${ownerId}@example.test`, name: 'Owner', email_verified: true },
    { id: guestId, email: `${guestId}@example.test`, name: 'Guest', email_verified: true },
    { id: memberId, email: `${memberId}@example.test`, name: 'Member', email_verified: true },
  ]);
  await db('workspaces').insert({ id: workspaceId, name: `move-guard-${shortId()}`, owner_id: ownerId });
  await db('memberships').insert([
    { workspace_id: workspaceId, user_id: ownerId, role: 'OWNER' },
    { workspace_id: workspaceId, user_id: guestId, role: 'GUEST' },
    { workspace_id: workspaceId, user_id: memberId, role: 'MEMBER' },
  ]);
  await db('boards').insert([
    { id: sourceBoardId, workspace_id: workspaceId, title: 'Source', visibility: 'PRIVATE', short_id: shortId() },
    { id: targetBoardId, workspace_id: workspaceId, title: 'Target', visibility: 'PRIVATE', short_id: shortId() },
  ]);
  await db('lists').insert([
    { id: sourceListId, board_id: sourceBoardId, title: 'Source', short_id: shortId(), position: 'a0' },
    { id: targetListId, board_id: targetBoardId, title: 'Target', short_id: shortId(), position: 'a0' },
  ]);
  await db('cards').insert({ id: cardId, list_id: sourceListId, short_id: shortId(), title: 'Guest assigned', position: 'a0', archived: false });
  await db('board_guest_access').insert({ id: randomUUID(), board_id: sourceBoardId, user_id: guestId, guest_type: 'MEMBER', granted_by: ownerId });
  await db('card_members').insert({ card_id: cardId, user_id: guestId });

  await assertMoveDenied();

  // Giving the guest access to the destination preserves their assignment.
  await db('board_guest_access').insert({ id: randomUUID(), board_id: targetBoardId, user_id: guestId, guest_type: 'MEMBER', granted_by: ownerId });
  await moveTo(targetListId);
  assert.equal((await db('cards').where({ id: cardId }).first<{ list_id: string }>())?.list_id, targetListId);
  assert.ok(await db('card_members').where({ card_id: cardId, user_id: guestId }).first());

  await moveTo(sourceListId);
  await db('board_guest_access').where({ board_id: targetBoardId, user_id: guestId }).delete();
  await db('card_members').where({ card_id: cardId, user_id: guestId }).delete();
  await db('checklists').insert({ id: checklistId, card_id: cardId, title: 'Tasks', position: 'a0' });
  await db('checklist_items').insert({ id: itemId, card_id: cardId, checklist_id: checklistId, title: 'Assigned', position: 'a0', assigned_member_id: guestId });
  await assertMoveDenied();

  // A non-guest workspace MEMBER still cannot read a PRIVATE board without
  // explicit board membership; moving their assignment there must fail.
  await db('checklist_items').where({ id: itemId }).update({ assigned_member_id: null });
  await db('board_members').insert({ id: randomUUID(), board_id: sourceBoardId, user_id: memberId, role: 'MEMBER' });
  await db('card_members').insert({ card_id: cardId, user_id: memberId });
  await assertMoveDenied();
  await db('board_members').insert({ id: randomUUID(), board_id: targetBoardId, user_id: memberId, role: 'MEMBER' });
  await moveTo(targetListId);
  assert.ok(await db('card_members').where({ card_id: cardId, user_id: memberId }).first());

  // A source-board label cannot follow a card to a different board, even if a
  // concurrent writer attaches it after an application-level precheck.
  await moveTo(sourceListId);
  await db('card_members').where({ card_id: cardId, user_id: memberId }).delete();
  await db('labels').insert({ id: labelId, board_id: sourceBoardId, name: 'Source label', color: '#336699' });
  await db('card_labels').insert({ card_id: cardId, label_id: labelId });
  await assertMoveDenied('card_move_label_ownership');
  await db('card_labels').where({ card_id: cardId, label_id: labelId }).delete();
  await moveTo(targetListId);

  // Deterministically queue Move first on the card lock, then an assignment
  // writer that holds workspace+board locks. Opposite lock ordering deadlocks.
  await moveTo(sourceListId);
  const barrier = await db.transaction();
  let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
  let outcomes: PromiseSettledResult<unknown>[] = [];
  try {
    await barrier.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`card-assignments:${cardId}`]);
    const moving = db('cards').where({ id: cardId }).update({ list_id: targetListId });
    pending = Promise.allSettled([moving]);
    await waitForAdvisoryWaiters(1);
    const assigning = db.transaction(async (trx) => {
      await lockWorkspaceMembershipMutations(trx, workspaceId);
      await lockBoardMemberMutations(trx, sourceBoardId);
      await trx('card_members').insert({ card_id: cardId, user_id: memberId });
    });
    pending = Promise.allSettled([moving, assigning]);
    await waitForAdvisoryWaiters(2);
  } finally {
    await barrier.rollback();
    if (pending) outcomes = await pending;
  }
  assert.equal(outcomes.length, 2);
  assert.ok(outcomes.every((outcome) => outcome.status === 'fulfilled'), 'concurrent move and assignment must not deadlock');
  assert.equal((await db('cards').where({ id: cardId }).first<{ list_id: string }>())?.list_id, targetListId);
  assert.ok(await db('card_members').where({ card_id: cardId, user_id: memberId }).first());

  // Enabling a transition graph must wait for a Move's workspace lock; Move
  // rechecks this flag while holding that lock before persisting the card.
  await db('board_state_transitions').insert({ id: randomUUID(), board_id: sourceBoardId, enabled: false });
  const transitionBarrier = await db.transaction();
  let transitionPending: Promise<PromiseSettledResult<unknown>[]> | undefined;
  let transitionOutcomes: PromiseSettledResult<unknown>[] = [];
  try {
    await lockWorkspaceMembershipMutations(transitionBarrier, workspaceId);
    const enabling = db('board_state_transitions').where({ board_id: sourceBoardId }).update({ enabled: true });
    transitionPending = Promise.allSettled([enabling]);
    await waitForAdvisoryWaiters(1);
  } finally {
    await transitionBarrier.rollback();
    if (transitionPending) transitionOutcomes = await transitionPending;
  }
  assert.equal(transitionOutcomes[0]?.status, 'fulfilled');
  assert.equal((await db('board_state_transitions').where({ board_id: sourceBoardId }).first<{ enabled: boolean }>())?.enabled, true);
  console.info('PASS cross-board move preserves assignment/label eligibility, concurrent writers complete and transition updates serialize');
} finally {
  await cleanup();
  await db.destroy();
}
