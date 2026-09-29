// DOM-level guard for the historical-import XSS remediation.
//
// [why] The unit tests cover the sanitizer policy and the render helper's string output. This test
// closes the loop by mounting the real component under jsdom and asserting the live DOM contains no
// executable payload, while the comment string handed to the component stays byte-identical.
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { JSDOM } from 'jsdom';
import type { Attachment } from '~/extensions/Attachments/types';
import type { Comment as CommentRecord } from '../CommentItem';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://chimedeck.test/board/board-1/card/card-1',
});
const jsdomWindow = dom.window;

const GLOBAL_KEYS = [
  'window',
  'document',
  'location',
  'navigator',
  'DOMParser',
  'Node',
  'NodeFilter',
  'Element',
  'HTMLElement',
  'HTMLAnchorElement',
  'HTMLBRElement',
  'HTMLImageElement',
  'HTMLSpanElement',
  'DocumentFragment',
  'Text',
  'Event',
  'CustomEvent',
] as const;

for (const key of GLOBAL_KEYS) {
  const value =
    key === 'window' ? jsdomWindow : (jsdomWindow as unknown as Record<string, unknown>)[key];
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
}

const React = (await import('react')).default;
const { act, cleanup, render, waitFor } = await import('@testing-library/react');
const { Provider } = await import('react-redux');
const { configureStore } = await import('@reduxjs/toolkit');
const { boardMembersApi } = await import('~/extensions/Board/slices/boardMembersSlice');
const { default: CommentItem } = await import('../CommentItem');
const { default: apiClient } = await import('~/common/api/client');

function createStore() {
  return configureStore({
    reducer: { [boardMembersApi.reducerPath]: boardMembersApi.reducer },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(boardMembersApi.middleware),
  });
}

/** Comment content exactly as the historical importer stored it: raw source HTML, untrimmed. */
const RAW_STORED_CONTENT =
  'Deploy notes\r\n<script>window.__xss = 1</script>\r\n' +
  '<img src="x" onerror="window.__xss = 2">\r\n' +
  '[download](javascript:alert(1))\r\n' +
  '<iframe src="https://evil.test/pwn"></iframe>\r\n' +
  '<b onclick="window.__xss = 4">still bold</b>\r\n' +
  'thanks @alice  ';

function buildComment(content: string): CommentRecord {
  return {
    id: 'comment-1',
    card_id: 'card-1',
    user_id: 'user-9',
    content,
    version: 1,
    deleted: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    author_name: 'Imported Author',
    author_email: 'imported@example.com',
    reactions: [],
    parent_id: null,
    reply_count: 0,
  };
}

function mountComment(content: string, attachments: Attachment[] = [], store = createStore(), boardId?: string) {
  const comment = buildComment(content);
  const buildElement = () => (
    React.createElement(Provider, { store, children: React.createElement(CommentItem, {
      comment,
      attachments,
      ...(boardId ? { boardId } : {}),
      currentUserId: 'user-1',
      onEdit: async () => {},
      onDelete: async () => {},
    }) })
  );
  const { container, rerender } = render(buildElement());
  return { comment, container, rerender: () => { rerender(buildElement()); } };
}

afterEach(() => {
  cleanup();
});

describe('CommentItem rendering of verbatim historical bytes', () => {
  it('rehydrates links and authenticated images when the roster resolves a mention', async () => {
    const store = createStore();
    const userId = 'a1234567-89ab-4cde-8fab-0123456789ab';
    await store.dispatch(boardMembersApi.util.upsertQueryData('getBoardMembers', 'board-1', []));
    const attachments: Attachment[] = [];
    const originalAdapter = apiClient.defaults.adapter;
    let imageRequests = 0;
    apiClient.defaults.adapter = (config) => {
      imageRequests += 1;
      return Promise.resolve({ data: new Blob(['image']), status: 200, statusText: 'OK', headers: {}, config });
    };
    const createObjectUrl = spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-hydrated-image');
    const revokeObjectUrl = spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    try {
      const { container, rerender } = mountComment(
        `@${userId} [docs](https://example.com/docs) ![image](/api/v1/attachments/image-id/view)`,
        attachments, store, 'board-1',
      );
      await waitFor(() => {
        expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:test-hydrated-image');
      });
      expect(container.querySelector('a')?.classList.contains('cd-link-button')).toBe(true);
      expect(container.querySelector('span.rounded')?.textContent).toBe(`@${userId}`);
      expect(imageRequests).toBe(1);

      const member = {
        board_id: 'board-1', user_id: userId, role: 'MEMBER' as const,
        email: 'alice@example.com', nickname: 'alice', display_name: 'Alice Smith',
        avatar_url: null, created_at: '2026-01-01T00:00:00.000Z',
      };
      const members = [member];
      await act(async () => {
        await store.dispatch(boardMembersApi.util.upsertQueryData('getBoardMembers', 'board-1', members));
      });
      await waitFor(() => {
        expect(container.querySelector('span.rounded')?.textContent).toBe('@alice');
        expect(container.querySelector('a')?.classList.contains('cd-link-button')).toBe(true);
        expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:test-hydrated-image');
        expect(imageRequests).toBe(2);
      });
      expect(revokeObjectUrl).toHaveBeenCalledWith('blob:test-hydrated-image');

      // A roster change that renders the same label must retain the hydrated DOM.
      await act(async () => {
        await store.dispatch(boardMembersApi.util.upsertQueryData('getBoardMembers', 'board-1', [
          { ...member, display_name: 'Alice Updated' },
        ]));
      });
      expect(imageRequests).toBe(2);
      expect(container.querySelector('a')?.classList.contains('cd-link-button')).toBe(true);
      expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:test-hydrated-image');
      rerender();
      expect(imageRequests).toBe(2);
      expect(container.querySelector('a')?.classList.contains('cd-link-button')).toBe(true);
      expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:test-hydrated-image');
    } finally {
      cleanup();
      if (originalAdapter === undefined) delete apiClient.defaults.adapter;
      else apiClient.defaults.adapter = originalAdapter;
      createObjectUrl.mockRestore();
      revokeObjectUrl.mockRestore();
    }
  });

  it('uses cached board members, preferring nicknames and falling back to display names', async () => {
    const store = createStore();
    const aliceId = 'a1234567-89ab-4cde-8fab-0123456789ab';
    const bobId = 'b1234567-89ab-4cde-8fab-0123456789ab';
    const unknownId = 'c1234567-89ab-4cde-8fab-0123456789ab';
    const member = {
      board_id: 'board-1', role: 'MEMBER' as const, email: 'member@example.com',
      avatar_url: null, created_at: '2026-01-01T00:00:00.000Z',
    };
    await store.dispatch(boardMembersApi.util.upsertQueryData('getBoardMembers', 'board-1', [
      { ...member, user_id: aliceId, nickname: 'alice', display_name: 'Alice Smith' },
      { ...member, user_id: bobId, nickname: '', display_name: 'Bob Jones' },
    ]));
    const content = `@${aliceId} @${bobId} @${unknownId}`;
    const { container, comment } = mountComment(content, [], store, 'board-1');

    expect(Array.from(container.querySelectorAll('span.rounded'), (chip) => chip.textContent)).toEqual(['@alice', '@Bob Jones', `@${unknownId}`]);
    expect(comment.content).toBe(content);
  });

  it('keeps UUIDs visible without a board context', () => {
    const content = '@a1234567-89ab-4cde-8fab-0123456789ab';
    const { container } = mountComment(content);

    expect(container.querySelector('span.rounded')?.textContent).toBe(content);
  });

  it('never places a script element or event-handler attribute in the DOM', () => {
    const { container } = mountComment(RAW_STORED_CONTENT);

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();

    const handlerAttributes = Array.from(container.querySelectorAll('*')).flatMap((element) =>
      Array.from(element.attributes)
        .map((attribute) => attribute.name.toLowerCase())
        .filter((name) => name.startsWith('on'))
    );

    expect(handlerAttributes).toEqual([]);
    expect(container.innerHTML).not.toContain('evil.test');
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it('still shows the imported text, emphasis and mention chip', () => {
    const { container } = mountComment(RAW_STORED_CONTENT);

    expect(container.textContent).toContain('Deploy notes');
    expect(container.textContent).toContain('still bold');
    expect(container.textContent).toContain('thanks');
    expect(container.querySelector('b')?.textContent).toBe('still bold');
    expect(container.querySelector('span.rounded')?.textContent).toBe('@alice');
  });

  it('does not rewrite the comment string it was given', () => {
    const { comment } = mountComment(RAW_STORED_CONTENT);

    // Render-time defence only: the stored/API value keeps its exact bytes.
    expect(comment.content).toBe(RAW_STORED_CONTENT);
    expect(comment.content).toContain('<script>window.__xss = 1</script>');
    expect(comment.version).toBe(1);
  });

  it('renders ordinary Markdown comments normally', () => {
    const { container } = mountComment('**bold** and [docs](https://example.com/docs)');

    expect(container.querySelector('strong')?.textContent).toBe('bold');
    const anchor = container.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe('https://example.com/docs');
    expect(anchor?.getAttribute('target')).toBe('_blank');
  });
});
