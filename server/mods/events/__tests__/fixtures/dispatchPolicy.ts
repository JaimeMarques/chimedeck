import { strict as assert } from 'node:assert';
import { mock } from 'bun:test';

const automationCalls: Array<Record<string, unknown>> = [];
const webhookCalls: Array<Record<string, unknown>> = [];
let allowOtherWebhook = true;

const event = {
  id: 'event-1',
  type: 'board_member_added',
  board_id: 'board-1',
  entity_id: 'board-1',
  actor_id: 'actor-1',
  payload: { memberId: 'member-1', userId: 'member-1', role: 'MEMBER' },
  created_at: new Date(),
};

await mock.module('../../index', () => ({
  writeEvent: (input: {
    type: string;
    boardId?: string | null;
    entityId: string;
    actorId: string;
    payload: Record<string, unknown>;
  }) =>
    Promise.resolve({
      ...event,
      type: input.type,
      board_id: input.boardId ?? null,
      entity_id: input.entityId,
      actor_id: input.actorId,
      payload: input.payload,
    }),
}));
await mock.module('../../../../extensions/automation/config', () => ({
  automationConfig: { enabled: true },
}));
await mock.module('../../../../extensions/automation/engine/index', () => ({
  evaluate: (input: Record<string, unknown>) => {
    automationCalls.push(input);
    return Promise.resolve();
  },
}));
await mock.module('../../../../extensions/notifications/mods/boardActivityDispatch', () => ({
  handleBoardActivityNotification: () => Promise.resolve(),
}));
await mock.module('../../../../common/db', () => ({
  db: () => ({
    where: () => ({
      first: () =>
        Promise.resolve({ id: 'board-1', workspace_id: 'workspace-1', visibility: 'PRIVATE' }),
    }),
  }),
}));
await mock.module('../../../../extensions/board/access', () => ({
  canUserReceiveBoardWebhook: (userId: string) =>
    Promise.resolve(userId === 'member-1' || (allowOtherWebhook && userId === 'other-user')),
}));
await mock.module('../../../../config/env', () => ({ env: { WEBHOOKS_ENABLED: true } }));
await mock.module('../../../../extensions/webhooks/mods/registry', () => ({
  getActiveWebhooksForEvent: () =>
    Promise.resolve([
      {
        id: 'webhook-member',
        created_by: 'member-1',
        endpoint_url: 'https://example.test/member',
        signing_secret: 'member-secret',
      },
      {
        id: 'webhook-other',
        created_by: 'other-user',
        endpoint_url: 'https://example.test/other',
        signing_secret: 'other-secret',
      },
    ]),
}));
await mock.module('../../../../extensions/webhooks/mods/dispatch', () => ({
  dispatchWebhook: (input: Record<string, unknown>) => {
    webhookCalls.push(input);
    return Promise.resolve();
  },
}));

const { dispatchEvent } = await import('../../dispatch');
await dispatchEvent({
  type: event.type,
  boardId: event.board_id,
  entityId: event.entity_id,
  actorId: event.actor_id,
  payload: event.payload,
});

const deadline = Date.now() + 2000;
while ((automationCalls.length < 1 || webhookCalls.length < 1) && Date.now() < deadline) {
  await Bun.sleep(10);
}

assert.equal(automationCalls.length, 1, 'dispatcher must evaluate automation once');
const automationCall = automationCalls[0];
assert.ok(automationCall);
const automationEvent = automationCall.event as { type?: string; payload?: unknown } | undefined;
assert.ok(automationEvent);
assert.equal(automationEvent.type, 'board.member_added');
assert.deepEqual(automationEvent.payload, event.payload);
assert.equal(webhookCalls.length, 1, 'dispatcher must filter unrelated webhook owners');
const memberWebhook = webhookCalls[0];
assert.ok(memberWebhook);
assert.equal(memberWebhook.webhookId, 'webhook-member');
assert.equal(memberWebhook.eventType, 'board.member_added');

webhookCalls.length = 0;
allowOtherWebhook = false;
await dispatchEvent({
  type: 'card.updated',
  boardId: 'board-1',
  entityId: 'card-1',
  actorId: 'actor-1',
  payload: { card: { id: 'card-1', title: 'private' } },
});
const ordinaryDeadline = Date.now() + 2000;
while (webhookCalls.length < 1 && Date.now() < ordinaryDeadline) {
  await Bun.sleep(10);
}
assert.equal(
  webhookCalls.length,
  1,
  'dispatcher must enforce board access for ordinary private-board webhook events'
);
const ordinaryWebhook = webhookCalls[0];
assert.ok(ordinaryWebhook);
assert.equal(ordinaryWebhook.webhookId, 'webhook-member');
assert.equal(ordinaryWebhook.eventType, 'card.updated');

console.info('dispatch integration preserves automation naming and webhook recipient privacy');
