import { strict as assert } from 'node:assert';
import { registerLabelTools } from './labels';
import {
  apiError, defineToolScenarios, expectAnnotations, html, json, type Harness, type RecordedRequest,
} from './toolSupport.fixture';

const label = { id: 'lb1', name: 'Bug', color: '#f00', board_id: 'b1' };
const card = (labels: unknown[]) => ({ data: { id: 'c1', title: 'Card' }, includes: { labels, members: [] } });
const calls = (h: Harness) => h.requests.map(({ method, path, body }) => ({ method, path, body }));
const empty = () => new Response(null, { status: 204 });

// Write-then-read tools: the write fails, null/HTML-200 answers, the read-back fails.
async function writeErrors(h: Harness, name: string, args: Record<string, unknown>, write: string) {
  const isWrite = (r: RecordedRequest) => r.method === write;
  h.respond((r) => (isWrite(r) ? apiError(404, 'card-not-found') : json(null)));
  await h.fail(name, args, 'card-not-found');
  assert.equal(h.requests.length, 1, 'no read-back after a failed write');
  h.respond(() => apiError(400, 'bad request'));
  await h.fail(name, args, 'api-error');
  h.respond(() => json(null));
  await h.fail(name, args, 'invalid-response');
  h.respond(html);
  await h.fail(name, args, 'invalid-response');
  h.respond((r) => (isWrite(r) ? json({ data: { id: 'x' } }) : apiError(500)));
  await h.fail(name, args, 'http-500');
  h.respond((r) => (isWrite(r) ? json({ data: { id: 'x' } }) : html()));
  await h.fail(name, args, 'invalid-response');
}

defineToolScenarios(import.meta, registerLabelTools, {
  registration: (h) => {
    expectAnnotations(h, ['delete_label'], { destructiveHint: true });
    expectAnnotations(h, ['add_card_label', 'remove_card_label', 'create_label'], { readOnlyHint: undefined });
  },
  add_card_label: async (h) => {
    const after = card([label]);
    h.respond((r) => (r.method === 'POST' ? json({ data: { card_id: 'c1', label_id: 'lb1' } }, 201) : json(after)));
    assert.deepEqual(await h.ok('add_card_label', { cardId: 'c/1', labelId: 'lb1' }), after);
    assert.deepEqual(calls(h), [
      { method: 'POST', path: '/api/v1/cards/c%2F1/labels', body: { labelId: 'lb1' } },
      { method: 'GET', path: '/api/v1/cards/c%2F1', body: undefined },
    ]);
    // Read-back without the label, or without a labels include, is not success.
    h.respond((r) => (r.method === 'POST' ? json({ data: {} }) : json(card([]))));
    await h.fail('add_card_label', { cardId: 'c1', labelId: 'lb1' }, 'readback-failed');
    h.respond((r) => (r.method === 'POST' ? json({ data: {} }) : json({ data: { id: 'c1' }, includes: {} })));
    await h.fail('add_card_label', { cardId: 'c1', labelId: 'lb1' }, 'invalid-response');
    await writeErrors(h, 'add_card_label', { cardId: 'c1', labelId: 'lb1' }, 'POST');
  },
  remove_card_label: async (h) => {
    const after = card([]);
    h.respond((r) => (r.method === 'DELETE' ? empty() : json(after)));
    assert.deepEqual(await h.ok('remove_card_label', { cardId: 'c1', labelId: 'lb 1' }), after);
    assert.deepEqual(calls(h), [
      { method: 'DELETE', path: '/api/v1/cards/c1/labels/lb%201', body: undefined },
      { method: 'GET', path: '/api/v1/cards/c1', body: undefined },
    ]);
    h.respond((r) => (r.method === 'DELETE' ? empty() : json(card([label]))));
    await h.fail('remove_card_label', { cardId: 'c1', labelId: 'lb1' }, 'readback-failed');
    await writeErrors(h, 'remove_card_label', { cardId: 'c1', labelId: 'lb1' }, 'DELETE');
  },
  create_label: async (h) => {
    h.respond((r) => (r.method === 'POST'
      ? json({ data: label }, 201)
      : json({ data: [{ id: 'other' }, { ...label, extra: 1 }] })));
    assert.deepEqual(await h.ok('create_label', { boardId: 'b1', name: 'Bug', color: '#f00' }), { ...label, extra: 1 });
    assert.deepEqual(calls(h), [
      { method: 'POST', path: '/api/v1/boards/b1/labels', body: { name: 'Bug', color: '#f00' } },
      { method: 'GET', path: '/api/v1/boards/b1/labels', body: undefined },
    ]);
    h.respond((r) => (r.method === 'POST' ? json({ data: label }) : json({ data: [] })));
    await h.fail('create_label', { boardId: 'b1', name: 'Bug', color: '#f00' }, 'readback-failed');
    h.respond(() => json({ data: {} }));
    await h.fail('create_label', { boardId: 'b1', name: 'Bug', color: '#f00' }, 'invalid-response');
    await writeErrors(h, 'create_label', { boardId: 'b1', name: 'Bug', color: '#f00' }, 'POST');
    // Empty name is rejected before any request.
    h.respond(() => json({ data: label }));
    assert.equal((await h.call('create_label', { boardId: 'b1', name: '', color: '#f00' })).isError, true);
    assert.equal(h.requests.length, 0);
  },
  delete_label: async (h) => {
    h.respond((r) => (r.method === 'DELETE' ? empty() : json({ data: [{ id: 'other' }] })));
    assert.deepEqual(await h.ok('delete_label', { boardId: 'b1', labelId: 'lb1' }), { deleted: true, id: 'lb1' });
    assert.deepEqual(calls(h), [
      { method: 'DELETE', path: '/api/v1/labels/lb1', body: undefined },
      { method: 'GET', path: '/api/v1/boards/b1/labels', body: undefined },
    ]);
    h.respond((r) => (r.method === 'DELETE' ? empty() : json({ data: [label] })));
    await h.fail('delete_label', { boardId: 'b1', labelId: 'lb1' }, 'delete-failed');
    await writeErrors(h, 'delete_label', { boardId: 'b1', labelId: 'lb1' }, 'DELETE');
  },
});
