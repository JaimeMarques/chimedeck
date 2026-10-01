import { strict as assert } from 'node:assert';
import { registerChecklistTools } from './checklists';
import { TOKEN, apiError, defineToolScenarios, expectAnnotations, html, json, type Harness, type RecordedRequest } from './toolSupport.fixture';

const cl1 = { id: 'cl1', card_id: 'card-1', title: 'Todo', position: 'a' };
const it1 = { id: 'it1', card_id: 'card-1', checklist_id: 'cl1', title: 'one', checked: false };
const it2 = { id: 'it2', card_id: 'card-1', checklist_id: 'cl2', title: 'other', checked: true };
const card = {
  data: { id: 'card-1', title: 'Card' },
  includes: { checklists: [cl1, { id: 'cl2', title: 'Other' }], checklistItems: [it1, it2], labels: [] },
};
const emptyCard = { data: card.data, includes: { checklists: [], checklistItems: [] } };

const calls = (h: Harness) => h.requests.map(({ method, path, body }) => [method, path, body]);

// Write answers `write`, the card GET answers `readBack`.
const writeThen = (write: () => Response, readBack: () => Response) =>
  (r: RecordedRequest) => (r.method === 'GET' ? readBack() : write());

// Failure modes shared by every write that reads the card back.
async function writeErrors(h: Harness, name: string, args: Record<string, unknown>, row: unknown) {
  h.respond(writeThen(() => apiError(404, 'checklist-not-found'), () => json(card)));
  await h.fail(name, args, 'checklist-not-found');
  assert.equal(h.requests.length, 1, 'no read-back after a failed write');
  h.respond(writeThen(() => apiError(400, `bad ${TOKEN}`), () => json(card)));
  await h.fail(name, args, 'api-error');
  for (const bad of [() => json(null), html, () => json({ data: { id: 'x' } })]) {
    h.respond(writeThen(bad, () => json(card)));
    await h.fail(name, args, 'invalid-response');
  }
  for (const bad of [() => json(null), html, () => json({ data: card.data, includes: {} })]) {
    h.respond(writeThen(() => json({ data: row }, 201), bad));
    await h.fail(name, args, 'invalid-response');
  }
  h.respond(writeThen(() => json({ data: row }, 201), () => apiError(403, 'forbidden')));
  await h.fail(name, args, 'forbidden');
  h.respond(writeThen(() => json({ data: row }, 201), () => json(emptyCard)));
  await h.fail(name, args, 'readback-failed');
}

async function deleteContract(h: Harness, name: string, args: Record<string, unknown>, path: string, stillThere: unknown) {
  h.respond(writeThen(() => new Response(null, { status: 204 }), () => json(emptyCard)));
  assert.deepEqual(await h.ok(name, args), { deleted: true, id: Object.values(args)[1] });
  assert.deepEqual(calls(h), [['DELETE', path, undefined], ['GET', '/api/v1/cards/card-1', undefined]]);
  h.respond(writeThen(() => new Response(null, { status: 204 }), () => json(stillThere)));
  await h.fail(name, args, 'delete-failed');
  h.respond(writeThen(() => apiError(404), () => json(emptyCard)));
  await h.fail(name, args, 'http-404');
  assert.equal(h.requests.length, 1);
  for (const bad of [() => json(null), html]) {
    h.respond(writeThen(() => new Response(null, { status: 204 }), bad));
    await h.fail(name, args, 'invalid-response');
  }
}

defineToolScenarios(import.meta, registerChecklistTools, {
  registration: (h) => {
    expectAnnotations(h, ['delete_checklist', 'delete_checklist_item'], { destructiveHint: true });
    expectAnnotations(h, ['create_checklist', 'add_checklist_item', 'set_checklist_item', 'rename_checklist'],
      { readOnlyHint: undefined, destructiveHint: undefined });
  },
  create_checklist: async (h) => {
    h.respond(writeThen(() => json({ data: { ...cl1, items: [] } }, 201), () => json(card)));
    // Read-back uses the response's card_id (UUID), not the short id the caller passed.
    assert.deepEqual(await h.ok('create_checklist', { cardId: 'short/1', title: 'Todo' }),
      { checklist: cl1, items: [it1], card });
    assert.deepEqual(calls(h), [
      ['POST', '/api/v1/cards/short%2F1/checklists', { title: 'Todo' }],
      ['GET', '/api/v1/cards/card-1', undefined],
    ]);
    await writeErrors(h, 'create_checklist', { cardId: 'card-1', title: 'Todo' }, cl1);
  },
  add_checklist_item: async (h) => {
    h.respond(writeThen(() => json({ data: it1 }, 201), () => json(card)));
    assert.deepEqual(await h.ok('add_checklist_item', { checklistId: 'cl1', title: 'one' }), { item: it1, card });
    assert.deepEqual(calls(h), [
      ['POST', '/api/v1/checklists/cl1/items', { title: 'one' }],
      ['GET', '/api/v1/cards/card-1', undefined],
    ]);
    await writeErrors(h, 'add_checklist_item', { checklistId: 'cl1', title: 'one' }, it1);
  },
  set_checklist_item: async (h) => {
    const bodies: Array<[Record<string, unknown>, unknown]> = [
      [{ checked: true }, { checked: true }],
      [{ checked: false }, { checked: false }],
      [{ title: 'renamed' }, { title: 'renamed' }],
      [{ checked: true, title: 'renamed' }, { checked: true, title: 'renamed' }],
    ];
    for (const [extra, body] of bodies) {
      h.respond(writeThen(() => json({ data: it1 }), () => json(card)));
      assert.deepEqual(await h.ok('set_checklist_item', { itemId: 'it1', ...extra }), { item: it1, card });
      assert.deepEqual(calls(h), [
        ['PATCH', '/api/v1/checklist-items/it1', body],
        ['GET', '/api/v1/cards/card-1', undefined],
      ]);
    }
    h.respond(() => json({ data: it1 }));
    await h.fail('set_checklist_item', { itemId: 'it1' }, 'nothing-to-update');
    assert.equal(h.requests.length, 0);
    await writeErrors(h, 'set_checklist_item', { itemId: 'it1', checked: true }, it1);
  },
  rename_checklist: async (h) => {
    h.respond(writeThen(() => json({ data: { ...cl1, items: [it1] } }), () => json(card)));
    assert.deepEqual(await h.ok('rename_checklist', { checklistId: 'cl1', title: 'Todo' }),
      { checklist: cl1, items: [it1], card });
    assert.deepEqual(calls(h), [
      ['PATCH', '/api/v1/checklists/cl1', { title: 'Todo' }],
      ['GET', '/api/v1/cards/card-1', undefined],
    ]);
    await writeErrors(h, 'rename_checklist', { checklistId: 'cl1', title: 'Todo' }, cl1);
  },
  delete_checklist: (h) => deleteContract(h, 'delete_checklist', { cardId: 'card-1', checklistId: 'cl1' },
    '/api/v1/checklists/cl1', { data: card.data, includes: { checklists: [cl1], checklistItems: [] } }),
  delete_checklist_item: (h) => deleteContract(h, 'delete_checklist_item', { cardId: 'card-1', itemId: 'it1' },
    '/api/v1/checklist-items/it1', { data: card.data, includes: { checklists: [], checklistItems: [it1] } }),
});
