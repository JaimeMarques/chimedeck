// Real PostgreSQL regression: moving a card must not carry guest assignments
// onto a board where that guest has no access. Requires migrations through 0123.
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { db } from '../../server/common/db';

const workspaceId = randomUUID();
const ownerId = randomUUID();
const guestId = randomUUID();
const sourceBoardId = randomUUID();
const targetBoardId = randomUUID();
const sourceListId = randomUUID();
const targetListId = randomUUID();
const cardId = randomUUID();
const checklistId = randomUUID();
const itemId = randomUUID();
const shortId = () => randomUUID().slice(0, 8);

async function cleanup(): Promise<void> {
  await db('checklist_items').where({ id: itemId }).delete();
  await db('checklists').where({ id: checklistId }).delete();
  await db('card_members').where({ card_id: cardId }).delete();
  await db('cards').where({ id: cardId }).delete();
  await db('board_guest_access').whereIn('board_id', [sourceBoardId, targetBoardId]).delete();
  await db('lists').whereIn('id', [sourceListId, targetListId]).delete();
  await db('boards').whereIn('id', [sourceBoardId, targetBoardId]).delete();
  await db('memberships').where({ workspace_id: workspaceId }).delete();
  await db('workspaces').where({ id: workspaceId }).delete();
  await db('users').whereIn('id', [ownerId, guestId]).delete();
}

async function moveTo(listId: string): Promise<void> {
  await db('cards').where({ id: cardId }).update({ list_id: listId });
}

async function assertMoveDenied(): Promise<void> {
  let error: unknown;
  try {
    await moveTo(targetListId);
  } catch (caught) {
    error = caught;
  }
  assert.equal((error as { code?: string } | undefined)?.code, '23514', 'move must fail closed');
  assert.equal(
    (error as { constraint?: string } | undefined)?.constraint,
    'card_move_assignment_eligibility',
  );
  const card = await db('cards').where({ id: cardId }).first<{ list_id: string }>();
  assert.equal(card?.list_id, sourceListId, 'rejected move must not mutate card location');
}

try {
  await db('users').insert([
    { id: ownerId, email: `${ownerId}@example.test`, name: 'Owner', email_verified: true },
    { id: guestId, email: `${guestId}@example.test`, name: 'Guest', email_verified: true },
  ]);
  await db('workspaces').insert({ id: workspaceId, name: `move-guard-${shortId()}`, owner_id: ownerId });
  await db('memberships').insert([
    { workspace_id: workspaceId, user_id: ownerId, role: 'OWNER' },
    { workspace_id: workspaceId, user_id: guestId, role: 'GUEST' },
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
  console.info('PASS cross-board move preserves assignment eligibility and fails closed for guests');
} finally {
  await cleanup();
  await db.destroy();
}
