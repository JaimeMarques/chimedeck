// [why] This isolated process implements a deliberately small, untyped Knex
// double; promises preserve the real handler boundary without external services.
/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/restrict-template-expressions */
import { mock } from 'bun:test';
import assert from 'node:assert/strict';

const scenario = process.argv[2]!;
const cardId = 'card';
const userId = 'user';
const imageId = '11111111-1111-4111-8111-111111111111';
type Row = Record<string, unknown>;
const attachments: Row[] = [];
const events: string[] = [];
let completions = 0;
const rows: Record<string, Row[]> = {
  attachments, cards: [{ id: cardId, list_id: 'list', title: 'Card' }],
  lists: [{ id: 'list', board_id: 'board' }], boards: [{ id: 'board', workspace_id: 'workspace' }],
};
function query(table: string, filters: Array<(row: Row) => boolean> = []) {
  function predicate(key: unknown, value?: unknown, compare?: unknown): (row: Row) => boolean {
    if (typeof key === 'function') {
      const group: Array<(row: Row) => boolean> = [];
      key(query(table, group));
      return (row) => group.every((filter) => filter(row));
    }
    if (typeof key === 'string') return value === '<'
      ? (row) => typeof row[key] === 'string' && row[key] !== '' && row[key] < String(compare)
      : (row) => row[key] === value;
    return (row) => Object.entries(key as Row).every(([k, v]) => (row[k] ?? null) === v);
  }
  const q = {
    where: (key: unknown, value?: unknown, compare?: unknown) => {
      filters.push(predicate(key, value, compare));
      return q;
    },
    orWhere: (key: unknown, value?: unknown) => {
      const previous = filters.pop() ?? (() => false);
      const next = predicate(key, value);
      filters.push((row) => previous(row) || next(row));
      return q;
    },
    whereNull: (key: string) => { filters.push((row) => row[key] == null); return q; },
    whereIn: (key: string, values: unknown[]) => { filters.push((row) => values.includes(row[key])); return q; },
    whereNotIn: (key: string, values: unknown[]) => { filters.push((row) => !values.includes(row[key])); return q; },
    forUpdate: () => q,
    first: async () => (rows[table] ?? []).find((row) => filters.every((f) => f(row))),
    insert: async (row: Row) => { rows[table]!.push(row); },
    update: async (values: Row) => {
      if (scenario === 'delete-rollback' && table === 'attachments') throw new Error('Synthetic abandonment failure');
      for (const row of rows[table] ?? []) if (filters.every((f) => f(row))) Object.assign(row, values);
    },
    delete: async () => { rows[table] = (rows[table] ?? []).filter((row) => !filters.every((filter) => filter(row))); },
    then: (resolve: (value: Row[]) => unknown) => Promise.resolve((rows[table] ?? []).filter((row) => filters.every((f) => f(row)))).then(resolve),
  };
  return q;
}
void mock.module('../../../common/db', () => ({ db: Object.assign(query, { transaction: async (callback: (trx: typeof query) => Promise<unknown>) => {
  const snapshot = structuredClone(rows);
  try { return await callback(query); } catch (error) { Object.assign(rows, snapshot); throw error; }
} }) }));
void mock.module('../../../config/env', () => ({ env: { APP_URL: 'https://deck.example.test' } }));
void mock.module('../../attachment/mods/s3/deleteObject', () => ({ deleteObject: async ({ s3Key }: { s3Key: string }) => { events.push(s3Key); } }));
void mock.module('../../auth/middlewares/authentication', () => ({
  authenticate: async (req: Request & { currentUser?: { id: string } }) => { req.currentUser = { id: userId }; return null; },
}));
void mock.module('../../../middlewares/permissionManager', () => ({
  requireWorkspaceMembership: async () => scenario === 'denied' ? new Response('', { status: 403 }) : null,
  requireMemberOrBoardGuestMember: async () => null,
  hasRole: () => false,
}));
void mock.module('../../../common/ids/resolveEntityId', () => ({ resolveCardId: async () => cardId }));
void mock.module('../../../common/ids/shortId', () => ({ generateUniqueShortId: async () => 'short' }));
void mock.module('../../attachment/common/config/s3', () => ({
  s3Config: { bucket: 'test' },
  s3ServerClient: { send: async (command: object) => {
    if (command.constructor.name === 'CompleteMultipartUploadCommand') completions++;
    return { UploadId: 'upload' };
  } },
}));
void mock.module('../../attachment/mods/s3/presignPut', () => ({ presignPut: async () => 'https://example.test/upload' }));
void mock.module('../../attachment/mods/s3/headObject', () => ({ headObject: async () => true }));
void mock.module('../../attachment/mods/virusScan/enqueue', () => ({
  enqueueScan: async ({ attachmentId }: { attachmentId: string }) => { attachments.find((row) => row.id === attachmentId)!.status = 'READY'; },
}));
void mock.module('../../../mods/events/dispatch', () => ({ dispatchEvent: async () => { events.push('added'); } }));
void mock.module('../../../mods/events/write', () => ({ writeEvent: async () => { events.push('added'); } }));
void mock.module('../../activity/mods/write', () => ({ writeActivity: async () => { events.push('activity'); } }));
void mock.module('../../../mods/pubsub/publisher', () => ({ publisher: { publish: async () => { events.push('published'); } } }));

function request(body: object) {
  return new Request('http://localhost/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

if (scenario.startsWith('delete-')) {
  rows.comments = [{ id: 'comment', card_id: cardId, user_id: userId, content: 'Image', version: 1, deleted: false }];
  attachments.push({ id: imageId, comment_id: 'comment', upload_context: 'comment', abandoned_at: null });
  const { handleDeleteComment } = await import('./delete');
  if (scenario === 'delete-rollback') {
    await assert.rejects(handleDeleteComment(request({}), 'comment'));
    assert.equal(rows.comments[0]!.deleted, false);
    assert.equal(rows.attachments![0]!.comment_id, 'comment');
    assert.equal(events.length, 0);
  } else {
    assert.equal((await handleDeleteComment(request({}), 'comment')).status, 200);
    assert.equal(rows.comments[0]!.deleted, true);
    assert.equal(attachments[0]!.comment_id, null);
    assert.equal(typeof attachments[0]!.abandoned_at, 'string');
  }
} else if (scenario === 'cleanup-drafts') {
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const recent = new Date().toISOString();
  const staleDraft = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  attachments.push(
    { id: 'draft-ready', type: 'FILE', status: 'READY', upload_context: 'comment', comment_id: null, upload_confirmed_at: old, abandoned_at: null, created_at: old },
    { id: 'draft-scanning', type: 'FILE', status: 'PENDING', upload_context: 'comment', comment_id: null, upload_confirmed_at: old, abandoned_at: null, created_at: old },
    { id: 'abandoned', type: 'FILE', status: 'READY', upload_context: 'comment', comment_id: null, upload_confirmed_at: old, abandoned_at: old, created_at: old, s3_key: 'abandoned-object' },
    { id: 'removed-recently', type: 'FILE', status: 'READY', upload_context: 'comment', comment_id: null, upload_confirmed_at: old, abandoned_at: recent, created_at: old },
    { id: 'unfinished', type: 'FILE', status: 'PENDING', upload_context: 'comment', comment_id: null, upload_confirmed_at: null, abandoned_at: null, created_at: old, s3_key: 'unfinished-object' },
    { id: 'published', type: 'FILE', status: 'PENDING', upload_context: 'comment', comment_id: 'comment', upload_confirmed_at: old, abandoned_at: null, created_at: old },
    { id: 'stale-draft', type: 'FILE', status: 'READY', upload_context: 'comment', comment_id: null, upload_confirmed_at: staleDraft, abandoned_at: null, created_at: staleDraft, s3_key: 'stale-draft-object' },
    { id: 'published-stale', type: 'FILE', status: 'READY', upload_context: 'comment', comment_id: 'comment', upload_confirmed_at: staleDraft, abandoned_at: null, created_at: staleDraft },
  );
  const { cleanupOrphanAttachments, orphanCleanupInterval } = await import('../../attachment/mods/orphanCleanup');
  try {
    await cleanupOrphanAttachments();
    assert.deepEqual(rows.attachments!.map((row) => row.id).sort(), ['draft-ready', 'draft-scanning', 'published', 'published-stale', 'removed-recently']);
    assert.deepEqual(events.sort(), ['abandoned-object', 'stale-draft-object', 'unfinished-object']);
  } finally { clearInterval(orphanCleanupInterval); }
} else if (scenario.startsWith('association')) {
  const { associateCommentImages, InvalidCommentImage, loadCommentImages } = await import('./images');
  attachments.push({ id: imageId, card_id: cardId, uploaded_by: userId, upload_context: 'comment', comment_id: null, status: 'READY', mime_type: 'image/png' });
  const image = attachments[0]!;
  if (scenario === 'association-wrong-card') image.card_id = 'other';
  if (scenario === 'association-wrong-user') image.uploaded_by = 'other';
  if (scenario === 'association-stolen') image.comment_id = 'other';
  if (scenario === 'association-card-upload') image.upload_context = 'card';
  if (scenario === 'association-pending') image.status = 'PENDING';
  if (scenario === 'association-scanning') {
    image.status = 'PENDING';
    image.upload_confirmed_at = '2026-09-30T00:00:00Z';
  }
  const args = { trx: query as never, content: `![image.png](attachment:id:${imageId})`, cardId, userId, commentId: 'comment', ownOrigin: 'https://deck.example.test' };
  if (scenario === 'association-offline-replay') args.content = `![image.png](/api/v1/attachments/${imageId}/view)`;
  if (scenario === 'association-absolute') args.content = `![image.png](https://deck.example.test/api/v1/attachments/${imageId}/thumbnail)`;
  if (scenario === 'association-canonical') {
    args.ownOrigin = 'http://internal.example.test';
    args.content = `![image.png](https://deck.example.test/api/v1/attachments/${imageId}/view)`;
  }
  if (scenario === 'association-pdf') {
    image.upload_context = 'card';
    image.mime_type = 'application/pdf';
    args.content = `[spec.pdf](/api/v1/attachments/${imageId}/view)`;
  }
  if (scenario === 'association-cross-card-link') {
    image.card_id = 'other-card';
    image.upload_context = 'card';
    image.mime_type = 'application/pdf';
    args.content = `[spec.pdf](/api/v1/attachments/${imageId}/view) typo corrected`;
  }
  if (scenario === 'association-rejected-new') image.status = 'REJECTED';
  if (scenario === 'association-claimed-rejected') {
    image.status = 'REJECTED';
    image.comment_id = 'comment';
  }
  if (['association-missing-raw', 'association-missing-old-id', 'association-missing-new-id'].includes(scenario)) {
    attachments.length = 0;
    if (scenario === 'association-missing-raw') args.content = `![image.png](/api/v1/attachments/${imageId}/view)`;
  }
  if (scenario === 'association-claimed-rejected') {
    await associateCommentImages({ ...args, previousContent: args.content, content: args.content + ' typo corrected' });
    assert.equal(image.comment_id, 'comment');
  } else
  if (['association-card-upload', 'association-pdf', 'association-cross-card-link', 'association-missing-raw', 'association-missing-old-id'].includes(scenario)) {
    await associateCommentImages({ ...args, ...(scenario === 'association-missing-old-id' ? { previousContent: args.content } : {}) });
    assert.equal(image.comment_id, null);
    if (scenario === 'association-cross-card-link') {
      assert.deepEqual((await loadCommentImages([{ id: 'comment', card_id: cardId, content: args.content }])).get('comment'), []);
    }
  } else
  if (scenario === 'association-external') {
    await associateCommentImages({ ...args, content: `![image.png](https://external.example.test/api/v1/attachments/${imageId}/view)` });
    assert.equal(image.comment_id, null);
  } else
  if (['association-ready', 'association-scanning', 'association-offline-replay', 'association-absolute', 'association-canonical'].includes(scenario)) {
    await associateCommentImages(args);
    assert.equal(image.comment_id, 'comment');
    await associateCommentImages(args);
    await associateCommentImages({ ...args, content: 'image removed' });
    assert.equal(image.comment_id, null);
    assert.equal(typeof image.abandoned_at, 'string');
    await associateCommentImages(args);
    assert.equal(image.comment_id, 'comment');
    assert.equal(image.abandoned_at, null);
  } else await assert.rejects(associateCommentImages(args), InvalidCommentImage);
} else {
  const multipart = scenario.includes('multipart');
  const context = scenario.includes('card') ? 'card' : 'comment';
  const { handleRequestUploadUrl } = await import('../../attachment/api/requestUploadUrl');
  const { handleMultipartStart } = await import('../../attachment/api/multipart/start');
  const response = await (multipart ? handleMultipartStart : handleRequestUploadUrl)(request({
    filename: 'image.png', mimeType: scenario === 'non-image' ? 'text/plain' : 'image/png',
    sizeBytes: 100, uploadContext: context,
  }), cardId);
  if (scenario === 'denied' || scenario === 'non-image') {
    assert.equal(response.status, scenario === 'denied' ? 403 : 400);
    assert.equal(attachments.length, 0);
  } else {
    assert.equal(response.status, 201);
    assert.equal(attachments[0]!.upload_context, context);
    if (scenario.includes('wrong-user')) attachments[0]!.uploaded_by = 'other';
    const { handleConfirmUpload } = await import('../../attachment/api/confirmUpload');
    const { handleMultipartComplete } = await import('../../attachment/api/multipart/complete');
    const completed = await (multipart ? handleMultipartComplete : handleConfirmUpload)(request(multipart ?
      { key: attachments[0]!.s3_key, uploadId: 'upload', parts: [{ partNumber: 1, etag: 'etag' }] } :
      { attachmentId: attachments[0]!.id }), cardId);
    if (scenario.includes('wrong-user')) {
      assert.equal(completed.status, 403);
      assert.equal(completions, 0);
    }
    else {
      assert.equal(completed.status, 200);
      const body = await completed.json();
      assert.equal(body.data.view_url, `/api/v1/attachments/${attachments[0]!.id}/view`);
      assert.equal(body.data.content_type, 'image/png');
      assert.equal(body.data.status, 'READY');
      assert.equal(events.length, context === 'comment' ? 0 : multipart ? 2 : 3);
    }
  }
}
