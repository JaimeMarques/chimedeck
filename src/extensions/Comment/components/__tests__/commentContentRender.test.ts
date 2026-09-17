// End-to-end render tests for comment content: markdown pipeline -> sanitizer -> HTML string.
//
// [why] The imported historical comment path stores source bytes verbatim, so these tests drive the
// real render helper from CommentItem.tsx and assert that whatever reaches
// dangerouslySetInnerHTML is safe, while ordinary Markdown keeps rendering exactly as before.
import { describe, expect, it } from 'bun:test';
import { JSDOM } from 'jsdom';
import type { Attachment } from '~/extensions/Attachments/types';

// The render helper uses ambient browser APIs (DOMParser, document, Node, HTMLBRElement...), so a
// jsdom window is installed before the component module is imported.
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
  Object.defineProperty(globalThis, key, {
    value:
      key === 'window' ? jsdomWindow : (jsdomWindow as unknown as Record<string, unknown>)[key],
    writable: true,
    configurable: true,
  });
}

const { renderCommentContentHtml } = await import('../CommentItem');

/** Raw historical comment content: HTML from the source system plus ordinary Markdown. */
const RAW_HISTORICAL_CONTENT =
  'Deploy notes\r\n<script>window.__xss = 1</script>\r\n' +
  '<img src="x" onerror="window.__xss = 2">\r\n' +
  '[download](javascript:alert(1))\r\n' +
  '<iframe src="https://evil.test/pwn"></iframe>\r\n' +
  '<b onclick="window.__xss = 4">still bold</b>\r\n' +
  '<div style="background:url(javascript:window.__xss = 5)">styled</div>\r\n' +
  'thanks @alice  ';

const imageAttachment = {
  id: 'att-1',
  card_id: 'card-1',
  name: 'screenshot.png',
  alias: null,
  type: 'FILE',
  status: 'READY',
  key: 'uploads/screenshot.png',
  thumbnail_key: 'uploads/thumbs/screenshot.png',
  content_type: 'image/png',
  size_bytes: 2048,
  width: 640,
  height: 480,
  view_url: '/api/attachments/att-1/view',
  thumbnail_url: '/api/attachments/att-1/thumb',
  external_url: null,
  referenced_card_id: null,
  referenced_card: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
} satisfies Attachment;

describe('renderCommentContentHtml — historical raw bytes', () => {
  it('returns HTML with no executable payload', () => {
    const html = renderCommentContentHtml(RAW_HISTORICAL_CONTENT, []);

    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('evil.test');
    expect(html).not.toContain('style=');
  });

  it('keeps the human-visible content of the same comment', () => {
    const html = renderCommentContentHtml(RAW_HISTORICAL_CONTENT, []);

    expect(html).toContain('Deploy notes');
    expect(html).toContain('still bold');
    expect(html).toContain('styled');
    expect(html).toContain('thanks');
    // Relative image src stays renderable; the event handler is what gets removed.
    expect(html).toContain('<img src="x">');
  });

  it('still renders the @mention chip for imported content', () => {
    const html = renderCommentContentHtml(RAW_HISTORICAL_CONTENT, []);

    expect(html).toContain(
      '<span class="rounded bg-blue-100 px-1 py-0.5 text-xs font-medium text-blue-700">@alice</span>'
    );
  });

  it('does not mutate the stored comment string and is deterministic', () => {
    const storedBefore = RAW_HISTORICAL_CONTENT;
    const first = renderCommentContentHtml(storedBefore, []);
    const second = renderCommentContentHtml(RAW_HISTORICAL_CONTENT, []);

    expect(storedBefore).toBe(RAW_HISTORICAL_CONTENT);
    expect(storedBefore).toContain('<script>');
    expect(first).toBe(second);
  });
});

describe('renderCommentContentHtml — ordinary Markdown is unchanged', () => {
  it('renders emphasis, links, code, quotes and lists', () => {
    const html = renderCommentContentHtml(
      '**bold** and *italic* with [docs](https://example.com/docs) and `inline code`\n\n' +
        '> quoted line\n\n' +
        '- first\n- second\n\n' +
        '1. one\n2. two\n\n' +
        '[missing link](https://example.com/target)',
      []
    );

    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('<code>inline code</code>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>first</li>');
    expect(html).toContain('<ol>');
    // Links keep opening in a new tab (pre-existing behaviour).
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('renders fenced code blocks with their language class and GFM tables', () => {
    const html = renderCommentContentHtml(
      '```ts\nconst a: number = 1;\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n',
      []
    );

    expect(html).toContain('<pre>');
    expect(html).toContain('<code class="language-ts">');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>a</th>');
    expect(html).toContain('<td>1</td>');
  });

  it('keeps hydrated attachment images and link normalization', () => {
    const html = renderCommentContentHtml(
      'See ![screenshot.png](attachment:screenshot.png) attached',
      [imageAttachment]
    );

    expect(html).toContain('<img src="/api/attachments/att-1/thumb" alt="screenshot.png">');
  });

  it('renders legacy escaped blockquote markers as quotes', () => {
    const html = renderCommentContentHtml('&gt; legacy quote marker', []);

    expect(html).toContain('<blockquote>');
  });
});
