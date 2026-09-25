import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { db } from '../../server/common/db';
import { handleUpdateMemberRole } from '../../server/extensions/workspace/api/members/updateRole';
import { handleAddMember } from '../../server/extensions/workspace/api/members/add';
import { consumeInvite } from '../../server/extensions/workspace/mods/invite/consume';
import { createInvite } from '../../server/extensions/workspace/mods/invite/create';
import { duplicateBoard } from '../../server/extensions/board/mods/duplicate';
import { handleCreateBoard } from '../../server/extensions/board/api/create';
import { canUserReceiveBoardWebhook } from '../../server/extensions/board/access';
import { lockWorkspaceMembershipMutations } from '../../server/extensions/workspace/api/members/lock';
import { cardsRouter } from '../../server/extensions/trelloCompat/api/cards/index';
import { handleRevokeGuest } from '../../server/extensions/board/api/guests/index';
import type { InviteRecord } from '../../server/extensions/workspace/mods/invite/validate';

async function createApiToken(userId: string): Promise<string> {
  const token = `hf_${randomUUID()}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const tokenHash = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  await db('api_tokens').insert({
    id: randomUUID(),
    user_id: userId,
    name: 'workspace-membership-security-regression',
    token_hash: tokenHash,
    token_prefix: token.slice(0, 10),
  });
  return token;
}

async function waitForAdvisoryWaiter(): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const waiting = await db.raw<{ rows: Array<{ count: string }> }>(`
      SELECT count(*)::text AS count
      FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
    `);
    if (Number(waiting.rows[0]?.count ?? 0) > 0) return;
    if (Date.now() >= deadline) throw new Error('creation request did not reach workspace lock');
    await Bun.sleep(20);
  }
}

const workspaceId = `ws-${randomUUID()}`;
const ownerId = `owner-${randomUUID()}`;
const adminId = `admin-${randomUUID()}`;
const guestId = `guest-${randomUUID()}`;
const revokedGuestId = `revoked-guest-${randomUUID()}`;
const inviteeA = `invitee-a-${randomUUID()}`;
const inviteeB = `invitee-b-${randomUUID()}`;
const boardA = `board-a-${randomUUID()}`;
const boardB = `board-b-${randomUUID()}`;

try {
  await db('users').insert([
    { id: ownerId, email: `${ownerId}@example.test`, name: 'Owner', email_verified: true },
    { id: adminId, email: `${adminId}@example.test`, name: 'Admin', email_verified: true },
    { id: guestId, email: `${guestId}@example.test`, name: 'Guest', email_verified: true },
    {
      id: revokedGuestId,
      email: `${revokedGuestId}@example.test`,
      name: 'Revoked Guest',
      email_verified: true,
    },
    { id: inviteeA, email: `${inviteeA}@example.test`, name: 'Invitee A', email_verified: true },
    { id: inviteeB, email: `${inviteeB}@example.test`, name: 'Invitee B', email_verified: true },
  ]);
  await db('workspaces').insert({
    id: workspaceId,
    name: 'security-regression',
    owner_id: ownerId,
  });
  await db('memberships').insert([
    { workspace_id: workspaceId, user_id: ownerId, role: 'OWNER' },
    { workspace_id: workspaceId, user_id: adminId, role: 'ADMIN' },
    { workspace_id: workspaceId, user_id: guestId, role: 'GUEST' },
    { workspace_id: workspaceId, user_id: revokedGuestId, role: 'GUEST' },
  ]);
  await db('boards').insert([
    {
      id: boardA,
      short_id: randomUUID().slice(0, 8),
      workspace_id: workspaceId,
      title: 'Invited private board',
      state: 'ACTIVE',
      visibility: 'PRIVATE',
    },
    {
      id: boardB,
      short_id: randomUUID().slice(0, 8),
      workspace_id: workspaceId,
      title: 'Unrelated private board',
      state: 'ACTIVE',
      visibility: 'PRIVATE',
    },
  ]);
  await db('board_members').insert([
    { id: randomUUID(), board_id: boardA, user_id: ownerId, role: 'ADMIN' },
    { id: randomUUID(), board_id: boardB, user_id: ownerId, role: 'ADMIN' },
    // Legacy stale authority that must not reactivate when the GUEST is promoted.
    { id: randomUUID(), board_id: boardB, user_id: guestId, role: 'ADMIN' },
  ]);
  await db('board_guest_access').insert([
    { id: randomUUID(), board_id: boardA, user_id: guestId, granted_by: ownerId },
    { id: randomUUID(), board_id: boardA, user_id: revokedGuestId, granted_by: ownerId },
  ]);

  const adminToken = await createApiToken(adminId);
  const escalationRequest = Object.assign(
    new Request(`https://example.test/api/v1/workspaces/${workspaceId}/members/${adminId}`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ role: 'OWNER' }),
    }),
    { callerRole: 'ADMIN' }
  );
  const escalationResponse = await handleUpdateMemberRole(escalationRequest, workspaceId, adminId);
  assert.equal(escalationResponse.status, 403, 'workspace ADMIN must not promote anyone to OWNER');
  const unchangedAdmin = await db('memberships')
    .where({ workspace_id: workspaceId, user_id: adminId })
    .first<{ role: string }>();
  assert.equal(unchangedAdmin.role, 'ADMIN');

  await assert.rejects(
    createInvite({
      workspaceId,
      invitedEmail: 'future-owner@example.test',
      role: 'OWNER',
      actorId: adminId,
    }),
    (error: unknown) => error instanceof Error && error.name === 'InviteRoleForbiddenError'
  );
  const forbiddenInvite = await db('invites')
    .where({ workspace_id: workspaceId, invited_email: 'future-owner@example.test' })
    .first<{ id: string }>();
  assert.equal(forbiddenInvite, undefined, 'denied OWNER invite must not be persisted');
  console.info('PASS  workspace ADMIN cannot grant OWNER directly or by invite');

  const invite: InviteRecord = {
    id: randomUUID(),
    token: randomUUID(),
    workspace_id: workspaceId,
    invited_email: `${inviteeA}@example.test`,
    role: 'MEMBER',
    accepted_at: null,
    expires_at: new Date(Date.now() + 60_000),
  };
  await db('invites').insert({
    id: invite.id,
    token: invite.token,
    workspace_id: workspaceId,
    invited_email: invite.invited_email,
    role: invite.role,
    expires_at: invite.expires_at,
  });
  const claims = await Promise.all([
    consumeInvite({ invite, userId: inviteeA }),
    consumeInvite({ invite, userId: inviteeB }),
  ]);
  assert.deepEqual(
    claims.sort(),
    [false, true],
    'exactly one concurrent invite claim must succeed'
  );
  const claimedMemberships = await db('memberships')
    .where({ workspace_id: workspaceId })
    .whereIn('user_id', [inviteeA, inviteeB]);
  assert.equal(claimedMemberships.length, 1, 'a single-use invite creates one membership');
  console.info('PASS  concurrent invite acceptance is single-use');

  const guestListId = `list-${randomUUID()}`;
  await db('lists').insert({
    id: guestListId,
    short_id: randomUUID().slice(0, 8),
    board_id: boardA,
    title: 'Guest write probe',
    position: 'a0',
  });
  const viewerGuestWrite = await cardsRouter(
    Object.assign(
      new Request('https://example.test/trello/1/cards', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idList: guestListId, name: 'must-not-exist' }),
      }),
      { currentUser: { id: guestId, email: `${guestId}@example.test` } }
    ),
    '/cards'
  );
  assert.equal(viewerGuestWrite?.status, 401, 'VIEWER guest must not mutate through Trello');
  assert.equal(
    await db('cards').where({ list_id: guestListId, title: 'must-not-exist' }).first(),
    undefined
  );
  console.info('PASS  Trello mutations reject VIEWER guests without writing');

  const ownerToken = await createApiToken(ownerId);
  const assignedCardId = `card-${randomUUID()}`;
  const checklistId = `checklist-${randomUUID()}`;
  const checklistItemId = `item-${randomUUID()}`;
  await db('cards').insert({
    id: assignedCardId,
    short_id: randomUUID().slice(0, 8),
    list_id: guestListId,
    title: 'Assignment cleanup probe',
    position: 'a1',
    archived: false,
  });
  await db('card_members').insert({ card_id: assignedCardId, user_id: revokedGuestId });
  await db('checklists').insert({
    id: checklistId,
    card_id: assignedCardId,
    title: 'Cleanup',
    position: 'a0',
  });
  await db('checklist_items').insert({
    id: checklistItemId,
    card_id: assignedCardId,
    checklist_id: checklistId,
    title: 'Assigned item',
    position: 'a0',
    assigned_member_id: revokedGuestId,
  });
  const revokeResponse = await handleRevokeGuest(
    new Request(`https://example.test/api/v1/boards/${boardA}/guests/${revokedGuestId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${ownerToken}` },
    }),
    boardA,
    revokedGuestId
  );
  assert.equal(revokeResponse.status, 200);
  assert.equal(
    await db('card_members').where({ card_id: assignedCardId, user_id: revokedGuestId }).first(),
    undefined
  );
  const cleanedChecklistItem = await db('checklist_items')
    .where({ id: checklistItemId })
    .first<{ assigned_member_id: string | null }>();
  assert.equal(cleanedChecklistItem.assigned_member_id, null);
  console.info('PASS  guest revocation removes card and checklist assignments');

  const promotionRequest = Object.assign(
    new Request(`https://example.test/api/v1/workspaces/${workspaceId}/members`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email: `${guestId}@example.test`, role: 'MEMBER' }),
    }),
    { callerRole: 'OWNER' }
  );
  const promotionResponse = await handleAddMember(promotionRequest, workspaceId);
  assert.equal(promotionResponse.status, 200);
  const promotedBoards = await db('board_members')
    .where({ user_id: guestId })
    .orderBy('board_id')
    .select<Array<{ board_id: string }>>('board_id');
  assert.deepEqual(
    promotedBoards.map((row) => row.board_id),
    [boardA],
    'promotion must preserve invited-board access without granting unrelated private boards'
  );
  console.info('PASS  guest promotion is scoped to previously granted boards');

  const duplicate = await duplicateBoard({
    originalBoardId: boardA,
    workspaceId,
    originalTitle: 'Invited private board',
    actorId: adminId,
  });
  assert.equal(duplicate.status, 201);
  const duplicateAdmin = await db('board_members')
    .where({ board_id: duplicate.data?.id, user_id: adminId, role: 'ADMIN' })
    .first<{ id: string }>();
  assert.ok(duplicateAdmin, 'the duplicating user must administer the new private board');
  console.info('PASS  duplicated private board has an eligible creator ADMIN');

  const createBarrier = await db.transaction();
  await lockWorkspaceMembershipMutations(createBarrier, workspaceId);
  const queuedCreate = handleCreateBoard(
    new Request(`https://example.test/api/v1/workspaces/${workspaceId}/boards`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'must-not-survive-revocation', visibility: 'PRIVATE' }),
    }),
    workspaceId
  );
  await waitForAdvisoryWaiter();
  await createBarrier('memberships')
    .where({ workspace_id: workspaceId, user_id: adminId })
    .delete();
  await createBarrier.commit();
  assert.equal((await queuedCreate).status, 403, 'queued native board creation must reauthorize');
  assert.equal(
    await db('boards')
      .where({ workspace_id: workspaceId, title: 'must-not-survive-revocation' })
      .first(),
    undefined
  );

  await db('memberships').insert({ workspace_id: workspaceId, user_id: adminId, role: 'ADMIN' });
  const duplicateBarrier = await db.transaction();
  await lockWorkspaceMembershipMutations(duplicateBarrier, workspaceId);
  const queuedDuplicate = duplicateBoard({
    originalBoardId: boardA,
    workspaceId,
    originalTitle: 'must-not-duplicate-after-revocation',
    actorId: adminId,
  });
  await waitForAdvisoryWaiter();
  await duplicateBarrier('memberships')
    .where({ workspace_id: workspaceId, user_id: adminId })
    .delete();
  await duplicateBarrier.commit();
  assert.equal((await queuedDuplicate).status, 403, 'queued duplication must reauthorize');
  console.info('PASS  board creation and duplication reauthorize after the workspace lock');

  const outsiderWebhookAccess = await canUserReceiveBoardWebhook(inviteeB, {
    id: boardA,
    workspace_id: workspaceId,
    visibility: 'PRIVATE',
  });
  assert.equal(
    outsiderWebhookAccess,
    false,
    'unrelated webhook owner must not receive private-board events'
  );
  const memberWebhookAccess = await canUserReceiveBoardWebhook(ownerId, {
    id: boardA,
    workspace_id: workspaceId,
    visibility: 'PRIVATE',
  });
  assert.equal(memberWebhookAccess, true);
  console.info('PASS  webhook delivery is scoped to current board access');

  console.info('\nALL WORKSPACE MEMBERSHIP SECURITY CHECKS PASSED');
} finally {
  await db('workspaces').where({ id: workspaceId }).delete();
  await db('users')
    .whereIn('id', [ownerId, adminId, guestId, revokedGuestId, inviteeA, inviteeB])
    .delete();
  await db.destroy();
}
