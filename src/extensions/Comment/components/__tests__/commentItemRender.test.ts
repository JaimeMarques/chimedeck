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
  'MutationObserver',
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
const { boardGuestsApi } = await import('~/extensions/Board/slices/boardGuestsSlice');
const { default: CommentItem } = await import('../CommentItem');
const { default: apiClient } = await import('~/common/api/client');
function createStore() {
  return configureStore({
    reducer: {
      [boardMembersApi.reducerPath]: boardMembersApi.reducer,
      [boardGuestsApi.reducerPath]: boardGuestsApi.reducer,
    },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(boardMembersApi.middleware, boardGuestsApi.middleware),
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

function mountComment(content: string, attachments?: Attachment[], store = createStore(), boardId?: string) {
  const comment = buildComment(content);
  const buildElement = () => (
    React.createElement(Provider, { store, children: React.createElement(CommentItem, {
      comment,
      ...(attachments ? { attachments } : {}),
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

describe('comment image blob lifecycle', () => {
  it('recovers after more than thirty seconds pending and cancels retries on unmount', async () => {
    const originalAdapter = apiClient.defaults.adapter;
    const originalTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const flush = () => new Promise<void>((resolve) => originalTimeout(resolve, 0));
    const drainUntil = async (assertion: () => void) => {
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          assertion();
          return;
        } catch {
          await flush();
        }
      }
      assertion();
    };
    const timers = new Map<number, { callback: () => void; delay: number }>();
    let nextTimer = 100000;
    let elapsed = 0;
    let ready = false;
    let requests = 0;
    globalThis.setTimeout = ((callback: () => void, delay?: number) => {
      if (delay !== undefined && delay >= 1000 && delay <= 10000) {
        const id = ++nextTimer;
        timers.set(id, { callback, delay });
        return id;
      }
      return originalTimeout(callback, delay);
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => {
      if (!timers.delete(id)) originalClearTimeout(id);
    }) as typeof clearTimeout;
    const create = spyOn(URL, 'createObjectURL').mockReturnValue('blob:ready');
    const revoke = spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    apiClient.defaults.adapter = (config) => {
      requests++;
      const data = ready ? new Blob(['image'], { type: 'image/png' }) :
        new Blob([JSON.stringify({ name: 'attachment-pending' })], { type: 'application/json' });
      return Promise.resolve({ data, status: ready ? 200 : 202, statusText: 'OK', headers: {}, config });
    };
    const image = { id: 'image', name: 'image.png', type: 'FILE', view_url: '/api/v1/attachments/image/view', thumbnail_url: null } as Attachment;
    const store = createStore();
    let mounted: ReturnType<typeof render> | undefined;
    try {
      mounted = render(React.createElement(Provider, { store, children: React.createElement(CommentItem, {
        comment: buildComment('![image.png](attachment:image.png)'), attachments: [image],
        currentUserId: 'reader', onEdit: async () => {}, onDelete: async () => {},
      }) }));
      await drainUntil(() => {
        expect(mounted?.container.querySelector('[role="status"]')?.textContent).toContain('processed');
      });
      expect(mounted.container.querySelector('img')?.hidden).toBe(true);
      while (elapsed <= 30000) {
        await drainUntil(() => {
          expect(timers.size).toBe(1);
        });
        const entry = timers.entries().next().value;
        if (!entry) throw new Error('Missing scan retry');
        timers.delete(entry[0]);
        elapsed += entry[1].delay;
        entry[1].callback();
      }
      expect(mounted.container.querySelector('[role="status"]')?.textContent).toContain('processed');
      expect(mounted.container.querySelector('img')?.hidden).toBe(true);
      expect(create).not.toHaveBeenCalled();
      ready = true;
      await drainUntil(() => {
        expect(mounted?.container.querySelector('img')?.getAttribute('src')).toBe('blob:ready');
      });
      expect(mounted.container.querySelector('img')?.hidden).toBe(false);
      expect(mounted.container.querySelector('[role="status"]')).toBeNull();
      expect(timers.size).toBe(0);
      ready = false;
      mounted.rerender(React.createElement(Provider, { store, children: React.createElement(CommentItem, {
        comment: buildComment('![image.png](attachment:image.png)\nRetry again'), attachments: [{ ...image }],
        currentUserId: 'reader', onEdit: async () => {}, onDelete: async () => {},
      }) }));
      await drainUntil(() => {
        expect(timers.size).toBe(1);
      });
      const retained = timers.values().next().value;
      if (!retained) throw new Error('Missing retry to cancel');
      mounted.unmount();
      expect(timers.size).toBe(0);
      const requestsAtUnmount = requests;
      retained.callback();
      await flush();
      expect(requests).toBe(requestsAtUnmount);
    } finally {
      mounted?.unmount();
      for (const timer of timers.keys()) originalClearTimeout(timer);
      timers.clear();
      if (originalAdapter === undefined) delete apiClient.defaults.adapter;
      else apiClient.defaults.adapter = originalAdapter;
      globalThis.setTimeout = originalTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      create.mockRestore();
      revoke.mockRestore();
    }
  });

  it('restores retained image sources on rerender and ignores late hydration after unmount', async () => {
    const originalAdapter = apiClient.defaults.adapter;
    let sequence = 0;
    const create = spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:test-${String(++sequence)}`);
    const revoke = spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    let requests = 0;
    const image = { id: 'image', name: 'image.png', type: 'FILE', view_url: '/api/v1/attachments/image/view', thumbnail_url: null } as Attachment;
    const comment = buildComment('![image.png](attachment:image.png)');
    let resolveLate: ((value: Blob) => void) | undefined;
    let late = false;
    apiClient.defaults.adapter = async (config) => {
      requests++;
      const data = late ? await new Promise<Blob>((resolve) => { resolveLate = resolve; }) : new Blob(['image'], { type: 'image/png' });
      return { data, status: 200, statusText: 'OK', headers: {}, config };
    };
    const props = { comment, images: undefined, currentUserId: 'reader', onEdit: async () => {}, onDelete: async () => {} };
    const store = createStore();
    try {
      const mounted = render(React.createElement(Provider, { store, children: React.createElement(
        React.StrictMode,
        null,
        React.createElement(CommentItem, { ...props, attachments: [image] }),
      ) }));
      await waitFor(() => { expect(mounted.container.querySelector('img')?.getAttribute('src')).toBe('blob:test-1'); });
      const retainedImage = mounted.container.querySelector('img');
      if (!retainedImage) throw new Error('Comment image did not mount');
      expect(retainedImage.getAttribute('data-comment-image-source')).toBe(image.view_url);
      expect(requests).toBe(2);
      mounted.rerender(React.createElement(Provider, { store, children: React.createElement(
        React.StrictMode,
        null,
        React.createElement(CommentItem, { ...props, attachments: [{ ...image }] }),
      ) }));
      await Promise.resolve();
      expect(retainedImage.getAttribute('src')).toBe('blob:test-1');
      expect(requests).toBe(2);
      expect(create).toHaveBeenCalledTimes(1);
      expect(revoke).not.toHaveBeenCalled();

      const sourceMutations: Array<string | null> = [];
      const observer = new MutationObserver((records) => {
        sourceMutations.push(...records
          .filter((record) => record.attributeName === 'src')
          .map((record) => (record.target as HTMLImageElement).getAttribute('src')));
      });
      observer.observe(retainedImage, { attributes: true, attributeFilter: ['src'] });
      late = true;
      mounted.rerender(React.createElement(Provider, { store, children: React.createElement(
        React.StrictMode,
        null,
        React.createElement(CommentItem, {
          ...props,
          comment: buildComment('![image.png](attachment:image.png)\nChanged content'),
          attachments: [{ ...image }],
        }),
      ) }));
      await waitFor(() => { expect(resolveLate).toBeDefined(); });
      await Promise.resolve();
      expect(retainedImage.getAttribute('data-comment-image-source')).toBe(image.view_url);
      expect(sourceMutations).not.toContain(image.view_url);
      mounted.unmount();
      observer.disconnect();
      resolveLate?.(new Blob(['image'], { type: 'image/png' }));
      await Promise.resolve();
      expect(requests).toBe(3);
      expect(create).toHaveBeenCalledTimes(1);
      expect(revoke).toHaveBeenCalledWith('blob:test-1');
    } finally {
      if (originalAdapter === undefined) delete apiClient.defaults.adapter;
      else apiClient.defaults.adapter = originalAdapter;
      create.mockRestore();
      revoke.mockRestore();
    }
  });
});

describe('CommentItem rendering of verbatim historical bytes', () => {
  it.each(['provided', 'omitted'])('keeps hydrated links and images across roster updates with %s attachments', async (attachmentMode) => {
    const store = createStore();
    const userId = 'a1234567-89ab-4cde-8fab-0123456789ab';
    await store.dispatch(boardMembersApi.util.upsertQueryData('getBoardMembers', 'board-1', []));
    await store.dispatch(boardGuestsApi.util.upsertQueryData('getBoardGuests', 'board-1', []));
    const attachments: Attachment[] | undefined = attachmentMode === 'provided' ? [] : undefined;
    const originalAdapter = apiClient.defaults.adapter;
    let imageRequests = 0;
    apiClient.defaults.adapter = (config) => {
      imageRequests += 1;
      return Promise.resolve({ data: new Blob(['image'], { type: 'image/png' }), status: 200, statusText: 'OK', headers: {}, config });
    };
    let objectUrlCount = 0;
    const createObjectUrl = spyOn(URL, 'createObjectURL').mockImplementation(() => {
      objectUrlCount += 1;
      return `blob:test-hydrated-image-${String(objectUrlCount)}`;
    });
    const revokeObjectUrl = spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    try {
      const { container, rerender } = mountComment(
        `@${userId} [docs](https://example.com/docs) ![image](/api/v1/attachments/image-id/view)`,
        attachments, store, 'board-1',
      );
      await waitFor(() => {
        expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:test-hydrated-image-1');
      });
      expect(container.querySelector('a')?.classList.contains('cd-link-button')).toBe(true);
      expect(container.querySelector('span.rounded')?.textContent).toBe(`@${userId}`);
      expect(imageRequests).toBe(1);
      expect(revokeObjectUrl).not.toHaveBeenCalled();

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
        expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:test-hydrated-image-2');
        expect(imageRequests).toBe(2);
      });
      expect(revokeObjectUrl).toHaveBeenCalledWith('blob:test-hydrated-image-1');
      expect(revokeObjectUrl).toHaveBeenCalledTimes(1);

      // A roster change that renders the same label must retain the hydrated DOM.
      await act(async () => {
        await store.dispatch(boardMembersApi.util.upsertQueryData('getBoardMembers', 'board-1', [
          { ...member, display_name: 'Alice Updated' },
        ]));
      });
      expect(imageRequests).toBe(2);
      expect(container.querySelector('a')?.classList.contains('cd-link-button')).toBe(true);
      expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:test-hydrated-image-2');
      rerender();
      expect(imageRequests).toBe(2);
      expect(container.querySelector('a')?.classList.contains('cd-link-button')).toBe(true);
      expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:test-hydrated-image-2');
      expect(revokeObjectUrl).toHaveBeenCalledTimes(1);
      cleanup();
      expect(revokeObjectUrl).toHaveBeenCalledWith('blob:test-hydrated-image-2');
      expect(revokeObjectUrl).toHaveBeenCalledTimes(2);
    } finally {
      cleanup();
      if (originalAdapter === undefined) delete apiClient.defaults.adapter;
      else apiClient.defaults.adapter = originalAdapter;
      createObjectUrl.mockRestore();
      revokeObjectUrl.mockRestore();
    }
  });

  it('keeps UUIDs when the only fallback label is an email or whitespace', async () => {
    const store = createStore();
    const emailId = 'a1234567-89ab-4cde-8fab-0123456789ab';
    const blankId = 'b1234567-89ab-4cde-8fab-0123456789ab';
    const nicknameId = 'c1234567-89ab-4cde-8fab-0123456789ab';
    const member = {
      board_id: 'board-1', role: 'MEMBER' as const, email: 'member@example.com',
      avatar_url: null, created_at: '2026-01-01T00:00:00.000Z',
    };
    await store.dispatch(boardGuestsApi.util.upsertQueryData('getBoardGuests', 'board-1', []));
    await store.dispatch(boardMembersApi.util.upsertQueryData('getBoardMembers', 'board-1', [
      { ...member, user_id: emailId, nickname: null, display_name: '  MEMBER@EXAMPLE.COM  ' },
      { ...member, user_id: blankId, nickname: ' ', display_name: '  ' },
      { ...member, user_id: nicknameId, nickname: ' readable ', display_name: member.email },
    ]));
    const { container } = mountComment(`@${emailId} @${blankId} @${nicknameId}`, undefined, store, 'board-1');

    expect(Array.from(container.querySelectorAll('span.rounded'), (chip) => chip.textContent)).toEqual([`@${emailId}`, `@${blankId}`, '@readable']);
    expect(container.textContent).not.toContain('member@example.com');
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
    await store.dispatch(boardGuestsApi.util.upsertQueryData('getBoardGuests', 'board-1', []));
    await store.dispatch(boardMembersApi.util.upsertQueryData('getBoardMembers', 'board-1', [
      { ...member, user_id: aliceId, nickname: 'alice', display_name: 'Alice Smith' },
      { ...member, user_id: bobId, nickname: '', display_name: 'Bob Jones' },
    ]));
    const content = `@${aliceId} @${bobId} @${unknownId}`;
    const { container, comment } = mountComment(content, [], store, 'board-1');

    expect(Array.from(container.querySelectorAll('span.rounded'), (chip) => chip.textContent)).toEqual(['@alice', '@Bob Jones', `@${unknownId}`]);
    expect(comment.content).toBe(content);
  });

  it('resolves UUID mentions for board guests as well as members', async () => {
    const store = createStore();
    const guestId = 'd1234567-89ab-4cde-8fab-0123456789ab';
    await store.dispatch(boardMembersApi.util.upsertQueryData('getBoardMembers', 'board-1', []));
    await store.dispatch(boardGuestsApi.util.upsertQueryData('getBoardGuests', 'board-1', [
      { id: guestId, email: 'guest@example.com', name: 'Guest Name', guestType: 'VIEWER',
        granted_at: '2026-01-01T00:00:00Z', granted_by: 'owner' },
    ]));
    const { container } = mountComment(`Hello @${guestId}`, [], store, 'board-1');
    expect(container.querySelector('span.rounded')?.textContent).toBe('@Guest Name');
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
