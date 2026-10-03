import { afterAll, afterEach, describe, expect, it, spyOn } from 'bun:test';
import { JSDOM } from 'jsdom';
import type { ActivityData } from '../../slices/cardDetailSlice';
import type { CommentData } from '../../api/cardDetail';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://chimedeck.test/board/board-1/card/card-1',
});
for (const key of [
  'window', 'document', 'location', 'navigator', 'localStorage', 'DOMParser',
  'Node', 'NodeFilter', 'Element', 'HTMLElement', 'HTMLAnchorElement',
  'HTMLBRElement', 'HTMLImageElement', 'HTMLSpanElement', 'DocumentFragment',
  'Text', 'Event', 'CustomEvent',
] as const) {
  const value = key === 'window' ? dom.window : dom.window[key];
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
}

const attachmentApi = await import('~/extensions/Attachments/api');
const attachmentSpy = spyOn(attachmentApi, 'listAttachments').mockResolvedValue({ data: [] });

const React = (await import('react')).default;
const { act, cleanup, fireEvent, render } = await import('@testing-library/react');
const { default: ActivityFeed } = await import('./ActivityFeed');

const comment: CommentData = {
  id: 'comment-1', card_id: 'card-1', user_id: 'user-1',
  content: '**Keep this comment** @alice', version: 1, deleted: false,
  created_at: '2026-09-30T12:00:00Z', updated_at: '2026-09-30T12:00:00Z',
  author_name: 'Author', reactions: [], parent_id: null, reply_count: 0,
};
const activities: ActivityData[] = ['card_created', 'card_moved', 'card.due_date.set', 'attachment_added'].map((action, index) => ({
  id: String(index), entity_type: 'card', entity_id: 'card-1', board_id: 'board-1',
  action, actor_id: 'user-1', actor_name: 'Author', actor_email: null,
  actor_avatar_url: null, payload: {}, created_at: '2026-09-30T13:00:00Z',
}));

async function mount(comments: CommentData[] = [comment], cardId = 'card-1') {
  const view = render(React.createElement(ActivityFeed, {
    cardId, comments, activities, currentUserId: 'user-2', canAddComment: false,
    onAddComment: async () => {}, onEditComment: async () => {}, onDeleteComment: async () => {},
  }));
  await act(async () => {});
  return view;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

afterAll(() => {
  attachmentSpy.mockRestore();
});

describe('card comments details toggle', () => {
  it('starts with all details and hides every system event without remounting comments', async () => {
    const view = await mount();
    const button = view.getByRole('button', { name: 'Hide details' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(view.getByText('created this card')).toBeTruthy();
    expect(view.getByText('moved this card')).toBeTruthy();
    const commentNode = view.getByText('Keep this comment');
    const initialText = view.container.textContent;
    fireEvent.click(button);
    expect(view.getByRole('button', { name: 'Show details' }).getAttribute('aria-pressed')).toBe('false');
    expect(view.queryByText('created this card')).toBeNull();
    expect(view.queryByText('moved this card')).toBeNull();
    expect(view.getByText('Keep this comment')).toBe(commentNode);
    expect(view.container.querySelectorAll('p.text-subtle')).toHaveLength(0);
    expect(view.container.textContent).toContain('@alice');
    fireEvent.click(button);
    expect(view.container.textContent).toBe(initialText);
  });

  it('persists comments-only mode when another card is opened', async () => {
    const first = await mount();
    fireEvent.click(first.getByRole('button', { name: 'Hide details' }));
    expect(localStorage.getItem('card-activity-show-details')).toBe('false');
    first.unmount();
    const second = await mount([], 'card-2');
    expect(second.getByRole('button', { name: 'Show details' })).toBeTruthy();
    expect(second.getByText('No comments yet.')).toBeTruthy();
    expect(second.queryByText('No activity yet.')).toBeNull();
    fireEvent.click(second.getByRole('button', { name: 'Show details' }));
    expect(second.getByText('created this card')).toBeTruthy();
    expect(localStorage.getItem('card-activity-show-details')).toBe('true');
  });

  it('keeps toggling when localStorage is blocked', async () => {
    const storagePrototype = Object.getPrototypeOf(localStorage) as Storage;
    const read = spyOn(storagePrototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const write = spyOn(storagePrototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    try {
      const view = await mount();
      fireEvent.click(view.getByRole('button', { name: 'Hide details' }));
      expect(view.getByRole('button', { name: 'Show details' })).toBeTruthy();
      expect(view.getByText('Keep this comment')).toBeTruthy();
    } finally {
      read.mockRestore();
      write.mockRestore();
    }
  });
});
