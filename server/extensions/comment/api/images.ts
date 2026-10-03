import type { Knex } from 'knex';
import { db } from '../../../common/db';
import { env } from '../../../config/env';
import { serializeAttachment, type AttachmentRow } from '../../attachment/api/serializeAttachment';

export function commentImageIds(content: string, ownOrigin?: string): string[] {
  const ownOrigins = new Set(ownOrigin ? [ownOrigin] : []);
  try { ownOrigins.add(new URL(env.APP_URL).origin); } catch { /* Invalid configuration cannot authorize an origin. */ }
  const ids = Array.from(content.matchAll(/attachment:id:([a-f0-9-]{36})/gi), (match) => (match[1] ?? '').toLowerCase());
  for (const match of content.matchAll(/https?:\/\/[^\s)"'<>]+|\/api\/v1\/attachments\/[^\s)"'<>]+/g)) {
    const value = match[0];
    const absolute = /^https?:\/\//i.test(value);
    let url: URL;
    try { url = new URL(value, ownOrigin ?? 'http://comment.invalid'); } catch { continue; }
    if (absolute && !ownOrigins.has(url.origin)) continue;
    const id = /^\/api\/v1\/attachments\/([a-f0-9-]{36})\/(?:view|thumbnail)$/.exec(url.pathname)?.[1];
    if (id) ids.push(id.toLowerCase());
  }
  return [...new Set(ids)];
}

export class InvalidCommentImage extends Error {}

// [why] Lock before claiming so concurrent comments cannot steal an upload.
export async function associateCommentImages({
  trx, content, cardId, userId, commentId, ownOrigin, previousContent,
}: { trx: Knex.Transaction; content: string; cardId: string; userId: string; commentId: string; ownOrigin?: string; previousContent?: string }): Promise<void> {
  const ids = commentImageIds(content, ownOrigin);
  await trx('attachments').where({ comment_id: commentId }).whereNotIn('id', ids)
    .update({ comment_id: null, abandoned_at: new Date().toISOString() });
  if (!ids.length) return;
  const images = await trx<AttachmentRow & { uploaded_by: string; upload_confirmed_at: string | null }>('attachments').whereIn('id', ids).forUpdate();
  const previousIds = new Set(commentImageIds(previousContent ?? '', ownOrigin));
  const missingNewImage = ids.some((id) => !images.some((image) => image.id === id) &&
    content.toLowerCase().includes(`attachment:id:${id}`) && !previousIds.has(id));
  if (missingNewImage || images.some((image) =>
    (image.upload_context === 'comment' && (
    image.card_id !== cardId || !image.mime_type?.startsWith('image/') || image.uploaded_by !== userId ||
    (image.status !== 'READY' &&
      !(image.upload_confirmed_at && ['PENDING', 'SCANNING'].includes(image.status)) &&
      !(image.comment_id === commentId && previousIds.has(image.id))) ||
    (image.comment_id && image.comment_id !== commentId)))
  )) {
    throw new InvalidCommentImage('Comment images must be ready uploads owned by this author on this card');
  }
  await trx('attachments').whereIn('id', ids).where({ upload_context: 'comment' })
    .update({ comment_id: commentId, abandoned_at: null });
}

export async function loadCommentImages(comments: Array<{ id: string; card_id: string; content: string }>) {
  const result = new Map<string, ReturnType<typeof serializeAttachment>[]>();
  if (!comments.length || !comments.some((comment) => comment.content.includes('attachment:') || comment.content.includes('/api/v1/attachments/'))) return result;
  const rows = await db<AttachmentRow>('attachments')
    .whereIn('card_id', [...new Set(comments.map((comment) => comment.card_id))])
    .where((query) => { void query.whereIn('comment_id', comments.map((comment) => comment.id)).orWhere('upload_context', 'card'); });
  for (const comment of comments) {
    const referencedIds = new Set(commentImageIds(comment.content));
    const legacyNames = Array.from(comment.content.matchAll(/attachment:(?!id:)([^\s)"'<>]+)/g), (match) => {
      try { return decodeURIComponent(match[1] ?? ''); } catch { return match[1] ?? ''; }
    });
    result.set(comment.id, rows.filter((row) => row.card_id === comment.card_id &&
      (row.comment_id === comment.id || (row.upload_context !== 'comment' && (legacyNames.includes(row.name) || referencedIds.has(row.id)))))
      .map((row) => serializeAttachment(row, {})));
  }
  return result;
}
