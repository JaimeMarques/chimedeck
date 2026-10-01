import { strict as assert } from 'node:assert';
import { registerCommentTools } from './comments';
import {
  apiError, defineToolScenarios, expectAnnotations, expectReadErrors, html, json, type Harness, type RecordedRequest,
} from './toolSupport.fixture';

const comment = (fields: Record<string, unknown> = {}) =>
  ({ id: 'm1', card_id: 'c1', content: 'hi', deleted: false, parent_id: null, reply_count: 0, ...fields });
const calls = (h: Harness) => h.requests.map(({ method, path, body }) => ({ method, path, body }));
const route = (write: () => Response, read: () => Response) =>
  (r: RecordedRequest) => (r.method === 'GET' ? read() : write());

defineToolScenarios(import.meta, registerCommentTools, {
  registration: (h) => {
    expectAnnotations(h, ['get_comments'], { readOnlyHint: true });
    expectAnnotations(h, ['delete_comment'], { destructiveHint: true });
  },
  get_comments: async (h) => {
    const rows = [comment(), comment({ id: 'm2', deleted: true, content: '[deleted]' })];
    h.respond(() => json({ data: rows }));
    assert.deepEqual(await h.ok('get_comments', { cardId: 'c/1' }), rows);
    assert.deepEqual(calls(h), [{ method: 'GET', path: '/api/v1/cards/c%2F1/comments', body: undefined }]);
    await expectReadErrors(h, 'get_comments', { cardId: 'c1' });
  },
  edit_comment: async (h) => {
    const edited = comment({ content: 'new', version: 2 });
    const args = { cardId: 'c1', commentId: 'm1', content: 'new' };
    h.respond(route(() => json({ data: edited }), () => json({ data: [comment({ id: 'm0' }), edited] })));
    assert.deepEqual(await h.ok('edit_comment', args), edited);
    assert.deepEqual(calls(h), [
      { method: 'PATCH', path: '/api/v1/comments/m1', body: { content: 'new' } },
      { method: 'GET', path: '/api/v1/cards/c1/comments', body: undefined },
    ]);
    // Not in the top-level list (e.g. a reply) after the write.
    h.respond(route(() => json({ data: edited }), () => json({ data: [] })));
    await h.fail('edit_comment', args, 'readback-failed');
    h.respond(route(() => apiError(403, 'comment-not-owner'), () => json({ data: [edited] })));
    await h.fail('edit_comment', args, 'comment-not-owner');
    h.respond(route(() => json(null), () => json({ data: [edited] })));
    await h.fail('edit_comment', args, 'invalid-response');
    h.respond(route(html, () => json({ data: [edited] })));
    await h.fail('edit_comment', args, 'invalid-response');
    h.respond(route(() => json({ data: edited }), html));
    await h.fail('edit_comment', args, 'invalid-response');
    h.respond(route(() => json({ data: edited }), () => apiError(404)));
    await h.fail('edit_comment', args, 'http-404');
  },
  delete_comment: async (h) => {
    const placeholder = comment({ deleted: true, content: '[deleted]' });
    const args = { cardId: 'c1', commentId: 'm1' };
    h.respond(route(() => json({ data: placeholder }), () => json({ data: [placeholder] })));
    assert.deepEqual(await h.ok('delete_comment', args), placeholder);
    assert.deepEqual(calls(h), [
      { method: 'DELETE', path: '/api/v1/comments/m1', body: undefined },
      { method: 'GET', path: '/api/v1/cards/c1/comments', body: undefined },
    ]);
    // Still a live comment afterwards (also covers a null or HTML-200 DELETE).
    h.respond(route(html, () => json({ data: [comment()] })));
    await h.fail('delete_comment', args, 'delete-failed');
    h.respond(route(() => json(null), () => json({ data: [comment()] })));
    await h.fail('delete_comment', args, 'delete-failed');
    h.respond(route(() => json({ data: placeholder }), () => json({ data: [] })));
    await h.fail('delete_comment', args, 'readback-failed');
    h.respond(route(() => apiError(409, 'comment-deleted'), () => json({ data: [placeholder] })));
    await h.fail('delete_comment', args, 'comment-deleted');
    h.respond(route(() => json({ data: placeholder }), html));
    await h.fail('delete_comment', args, 'invalid-response');
  },
});
