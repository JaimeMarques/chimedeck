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
    const args = { cardId: 'c1', commentId: 'm1', content: ' new ' };
    let content = 'hi';
    // Top-level list for the scope check and the read-back; the PATCH changes the row.
    h.respond((r) => {
      if (r.method === 'PATCH') { content = 'new'; return json({ data: edited }); }
      return json({ data: [comment({ id: 'm0' }), comment({ content, version: 2 })] });
    });
    assert.deepEqual(await h.ok('edit_comment', args), edited);
    assert.deepEqual(calls(h), [
      { method: 'GET', path: '/api/v1/cards/c1/comments', body: undefined },
      { method: 'PATCH', path: '/api/v1/comments/m1', body: { content: ' new ' } },
      { method: 'GET', path: '/api/v1/cards/c1/comments', body: undefined },
    ]);
    // Missing from the list after the write, or read back unchanged: not success.
    let reads = 0;
    h.respond(route(() => json({ data: edited }), () => json({ data: reads++ === 0 ? [comment()] : [] })));
    await h.fail('edit_comment', args, 'readback-failed');
    h.respond(route(() => json({ data: edited }), () => json({ data: [comment()] })));
    await h.fail('edit_comment', args, 'readback-failed');
    // A reply is found in its parent's thread and read back from there.
    const parent = comment({ id: 'p/1', reply_count: 1 });
    const reply = comment({ id: 'r1', parent_id: 'p/1', content: 'new' });
    const replyArgs = { cardId: 'c1', commentId: 'r1', content: 'new' };
    const thread = (r: RecordedRequest) => (r.path.endsWith('/replies')
      ? json({ data: [comment({ id: 'r0', parent_id: 'p/1' }), reply] })
      : json({ data: [comment(), parent] }));
    h.respond((r) => (r.method === 'GET' ? thread(r) : json({ data: reply })));
    assert.deepEqual(await h.ok('edit_comment', replyArgs), reply);
    assert.deepEqual(calls(h), [
      { method: 'GET', path: '/api/v1/cards/c1/comments', body: undefined },
      { method: 'GET', path: '/api/v1/comments/p%2F1/replies', body: undefined },
      { method: 'PATCH', path: '/api/v1/comments/r1', body: { content: 'new' } },
      { method: 'GET', path: '/api/v1/comments/p%2F1/replies', body: undefined },
    ]);
    h.respond((r) => (r.method === 'GET' ? thread(r) : json({ data: reply })));
    await h.fail('edit_comment', { ...replyArgs, content: 'other' }, 'readback-failed');
    const ok = () => json({ data: [edited] });
    h.respond(route(() => apiError(403, 'comment-not-owner'), ok));
    await h.fail('edit_comment', args, 'comment-not-owner');
    h.respond(route(() => json(null), ok));
    await h.fail('edit_comment', args, 'invalid-response');
    h.respond(route(html, ok));
    await h.fail('edit_comment', args, 'invalid-response');
    h.respond(route(() => json({ data: edited }), html));
    await h.fail('edit_comment', args, 'invalid-response');
    h.respond(route(() => json({ data: edited }), () => apiError(404)));
    await h.fail('edit_comment', args, 'http-404');
  },
  edit_comment_not_in_card: async (h) => {
    // m9 is on another card: no PATCH is sent.
    h.respond((r) => (r.path.endsWith('/replies') ? json({ data: [comment({ id: 'r0', parent_id: 'p1' })] })
      : r.method === 'GET' ? json({ data: [comment(), comment({ id: 'p1', reply_count: 1 })] }) : json({ data: comment() })));
    await h.fail('edit_comment', { cardId: 'c1', commentId: 'm9', content: 'x' }, 'not-in-card');
    assert.ok(h.requests.every((r) => r.method === 'GET'), 'no PATCH on a comment from another card');
  },
  delete_comment: async (h) => {
    const placeholder = comment({ deleted: true, content: '[deleted]' });
    const args = { cardId: 'c1', commentId: 'm1' };
    let deleted = false;
    h.respond((r) => {
      if (r.method === 'DELETE') { deleted = true; return json({ data: placeholder }); }
      return json({ data: [deleted ? placeholder : comment()] });
    });
    assert.deepEqual(await h.ok('delete_comment', args), placeholder);
    assert.deepEqual(calls(h), [
      { method: 'GET', path: '/api/v1/cards/c1/comments', body: undefined },
      { method: 'DELETE', path: '/api/v1/comments/m1', body: undefined },
      { method: 'GET', path: '/api/v1/cards/c1/comments', body: undefined },
    ]);
    // Still a live comment after a well-formed DELETE.
    h.respond(route(() => json({ data: placeholder }), () => json({ data: [comment()] })));
    await h.fail('delete_comment', args, 'delete-failed');
    // The route answers 200 {data: row}: null, HTML-200, 204 or another row is invalid-response.
    for (const bad of [html, () => json(null), () => new Response(null, { status: 204 }), () => json({ data: comment({ id: 'm9' }) })]) {
      h.respond(route(bad, () => json({ data: [comment()] })));
      await h.fail('delete_comment', args, 'invalid-response');
    }
    let reads = 0;
    h.respond(route(() => json({ data: placeholder }), () => json({ data: reads++ === 0 ? [comment()] : [] })));
    await h.fail('delete_comment', args, 'readback-failed');
    h.respond(route(() => apiError(409, 'comment-deleted'), () => json({ data: [placeholder] })));
    await h.fail('delete_comment', args, 'comment-deleted');
    h.respond(route(() => json({ data: placeholder }), html));
    await h.fail('delete_comment', args, 'invalid-response');
    // A deleted reply drops out of its parent's (non-deleted) replies.
    const reply = comment({ id: 'r1', parent_id: 'p1', deleted: true, content: '[deleted]' });
    const replyArgs = { cardId: 'c1', commentId: 'r1' };
    let gone = false;
    const thread = (r: RecordedRequest) => (r.path.endsWith('/replies')
      ? json({ data: gone ? [comment({ id: 'r0', parent_id: 'p1' })] : [comment({ id: 'r1', parent_id: 'p1' })] })
      : json({ data: [comment({ id: 'p1', reply_count: 1 })] }));
    h.respond((r) => {
      if (r.method === 'DELETE') { gone = true; return json({ data: reply }); }
      return thread(r);
    });
    assert.deepEqual(await h.ok('delete_comment', replyArgs), { deleted: true, id: 'r1' });
    assert.deepEqual(calls(h), [
      { method: 'GET', path: '/api/v1/cards/c1/comments', body: undefined },
      { method: 'GET', path: '/api/v1/comments/p1/replies', body: undefined },
      { method: 'DELETE', path: '/api/v1/comments/r1', body: undefined },
      { method: 'GET', path: '/api/v1/comments/p1/replies', body: undefined },
    ]);
    gone = false;
    h.respond((r) => (r.method === 'DELETE' ? json({ data: reply }) : thread(r)));
    await h.fail('delete_comment', replyArgs, 'delete-failed');
    h.respond((r) => (r.method === 'GET' ? apiError(404) : json({ data: reply })));
    await h.fail('delete_comment', replyArgs, 'http-404');
  },
  delete_comment_not_in_card: async (h) => {
    h.respond((r) => (r.method === 'GET' ? json({ data: [comment()] }) : json({ data: comment({ id: 'm9' }) })));
    await h.fail('delete_comment', { cardId: 'c1', commentId: 'm9' }, 'not-in-card');
    assert.ok(h.requests.every((r) => r.method === 'GET'), 'no DELETE on a comment from another card');
  },
});
