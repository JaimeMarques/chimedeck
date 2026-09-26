import type { WebhookEventType } from '../../extensions/webhooks/common/eventTypes';
import type { WrittenEvent } from './write';

export function eventForAutomation(event: WrittenEvent): {
  type: string;
  payload: Record<string, unknown>;
} {
  if (event.type !== 'board_member_added' && event.type !== 'board.member_added') {
    return { type: event.type, payload: event.payload };
  }

  const memberId = event.payload['memberId'] ?? event.payload['userId'];
  return {
    type: 'board.member_added',
    payload: {
      ...event.payload,
      ...(typeof memberId === 'string' ? { memberId } : {}),
    },
  };
}

export function shouldDeliverWebhookEvent({
  event,
  webhookEventType,
  webhookOwnerId,
}: {
  event: WrittenEvent;
  webhookEventType: WebhookEventType;
  webhookOwnerId: string;
}): boolean {
  if (webhookEventType !== 'board.member_added') return true;

  const memberId = event.payload['memberId'] ?? event.payload['userId'];
  return typeof memberId === 'string' && webhookOwnerId === memberId;
}
