import { describe, expect, test } from 'bun:test';
import type { WrittenEvent } from '../write';
import { eventForAutomation, shouldDeliverWebhookEvent } from '../policy';

function memberAddedEvent(): WrittenEvent {
  return {
    id: 'event-1',
    type: 'board_member_added',
    board_id: 'board-1',
    entity_id: 'board-1',
    actor_id: 'actor-1',
    payload: { userId: 'member-1', role: 'MEMBER' },
    sequence: 1n,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
  };
}

describe('event dispatch policy', () => {
  test('normalizes legacy member-added events only for automation', () => {
    const persisted = memberAddedEvent();
    const automation = eventForAutomation(persisted);

    expect(persisted.type).toBe('board_member_added');
    expect(automation).toMatchObject({
      type: 'board.member_added',
      payload: { userId: 'member-1', memberId: 'member-1', role: 'MEMBER' },
    });
  });

  test('delivers board.member_added webhooks only to the added member', () => {
    const event = memberAddedEvent();

    expect(
      shouldDeliverWebhookEvent({
        event,
        webhookEventType: 'board.member_added',
        webhookOwnerId: 'member-1',
      })
    ).toBe(true);
    expect(
      shouldDeliverWebhookEvent({
        event,
        webhookEventType: 'board.member_added',
        webhookOwnerId: 'unrelated-user',
      })
    ).toBe(false);
  });
});
