// useNotificationNavigate — navigates to a notification's card (with comment
// anchors) or board. Shared by the header bell and the board bottom-bar inbox.
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Notification } from '../api';
import { boardPath, cardPath } from '~/common/routing/shortUrls';

export function useNotificationNavigate() {
  const navigate = useNavigate();

  return useCallback(
    (notification: Notification) => {
      const n = notification as Notification & { board_short_id?: string | null; card_short_id?: string | null };
      if (notification.board_id && notification.card_id) {
        const params = new URLSearchParams();

        if (notification.type === 'card_commented' && notification.source_id) {
          if (notification.source_parent_id) {
            params.set('comment', notification.source_parent_id);
            params.set('reply', notification.source_id);
          } else {
            params.set('comment', notification.source_id);
          }
        } else if (notification.source_type === 'comment' && notification.source_id) {
          params.set('comment', notification.source_id);
        }

        const cardUrl = cardPath({ id: notification.card_id, short_id: n.card_short_id ?? null });
        const search = params.toString();
        navigate(search ? `${cardUrl}?${search}` : cardUrl);
      } else if (notification.board_id) {
        navigate(boardPath({ id: notification.board_id, short_id: n.board_short_id ?? null }));
      }
    },
    [navigate],
  );
}
