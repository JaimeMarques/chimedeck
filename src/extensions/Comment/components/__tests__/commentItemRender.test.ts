// DOM-level guard for the historical-import XSS remediation.
//
// [why] The unit tests cover the sanitizer policy and the render helper's string output. This test
// closes the loop by mounting the real component under jsdom and asserting the live DOM contains no
// executable payload, while the comment string handed to the component stays byte-identical.
import { afterEach, describe, expect, it } from 'bun:test';
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
const { cleanup, render } = await import('@testing-library/react');
const { default: CommentItem } = await import('../CommentItem');

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

function mountComment(content: string, attachments: Attachment[] = []) {
  const comment = buildComment(content);
  const { container } = render(
    React.createElement(CommentItem, {
      comment,
      attachments,
      currentUserId: 'user-1',
      onEdit: async () => {},
      onDelete: async () => {},
    })
  );
  return { comment, container };
}

afterEach(() => {
  cleanup();
});

describe('CommentItem rendering of verbatim historical bytes', () => {
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
