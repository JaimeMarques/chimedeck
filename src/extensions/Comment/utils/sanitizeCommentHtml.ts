// Render-time sanitizer for comment HTML.
//
// [why] Historical imports persist comment content byte-for-byte so the stored/API value stays
// faithful to the source system. Raw HTML from the source therefore reaches the comment renderer
// without passing the server-side sanitizeRichText hop that normal user input goes through
// (see server/extensions/comment/api/create.ts). Sanitizing the parsed HTML here is the last line
// of defence: the API/database string is never rewritten — only the HTML string we hand to
// dangerouslySetInnerHTML is constrained to a known-safe subset.
//
// The allow-list is a superset of the backend's sanitizeRichText tag set because rendering needs
// what marked/Markdown plus this feature emit (images, mention chips, task-list checkboxes, tables).
import createDOMPurify, { type Config } from 'dompurify';

/** Tags the comment renderer must keep: marked's Markdown output plus what the render pipeline adds. */
export const COMMENT_ALLOWED_TAGS: string[] = [
  // block structure from Markdown
  'p',
  'br',
  'hr',
  'div',
  'span',
  'blockquote',
  'pre',
  'code',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'figure',
  'figcaption',
  // inline emphasis and semantics
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'del',
  'ins',
  'mark',
  'small',
  'sup',
  'sub',
  'abbr',
  'cite',
  'q',
  'kbd',
  'samp',
  'var',
  'time',
  'wbr',
  // links and attachments
  'a',
  'img',
  // GFM tables and task lists
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
  'input',
  'details',
  'summary',
];

/**
 * Attribute allow-list. DOMPurify 3 resolves ALLOWED_ATTR to a flat set of attribute names
 * (there is no per-tag form any more), so every entry here is allowed on every allowed tag.
 * Event handlers (on*) and inline styles (style) are absent on purpose.
 */
export const COMMENT_ALLOWED_ATTR: string[] = [
  'class',
  'href',
  'title',
  'target',
  'rel',
  'src',
  'alt',
  'width',
  'height',
  'loading',
  'type',
  'checked',
  'disabled',
  'align',
  'colspan',
  'rowspan',
  'start',
  'cite',
  'datetime',
  'dir',
  'lang',
];

/** High-risk tags that must never come back, even if the allow-list above is edited later. */
export const COMMENT_FORBID_TAGS: string[] = [
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'form',
  'button',
  'select',
  'textarea',
  'option',
  'link',
  'meta',
  'base',
  'template',
  'svg',
  'math',
  'audio',
  'video',
  'source',
  'track',
  'canvas',
  'marquee',
  'noscript',
  'plaintext',
];

/** Attributes that would reintroduce script URLs or inline CSS even if their tag is allowed. */
export const COMMENT_FORBID_ATTR: string[] = [
  'style',
  'srcset',
  'ping',
  'background',
  'poster',
  'action',
  'formaction',
  'method',
  'xlink:href',
  'contenteditable',
  'srcdoc',
  'http-equiv',
  'is',
];

/**
 * Mirrors the backend scheme allow-list (server/common/sanitize.ts) plus tel:, and keeps relative
 * URLs working so attachment proxy paths such as /api/attachments/<id>/view still resolve.
 * Everything else — javascript:, vbscript:, data:, file:, blob: — is dropped by DOMPurify.
 */
export const COMMENT_ALLOWED_URI_REGEXP =
  /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

export const COMMENT_SANITIZE_CONFIG: Config = {
  ALLOWED_TAGS: COMMENT_ALLOWED_TAGS,
  ALLOWED_ATTR: COMMENT_ALLOWED_ATTR,
  FORBID_TAGS: COMMENT_FORBID_TAGS,
  FORBID_ATTR: COMMENT_FORBID_ATTR,
  ALLOWED_URI_REGEXP: COMMENT_ALLOWED_URI_REGEXP,
  // [why] ARIA and data-* attributes let untrusted content spoof assistive-tech semantics or stash
  // state the renderer never asked for; nothing in the Markdown pipeline emits them.
  ALLOW_ARIA_ATTR: false,
  ALLOW_DATA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  // [why] Keep the text of unknown tags (e.g. a historical <acronym>) instead of losing content.
  KEEP_CONTENT: true,
  RETURN_TRUSTED_TYPE: false,
};

export type CommentHtmlSanitizer = (html: string) => string;

/**
 * Build a sanitizer bound to one DOM window. Exported so tests (and any future non-browser entry
 * point) can inject their own window instead of relying on the ambient global one.
 */
export function createCommentHtmlSanitizer(domWindow: unknown): CommentHtmlSanitizer {
  // [why] Explicitly fail closed: DOMPurify falls back to whatever ambient global window it can
  // find, which would silently sanitize against a document we did not choose.
  if (!domWindow) return () => '';
  const purifier = createDOMPurify(domWindow as Window & typeof globalThis);
  if (!purifier.isSupported) return () => '';
  return (html: string): string =>
    typeof html === 'string' && html.length > 0
      ? (purifier.sanitize(html, COMMENT_SANITIZE_CONFIG) as string)
      : '';
}

// [why] Fail closed: if no DOM is available we render nothing rather than inject unsanitized HTML.
const failClosedSanitizer: CommentHtmlSanitizer = () => '';

let boundSanitizer: CommentHtmlSanitizer | null = null;
let reportedMissingDom = false;

function resolveSanitizer(): CommentHtmlSanitizer {
  if (boundSanitizer) return boundSanitizer;

  const domWindow = (globalThis as { window?: unknown }).window;
  if (!domWindow) {
    if (!reportedMissingDom) {
      reportedMissingDom = true;
      console.error(
        '[comment] refusing to render comment content: no DOM available for sanitization'
      );
    }
    return failClosedSanitizer;
  }

  boundSanitizer = createCommentHtmlSanitizer(domWindow);
  return boundSanitizer;
}

/**
 * Sanitize already-parsed comment HTML for rendering. The stored/API comment content string is
 * never touched — callers keep the exact value they received from the API.
 */
export function sanitizeCommentHtml(html: string): string {
  return resolveSanitizer()(html);
}
