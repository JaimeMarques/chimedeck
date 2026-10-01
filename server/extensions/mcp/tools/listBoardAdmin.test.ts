import { strict as assert } from 'node:assert';
import { registerListBoardAdmin } from './listBoardAdmin';
import { TOKEN, apiError, defineToolScenarios, expectAnnotations, html, json, type Harness, type RecordedRequest } from './toolSupport.fixture';

const list = (id: string, extra: Record<string, unknown> = {}) => ({ id, board_id: 'b1', title: `T ${id}`, ...extra });
const board = { id: 'b1', title: 'Board', description: 'd', visibility: 'PRIVATE', extra: { kept: true } };
const noContent = () => new Response(null, { status: 204 });

const calls = (h: Harness) => h.requests.map(({ method, path, body }) => [method, path, body]);

// Routes by method + path suffix; unknown routes fail loudly.
const routes = (table: Record<string, () => Response>) => (r: RecordedRequest) => {
  const key = Object.keys(table).find((k) => {
    const [method, suffix] = k.split(' ');
    return r.method === method && r.path.endsWith(suffix ?? '');
  });
  return key ? (table[key] as () => Response)() : apiError(599, 'no-route');
};

async function badResponses(h: Harness, name: string, args: Record<string, unknown>, table: Record<string, () => Response>, key: string) {
  for (const bad of [() => json(null), html, () => json({ data: TOKEN })]) {
    h.respond(routes({ ...table, [key]: bad }));
    await h.fail(name, args, 'invalid-response');
  }
}

defineToolScenarios(import.meta, registerListBoardAdmin, {
  registration: (h) => {
    expectAnnotations(h, ['archive_list', 'delete_list'], { destructiveHint: true });
    expectAnnotations(h, ['rename_list', 'update_board'], { destructiveHint: undefined });
  },
  rename_list: async (h) => {
    const args = { boardId: 'b1', listId: 'l 2', title: 'New' };
    const ok = { 'PATCH /lists/l%202': () => json({ data: list('l 2') }), 'GET /lists': () => json({ data: [list('l1'), list('l 2')] }) };
    h.respond(routes(ok));
    assert.deepEqual(await h.ok('rename_list', args), list('l 2'));
    assert.deepEqual(calls(h), [
      ['PATCH', '/api/v1/lists/l%202', { title: 'New' }],
      ['GET', '/api/v1/boards/b1/lists', undefined],
    ]);
    h.respond(routes({ ...ok, 'GET /lists': () => json({ data: [list('l1')] }) }));
    await h.fail('rename_list', args, 'readback-failed');
    h.respond(routes({ ...ok, 'PATCH /lists/l%202': () => apiError(404, 'list-not-found') }));
    await h.fail('rename_list', args, 'list-not-found');
    assert.equal(h.requests.length, 1);
    h.respond(routes({ ...ok, 'PATCH /lists/l%202': () => apiError(400, `bad ${TOKEN}`) }));
    await h.fail('rename_list', args, 'api-error');
    await badResponses(h, 'rename_list', args, ok, 'PATCH /lists/l%202');
    await badResponses(h, 'rename_list', args, ok, 'GET /lists');
  },
  archive_list: async (h) => {
    const args = { boardId: 'b1', listId: 'l1' };
    let archived: unknown[] = [];
    const ok = {
      'GET /archived-lists': () => json({ data: archived }),
      'PATCH /lists/l1/archive': () => { archived = [list('l1', { archived: true })]; return json({ data: list('l1', { archived: true }) }); },
    };
    h.respond(routes(ok));
    assert.deepEqual(await h.ok('archive_list', args), list('l1', { archived: true }));
    assert.deepEqual(calls(h), [
      ['GET', '/api/v1/boards/b1/archived-lists', undefined],
      ['PATCH', '/api/v1/lists/l1/archive', {}],
      ['GET', '/api/v1/boards/b1/archived-lists', undefined],
    ]);
    // Already archived: no PATCH, since the route toggles and would restore it.
    h.respond(routes(ok));
    assert.deepEqual(await h.ok('archive_list', args), list('l1', { archived: true }));
    assert.deepEqual(calls(h), [['GET', '/api/v1/boards/b1/archived-lists', undefined]]);
    // The PATCH reports the list open: error, not success.
    h.respond(routes({ 'GET /archived-lists': () => json({ data: [] }), 'PATCH /lists/l1/archive': () => json({ data: list('l1', { archived: false }) }) }));
    await h.fail('archive_list', args, 'archive-failed');
    // Archived per the PATCH, but missing from the archived read-back.
    h.respond(routes({ 'GET /archived-lists': () => json({ data: [] }), 'PATCH /lists/l1/archive': () => json({ data: list('l1', { archived: true }) }) }));
    await h.fail('archive_list', args, 'readback-failed');
    h.respond(routes({ 'GET /archived-lists': () => json({ data: [] }), 'PATCH /lists/l1/archive': () => apiError(403, 'insufficient-role') }));
    await h.fail('archive_list', args, 'insufficient-role');
    const fresh = { 'GET /archived-lists': () => json({ data: [] }), 'PATCH /lists/l1/archive': () => json({ data: list('l1') }) };
    await badResponses(h, 'archive_list', args, fresh, 'PATCH /lists/l1/archive');
    await badResponses(h, 'archive_list', args, fresh, 'GET /archived-lists');
  },
  delete_list: async (h) => {
    const args = { boardId: 'b1', listId: 'l1' };
    const ok = { 'DELETE /lists/l1': noContent, 'GET /lists': () => json({ data: [list('l2')] }) };
    h.respond(routes(ok));
    assert.deepEqual(await h.ok('delete_list', args), { deleted: true, id: 'l1' });
    assert.deepEqual(calls(h), [
      ['DELETE', '/api/v1/lists/l1', undefined],
      ['GET', '/api/v1/boards/b1/lists', undefined],
    ]);
    h.respond(routes({ ...ok, 'GET /lists': () => json({ data: [list('l1')] }) }));
    await h.fail('delete_list', args, 'delete-failed');
    // The server refuses a non-empty list without confirm:true (Python sends none either).
    h.respond(routes({ ...ok, 'DELETE /lists/l1': () => apiError(409, 'delete-requires-confirmation') }));
    await h.fail('delete_list', args, 'delete-requires-confirmation');
    assert.equal(h.requests.length, 1);
    await badResponses(h, 'delete_list', args, ok, 'GET /lists');
  },
  update_board: async (h) => {
    const ok = { 'PATCH /boards/b1': () => json({ data: board }), 'GET /boards/b1': () => json({ data: board, includes: { lists: [] } }) };
    const cases: Array<[Record<string, unknown>, unknown]> = [
      [{ title: 'Board' }, { title: 'Board' }],
      [{ description: '' }, { description: '' }],
      [{ visibility: 'PRIVATE' }, { visibility: 'PRIVATE' }],
      [{ title: 'Board', description: 'd', visibility: 'PRIVATE' }, { title: 'Board', description: 'd', visibility: 'PRIVATE' }],
    ];
    for (const [extra, body] of cases) {
      h.respond(routes(ok));
      assert.deepEqual(await h.ok('update_board', { boardId: 'b1', ...extra }), board);
      assert.deepEqual(calls(h), [['PATCH', '/api/v1/boards/b1', body], ['GET', '/api/v1/boards/b1', undefined]]);
    }
    h.respond(routes(ok));
    await h.fail('update_board', { boardId: 'b1' }, 'nothing-to-update');
    assert.equal(h.requests.length, 0);
    assert.equal((await h.call('update_board', { boardId: 'b1', visibility: 'SECRET' })).isError, true);
    assert.equal(h.requests.length, 0);
    // Read-back shows a different visibility than requested.
    await h.fail('update_board', { boardId: 'b1', visibility: 'PUBLIC' }, 'readback-failed');
    h.respond(routes({ ...ok, 'PATCH /boards/b1': () => apiError(403, 'insufficient-role') }));
    await h.fail('update_board', { boardId: 'b1', title: 'x' }, 'insufficient-role');
    assert.equal(h.requests.length, 1);
    await badResponses(h, 'update_board', { boardId: 'b1', title: 'x' }, ok, 'PATCH /boards/b1');
    await badResponses(h, 'update_board', { boardId: 'b1', title: 'x' }, ok, 'GET /boards/b1');
  },
});
