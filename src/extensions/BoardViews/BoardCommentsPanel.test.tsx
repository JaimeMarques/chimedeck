import { afterEach, expect, mock, test } from 'bun:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://chimedeck.test/board/board-1' });
for (const key of ['window', 'document', 'navigator', 'location', 'HTMLElement', 'Element', 'Node', 'MutationObserver'] as const) {
  Object.defineProperty(globalThis, key, {
    value: key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key],
    writable: true, configurable: true,
  });
}
const memberId = 'a1234567-89ab-4cde-8fab-0123456789ab';
const guestId = 'b1234567-89ab-4cde-8fab-0123456789ab';
const content = `Owner @${memberId}; visitor @${guestId}; <img onerror="bad()">`;
void mock.module('./api', () => ({ getBoardComments: () => Promise.resolve({
  data: [{ id: 'comment-1', card_id: 'card-1', user_id: 'owner', content, version: 1,
    deleted: false, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    author_name: 'Author', card_title: 'Card' }],
  metadata: { cursor: null, hasMore: false },
}) }));
const React = (await import('react')).default;
const { cleanup, render, waitFor } = await import('@testing-library/react');
const { Provider } = await import('react-redux');
const { configureStore } = await import('@reduxjs/toolkit');
const { boardMembersApi } = await import('~/extensions/Board/slices/boardMembersSlice');
const { boardGuestsApi } = await import('~/extensions/Board/slices/boardGuestsSlice');
const { default: BoardCommentsPanel } = await import('./BoardCommentsPanel');
afterEach(cleanup);

test('board-wide comments resolve member and guest UUID mentions as safe text', async () => {
  const store = configureStore({
    reducer: { [boardMembersApi.reducerPath]: boardMembersApi.reducer, [boardGuestsApi.reducerPath]: boardGuestsApi.reducer },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(boardMembersApi.middleware, boardGuestsApi.middleware),
  });
  await store.dispatch(boardMembersApi.util.upsertQueryData('getBoardMembers', 'board-1', [
    { board_id: 'board-1', user_id: memberId, role: 'MEMBER', email: 'alice@example.com',
      nickname: 'alice', display_name: 'Alice Smith', avatar_url: null, created_at: '2026-01-01T00:00:00Z' },
  ]));
  await store.dispatch(boardGuestsApi.util.upsertQueryData('getBoardGuests', 'board-1', [
    { id: guestId, email: 'guest@example.com', name: 'Guest Name', guestType: 'VIEWER',
      granted_at: '2026-01-01T00:00:00Z', granted_by: 'owner' },
  ]));
  const { container } = render(React.createElement(Provider, {
    store, children: React.createElement(BoardCommentsPanel, { boardId: 'board-1' }),
  }));
  await waitFor(() => {
    expect(container.textContent).toContain('Owner @alice; visitor @Guest Name');
  });
  expect(container.textContent).not.toContain(memberId);
  expect(container.textContent).not.toContain(guestId);
  expect(container.textContent).toContain('<img onerror="bad()">');
  expect(container.querySelector('img')).toBeNull();
});
