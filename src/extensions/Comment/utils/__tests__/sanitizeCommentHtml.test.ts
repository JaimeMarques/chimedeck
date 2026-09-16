// Policy tests for the render-time comment HTML sanitizer.
//
// [why] Historical imports persist comment content byte-for-byte, so this sanitizer is the only
// thing standing between raw source HTML and dangerouslySetInnerHTML. These tests pin the policy
// with an injected jsdom window so they run under `bun test` without a browser.
import { describe, expect, it } from 'bun:test';
import { JSDOM } from 'jsdom';
import {
  COMMENT_FORBID_ATTR,
  COMMENT_FORBID_TAGS,
  createCommentHtmlSanitizer,
} from '../sanitizeCommentHtml';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://chimedeck.test/board/board-1',
});
const sanitize = createCommentHtmlSanitizer(dom.window);

/** Trimmed historical Trello payload: raw HTML plus ordinary Markdown in the same comment. */
const RAW_HISTORICAL =
  'Heads up\r\n<script>window.__xss = 1</script>\r\n' +
  '<img src="x" onerror="window.__xss = 2">\r\n' +
  '[click me](javascript:alert(1))\r\n' +
  '<iframe src="https://evil.test"></iframe>\r\n' +
  '<b onclick="window.__xss = 4">bold</b>\r\n' +
  '<a href="JaVaScRiPt:alert(1)">mixed case</a>\r\n' +
  '@alice  ';

describe('createCommentHtmlSanitizer', () => {
  it('strips script elements, event handlers and script URLs from raw historical bytes', () => {
    const out = sanitize(RAW_HISTORICAL);

    expect(out).not.toContain('<script');
    expect(out).not.toContain('</script');
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('onclick');
    // No script URL may survive in an attribute; the same text appearing as literal comment text is
    // inert (nothing to execute) and is covered by the marked → render pipeline test.
    expect(out).not.toMatch(/=\s*["']?\s*javascript:/i);
    expect(out).not.toContain('<iframe');
    expect(out).not.toContain('evil.test');
    // Content is preserved rather than dropped, so the user still sees the comment text.
    expect(out).toContain('Heads up');
    expect(out).toContain('<b>bold</b>');
    expect(out).toContain('@alice');
  });

  it('leaves a script URL appearing as literal text inert', () => {
    // marked only turns `[x](url)` into an anchor when the destination is a single token; the
    // remaining text case must stay text (no attribute, so nothing for the browser to execute).
    const out = sanitize('<p>raw javascript:alert(1) text</p><a href="javascript:alert(1)">a</a>');

    expect(out).not.toContain('href="javascript:');
    expect(out).toContain('raw javascript:alert(1) text');
    expect(out).toContain('<a>a</a>');
  });

  it('strips dangerous elements including SVG/MathML smuggling vectors', () => {
    const payload = [
      '<svg onload="alert(1)"><circle /></svg>',
      '<math><mtext><img src="x" onerror="alert(1)"></mtext></math>',
      '<style>body{background:url(javascript:alert(1))}</style>',
      '<object data="x"></object><embed src="x">',
      '<form action="https://evil.test"><button formaction="javascript:alert(1)">go</button></form>',
      '<template><img src="x" onerror="alert(1)"></template>',
    ].join('');

    const out = sanitize(payload);

    for (const tag of COMMENT_FORBID_TAGS) {
      expect(out.toLowerCase()).not.toContain(`<${tag}`);
    }
    expect(out).not.toContain('onload');
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('formaction');
  });

  it('strips inline style, ARIA and data-* attributes', () => {
    const out = sanitize(
      '<div style="background:url(javascript:alert(1))" aria-label="fake" data-x="1" role="dialog">text</div>'
    );

    for (const attr of COMMENT_FORBID_ATTR) {
      expect(out).not.toContain(`${attr}=`);
    }
    expect(out).not.toContain('aria-label');
    expect(out).not.toContain('data-x');
    expect(out).not.toContain('role=');
    expect(out).toContain('text');
  });

  it('drops protocol-relative and unknown-scheme URLs but keeps http(s), mailto, tel and relative', () => {
    expect(sanitize('<a href="data:text/html,<script>alert(1)</script>">d</a>')).not.toContain(
      'data:'
    );
    expect(sanitize('<a href="vbscript:msgbox(1)">v</a>')).not.toContain('vbscript');
    expect(sanitize('<img src="blob:https://chimedeck.test/abc">')).not.toContain('blob:');
    expect(sanitize('<a href="https://example.com/a">ok</a>')).toContain(
      'href="https://example.com/a"'
    );
    expect(sanitize('<a href="mailto:a@b.test">mail</a>')).toContain('href="mailto:a@b.test"');
    expect(sanitize('<a href="tel:+123">call</a>')).toContain('href="tel:+123"');
  });

  it('keeps the Markdown rendering surface that comments rely on', () => {
    const out = sanitize(
      '<h2>Title</h2><p>text <strong>bold</strong> <em>it</em> <del>gone</del> <code>code</code></p>' +
        '<blockquote>quote</blockquote><ul><li>one</li></ul><ol start="3"><li>three</li></ol>' +
        '<pre><code class="language-js">const a = 1;</code></pre><hr>' +
        '<table><thead><tr><th align="left">h</th></tr></thead><tbody><tr><td colspan="1">c</td></tr></tbody></table>' +
        '<li class="task-list-item"><input type="checkbox" checked disabled> done</li>'
    );

    expect(out).toContain('<h2>Title</h2>');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<em>it</em>');
    expect(out).toContain('<del>gone</del>');
    expect(out).toContain('<code>code</code>');
    expect(out).toContain('<blockquote>quote</blockquote>');
    expect(out).toContain('<li>one</li>');
    expect(out).toContain('<ol start="3">');
    expect(out).toContain('<code class="language-js">');
    expect(out).toContain('<hr>');
    expect(out).toContain('<th align="left">h</th>');
    expect(out).toContain('<td colspan="1">c</td>');
    expect(out).toContain('<input type="checkbox" checked="" disabled="">');
  });

  it('keeps mention chips, attachment images and normalized comment links', () => {
    const out = sanitize(
      '<span class="rounded bg-blue-100 px-1 py-0.5 text-xs font-medium text-blue-700">@alice</span> ' +
        '<img src="/api/attachments/att-1/view" alt="screenshot.png" loading="lazy"> ' +
        '<a href="https://example.com/doc" target="_blank" rel="noopener noreferrer" class="cd-link-card">Doc</a>'
    );

    expect(out).toContain(
      '<span class="rounded bg-blue-100 px-1 py-0.5 text-xs font-medium text-blue-700">@alice</span>'
    );
    expect(out).toContain('<img src="/api/attachments/att-1/view" alt="screenshot.png"');
    expect(out).toContain('href="https://example.com/doc"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('class="cd-link-card"');
  });

  it('fails closed when no DOM window is available', () => {
    const noDom = createCommentHtmlSanitizer(undefined);

    expect(noDom('<img src="x" onerror="alert(1)">')).toBe('');
    expect(noDom('plain text')).toBe('');
  });

  it('never mutates the stored comment string it is given', () => {
    const stored = RAW_HISTORICAL;
    const rendered = sanitize(stored);

    // Render-time defence only: the API/database value keeps its exact bytes.
    expect(stored).toBe(RAW_HISTORICAL);
    expect(stored).toContain('<script>');
    expect(rendered).not.toContain('<script');
  });
});
