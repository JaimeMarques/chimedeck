import { strict as assert } from 'node:assert';
import { registerCardEdits } from './cardEdits';
import { apiError, defineToolScenarios, expectAnnotations, html, json, type Harness, type RecordedRequest } from './toolSupport.fixture';

const card = (fields: Record<string, unknown> = {}) => ({
  data: { id: 'c1', title: 'Card', archived: false, due_date: null, due_complete: false, ...fields },
  includes: { labels: [], checklists: [] },
});
const calls = (h: Harness) => h.requests.map(({ method, path, body }) => ({ method, path, body }));
const get = (path: string) => ({ method: 'GET', path, body: undefined });

// Writes answer `write`, GETs answer `read`.
const route = (write: () => Response, read: () => Response) =>
  (r: RecordedRequest) => (r.method === 'GET' ? read() : write());

// Failure modes shared by the PATCH-then-read tools.
async function patchErrors(h: Harness, name: string, args: Record<string, unknown>) {
  h.respond(route(() => apiError(400, 'bad-request'), () => json(card())));
  await h.fail(name, args, 'bad-request');
  h.respond(route(() => json(null), () => json(card())));
  await h.fail(name, args, 'invalid-response');
  h.respond(route(html, () => json(card())));
  await h.fail(name, args, 'invalid-response');
  h.respond(route(() => json(card()), () => apiError(404)));
  await h.fail(name, args, 'http-404');
  h.respond(route(() => json(card()), html));
  await h.fail(name, args, 'invalid-response');
}

defineToolScenarios(import.meta, registerCardEdits, {
  registration: (h) => {
    expectAnnotations(h, ['delete_card'], { destructiveHint: true });
    expectAnnotations(h, ['update_card', 'set_card_due', 'archive_card', 'copy_card'], { readOnlyHint: undefined });
  },
  update_card: async (h) => {
    const after = card({ title: 'New', description: 'D', due_date: '2026-09-20T12:00:00.000Z', due_complete: true });
    h.respond(() => json(after));
    assert.deepEqual(await h.ok('update_card', {
      cardId: 'c/1', title: 'New', description: 'D', dueDate: '2026-09-20T12:00:00Z', dueComplete: true,
    }), after);
    assert.deepEqual(calls(h), [
      { method: 'PATCH', path: '/api/v1/cards/c%2F1',
        body: { title: 'New', description: 'D', due_date: '2026-09-20T12:00:00.000Z', due_complete: true } },
      get('/api/v1/cards/c%2F1'),
    ]);
    // Empty string clears the date; only passed keys are sent.
    h.respond(() => json(card()));
    await h.ok('update_card', { cardId: 'c1', dueDate: '' });
    assert.deepEqual(calls(h)[0]?.body, { due_date: null });
    // No fields or a non-date: rejected before any request.
    h.respond(() => json(card()));
    await h.fail('update_card', { cardId: 'c1' }, 'nothing-to-update');
    for (const invalid of ['soon', '0', '2026-02-30', '2026-09-20T12:00:00', '2026-09-20T12:00:00Zmore']) {
      assert.equal((await h.call('update_card', { cardId: 'c1', dueDate: invalid })).isError, true, invalid);
      assert.equal(h.requests.length, 0, `${invalid} must not write`);
    }
    // Read-back disagrees with the written due fields.
    h.respond(() => json(card({ due_complete: false })));
    await h.fail('update_card', { cardId: 'c1', dueComplete: true }, 'readback-failed');
    h.respond(() => json(card({ due_date: '2026-01-01T00:00:00.000Z' })));
    await h.fail('update_card', { cardId: 'c1', dueDate: null }, 'readback-failed');
    await patchErrors(h, 'update_card', { cardId: 'c1', title: 'Card' });
  },
  update_card_text_readback: async (h) => {
    // Title and description compare as the server stores them: trimmed and sanitized.
    h.respond(() => json(card({ title: 'a & b', description: '<b>x</b>' })));
    await h.ok('update_card', { cardId: 'c1', title: ' <i>a</i> &amp; b ', description: ' <b>x</b><script>y</script> ' });
    // An empty description is stored as null.
    h.respond(() => json(card({ description: null })));
    await h.ok('update_card', { cardId: 'c1', description: '' });
    // Read back unchanged: not success.
    h.respond(() => json(card({ description: 'old' })));
    await h.fail('update_card', { cardId: 'c1', title: 'New' }, 'readback-failed');
    await h.fail('update_card', { cardId: 'c1', description: 'new' }, 'readback-failed');
    await h.fail('update_card', { cardId: 'c1', description: '' }, 'readback-failed');
  },
  set_card_due: async (h) => {
    const after = card({ due_date: '2026-09-20T00:00:00.000Z', due_complete: false });
    h.respond(() => json(after));
    assert.deepEqual(await h.ok('set_card_due', { cardId: 'c1', dueDate: '2026-09-20', dueComplete: false }), after);
    assert.deepEqual(calls(h), [
      // A bare date is sent as an explicit UTC instant.
      { method: 'PATCH', path: '/api/v1/cards/c1', body: { due_date: '2026-09-20T00:00:00.000Z', due_complete: false } },
      get('/api/v1/cards/c1'),
    ]);
    h.respond(() => json(card({ due_date: '2026-09-20T10:00:00.000Z' })));
    await h.ok('set_card_due', { cardId: 'c1', dueDate: '2026-09-20T12:00:00+02:00' });
    assert.deepEqual(calls(h)[0]?.body, { due_date: '2026-09-20T10:00:00.000Z' });
    h.respond(() => json(card({ due_date: '0001-01-01T00:00:00.000Z' })));
    await h.ok('set_card_due', { cardId: 'c1', dueDate: '0001-01-01' });
    assert.deepEqual(calls(h)[0]?.body, { due_date: '0001-01-01T00:00:00.000Z' });
    h.respond(() => json(card()));
    await h.ok('set_card_due', { cardId: 'c1', dueDate: null });
    assert.deepEqual(calls(h)[0]?.body, { due_date: null });
    h.respond(() => json(card()));
    await h.fail('set_card_due', { cardId: 'c1' }, 'nothing-to-update');
    assert.equal(h.requests.length, 0);
    await patchErrors(h, 'set_card_due', { cardId: 'c1', dueComplete: false });
  },
  archive_card: async (h) => {
    // Archive: card open, toggle, read-back archived.
    let archived = false;
    h.respond((r) => {
      if (r.method === 'PATCH') archived = !archived;
      return json(card({ archived }));
    });
    assert.deepEqual(await h.ok('archive_card', { cardId: 'c1' }), card({ archived: true }));
    assert.deepEqual(calls(h), [
      get('/api/v1/cards/c1'),
      { method: 'PATCH', path: '/api/v1/cards/c1/archive', body: {} },
      get('/api/v1/cards/c1'),
    ]);
    // Already archived: no toggle (the server would flip it back).
    h.respond(() => json(card({ archived: true })));
    await h.ok('archive_card', { cardId: 'c1', archived: true });
    assert.deepEqual(calls(h).map((r) => r.method), ['GET', 'GET']);
    // Restore sends Python's body.
    archived = true;
    h.respond((r) => {
      if (r.method === 'PATCH') archived = !archived;
      return json(card({ archived }));
    });
    assert.deepEqual(await h.ok('archive_card', { cardId: 'c1', archived: false }), card());
    assert.deepEqual(calls(h)[1], { method: 'PATCH', path: '/api/v1/cards/c1/archive', body: { archived: false } });
    // Pre-read without a boolean archived: no toggle is sent.
    h.respond(() => json({ data: { id: 'c1' } }));
    await h.fail('archive_card', { cardId: 'c1' }, 'invalid-response');
    assert.deepEqual(calls(h).map((r) => r.method), ['GET']);
    // Toggle did not stick (or a concurrent toggle reversed it).
    h.respond(() => json(card()));
    await h.fail('archive_card', { cardId: 'c1' }, 'archive-state-conflict');
    h.respond(route(() => apiError(403, 'board-archived'), () => json(card())));
    await h.fail('archive_card', { cardId: 'c1' }, 'board-archived');
    h.respond(route(html, () => json(card())));
    await h.fail('archive_card', { cardId: 'c1' }, 'invalid-response');
    h.respond(() => json(null));
    await h.fail('archive_card', { cardId: 'c1' }, 'invalid-response');
    h.respond(() => apiError(404));
    await h.fail('archive_card', { cardId: 'c1' }, 'http-404');
  },
  archive_card_short_id: async (h) => {
    // Already archived, given by short ID: no toggle (the router would resolve it and restore the card).
    h.respond(() => json(card({ id: 'uuid-1', archived: true })));
    assert.deepEqual(await h.ok('archive_card', { cardId: 'abcd1234' }), card({ id: 'uuid-1', archived: true }));
    assert.deepEqual(calls(h), [get('/api/v1/cards/abcd1234'), get('/api/v1/cards/uuid-1')]);
    // Open, by short ID: PATCH and read-back use the UUID.
    let archived = false;
    h.respond((r) => {
      if (r.method === 'PATCH') archived = !archived;
      return json(card({ id: 'uuid-1', archived }));
    });
    await h.ok('archive_card', { cardId: 'abcd1234' });
    assert.deepEqual(calls(h).map((r) => `${r.method} ${r.path}`), [
      'GET /api/v1/cards/abcd1234', 'PATCH /api/v1/cards/uuid-1/archive', 'GET /api/v1/cards/uuid-1',
    ]);
  },
  archive_card_state_conflict: async (h) => {
    // The PATCH succeeded but the read-back shows the other state: error, not success.
    h.respond((r) => (r.method === 'PATCH' ? json(card({ archived: true })) : json(card({ archived: false }))));
    await h.fail('archive_card', { cardId: 'c1' }, 'archive-state-conflict');
    assert.deepEqual(calls(h).map((r) => r.method), ['GET', 'PATCH', 'GET']);
  },
  delete_card: async (h) => {
    let deleted = false;
    h.respond((r) => {
      if (r.method === 'DELETE') { deleted = true; return new Response(null, { status: 204 }); }
      return deleted ? apiError(404, 'card-not-found') : json(card({ id: 'uuid-1' }));
    });
    assert.deepEqual(await h.ok('delete_card', { cardId: 'abcd1234' }), { deleted: true, id: 'uuid-1', title: 'Card' });
    assert.deepEqual(calls(h), [
      get('/api/v1/cards/abcd1234'),
      { method: 'DELETE', path: '/api/v1/cards/uuid-1', body: undefined },
      get('/api/v1/cards/uuid-1'),
    ]);
    // Still readable after a 204 DELETE.
    h.respond(route(() => new Response(null, { status: 204 }), () => json(card())));
    await h.fail('delete_card', { cardId: 'c1' }, 'delete-failed');
    // The route answers 204: HTML-200 or a JSON body is invalid-response.
    h.respond(route(html, () => json(card())));
    await h.fail('delete_card', { cardId: 'c1' }, 'invalid-response');
    h.respond(route(() => json({ data: { id: 'c1' } }), () => json(card())));
    await h.fail('delete_card', { cardId: 'c1' }, 'invalid-response');
    h.respond(route(() => apiError(403, 'forbidden'), () => json(card())));
    await h.fail('delete_card', { cardId: 'c1' }, 'forbidden');
    h.respond(route(() => new Response(null, { status: 204 }), () => apiError(500)));
    await h.fail('delete_card', { cardId: 'c1' }, 'http-500');
    h.respond(() => json(null));
    await h.fail('delete_card', { cardId: 'c1' }, 'invalid-response');
  },
  copy_card: async (h) => {
    const copy = card({ id: 'c2', title: 'Copy', list_id: 'l2' });
    h.respond(route(() => json({ data: { id: 'c2' } }, 201), () => json(copy)));
    assert.deepEqual(await h.ok('copy_card', {
      cardId: 'c1', targetListId: 'l2', title: 'Copy', keepChecklists: true, keepMembers: false,
    }), copy);
    assert.deepEqual(calls(h), [
      { method: 'POST', path: '/api/v1/cards/c1/copy',
        body: { targetListId: 'l2', title: 'Copy', keepChecklists: true, keepMembers: false } },
      get('/api/v1/cards/c2'),
    ]);
    h.respond(route(() => json({ data: { id: 'c2' } }, 201), () => json(copy)));
    await h.ok('copy_card', { cardId: 'c1', targetListId: 'l2' });
    assert.deepEqual(calls(h)[0]?.body, { targetListId: 'l2' });
    // A given title is compared trimmed.
    h.respond(route(() => json({ data: { id: 'c2' } }, 201), () => json(copy)));
    await h.ok('copy_card', { cardId: 'c1', targetListId: 'l2', title: ' Copy ' });
    await h.fail('copy_card', { cardId: 'c1', targetListId: 'l2', title: 'Other' }, 'readback-failed');
    // A successful POST is not proof that the copy reached the requested list or kept its ID.
    h.respond(route(() => json({ data: { id: 'c2' } }, 201), () => json(card({ id: 'c2', title: 'Copy', list_id: 'l3' }))));
    await h.fail('copy_card', { cardId: 'c1', targetListId: 'l2' }, 'readback-failed');
    h.respond(route(() => json({ data: { id: 'c2' } }, 201), () => json(card({ id: 'c3', title: 'Copy', list_id: 'l2' }))));
    await h.fail('copy_card', { cardId: 'c1', targetListId: 'l2' }, 'readback-failed');
    h.respond(route(() => apiError(404, 'list-not-found'), () => json(copy)));
    await h.fail('copy_card', { cardId: 'c1', targetListId: 'l2' }, 'list-not-found');
    h.respond(route(() => json(null), () => json(copy)));
    await h.fail('copy_card', { cardId: 'c1', targetListId: 'l2' }, 'invalid-response');
    h.respond(route(html, () => json(copy)));
    await h.fail('copy_card', { cardId: 'c1', targetListId: 'l2' }, 'invalid-response');
    h.respond(route(() => json({ data: { id: 'c2' } }, 201), () => apiError(404)));
    await h.fail('copy_card', { cardId: 'c1', targetListId: 'l2' }, 'http-404');
  },
});
