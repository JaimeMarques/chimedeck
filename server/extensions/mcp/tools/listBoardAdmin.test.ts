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
    const args = { boardId: 'b1', listId: 'l 2', title: '  New ' };
    let title = 'Old';
    const ok = {
      'PATCH /lists/l%202': () => { title = 'New'; return json({ data: list('l 2', { title }) }); },
      'GET /lists': () => json({ data: [list('l1'), list('l 2', { title })] }),
      'GET /archived-lists': () => json({ data: [] }),
    };
    h.respond(routes(ok));
    assert.deepEqual(await h.ok('rename_list', args), list('l 2', { title: 'New' }));
    assert.deepEqual(calls(h), [
      ['GET', '/api/v1/boards/b1/lists', undefined],
      ['GET', '/api/v1/boards/b1/archived-lists', undefined],
      ['PATCH', '/api/v1/lists/l%202', { title: '  New ' }],
      ['GET', '/api/v1/boards/b1/lists', undefined],
      ['GET', '/api/v1/boards/b1/archived-lists', undefined],
    ]);
    // An archived list is renamed too.
    h.respond(routes({ ...ok, 'GET /lists': () => json({ data: [] }), 'GET /archived-lists': () => json({ data: [list('l 2', { title: 'New' })] }) }));
    await h.ok('rename_list', args);
    // Read back with the old title: the write did not stick.
    h.respond(routes({ ...ok, 'PATCH /lists/l%202': () => json({ data: list('l 2') }), 'GET /lists': () => json({ data: [list('l 2', { title: 'Old' })] }) }));
    await h.fail('rename_list', args, 'readback-failed');
    h.respond(routes({ ...ok, 'PATCH /lists/l%202': () => apiError(404, 'list-not-found') }));
    await h.fail('rename_list', args, 'list-not-found');
    h.respond(routes({ ...ok, 'PATCH /lists/l%202': () => apiError(400, `bad ${TOKEN}`) }));
    await h.fail('rename_list', args, 'api-error');
    await badResponses(h, 'rename_list', args, ok, 'PATCH /lists/l%202');
    await badResponses(h, 'rename_list', args, ok, 'GET /lists');
  },
  rename_list_not_in_board: async (h) => {
    h.respond(routes({ 'GET /lists': () => json({ data: [list('l1')] }), 'GET /archived-lists': () => json({ data: [] }) }));
    await h.fail('rename_list', { boardId: 'b1', listId: 'other', title: 'x' }, 'not-in-board');
    assert.ok(h.requests.every((r) => r.method === 'GET'), 'no write on a list from another board');
  },
  archive_list: async (h) => {
    const args = { boardId: 'b1', listId: 'l1' };
    let archived: unknown[] = [];
    const ok = {
      'GET /lists': () => json({ data: archived.length ? [] : [list('l1', { short_id: 'abcd1234' })] }),
      'GET /archived-lists': () => json({ data: archived }),
      'PATCH /lists/l1/archive': () => { archived = [list('l1', { archived: true })]; return json({ data: list('l1', { archived: true }) }); },
    };
    h.respond(routes(ok));
    assert.deepEqual(await h.ok('archive_list', args), list('l1', { archived: true }));
    assert.deepEqual(calls(h), [
      ['GET', '/api/v1/boards/b1/lists', undefined],
      ['GET', '/api/v1/boards/b1/archived-lists', undefined],
      ['PATCH', '/api/v1/lists/l1/archive', {}],
      ['GET', '/api/v1/boards/b1/archived-lists', undefined],
    ]);
    // Already archived: no PATCH, since the route toggles and would restore it.
    h.respond(routes(ok));
    assert.deepEqual(await h.ok('archive_list', args), list('l1', { archived: true }));
    assert.ok(h.requests.every((r) => r.method === 'GET'));
    h.respond(routes({ 'GET /lists': () => json({ data: [list('l1')] }), 'GET /archived-lists': () => json({ data: [] }), 'PATCH /lists/l1/archive': () => apiError(403, 'insufficient-role') }));
    await h.fail('archive_list', args, 'insufficient-role');
    const fresh = { 'GET /lists': () => json({ data: [list('l1')] }), 'GET /archived-lists': () => json({ data: [] }), 'PATCH /lists/l1/archive': () => json({ data: list('l1', { archived: true }) }) };
    await badResponses(h, 'archive_list', args, fresh, 'PATCH /lists/l1/archive');
    await badResponses(h, 'archive_list', args, fresh, 'GET /archived-lists');
    // Short ID of an open list: the PATCH and read-back use the UUID.
    archived = [];
    h.respond(routes(ok));
    assert.deepEqual(await h.ok('archive_list', { boardId: 'b1', listId: 'abcd1234' }), list('l1', { archived: true }));
    assert.deepEqual(calls(h)[2], ['PATCH', '/api/v1/lists/l1/archive', {}]);
  },
  archive_list_short_id_already_archived: async (h) => {
    // The REST router would resolve the short ID and toggle the list back open: no PATCH may be sent.
    const row = list('l1', { archived: true, short_id: 'abcd1234' });
    h.respond(routes({ 'GET /lists': () => json({ data: [] }), 'GET /archived-lists': () => json({ data: [row] }) }));
    assert.deepEqual(await h.ok('archive_list', { boardId: 'b1', listId: 'abcd1234' }), row);
    assert.ok(h.requests.every((r) => r.method === 'GET'), 'no toggle for an archived list');
  },
  archive_list_bad_readback: async (h) => {
    // The pre-PATCH roster is valid; only the post-PATCH archived read-back is bad.
    for (const bad of [() => json(null), html]) {
      let patched = false;
      h.respond(routes({
        'GET /lists': () => json({ data: [list('l1')] }),
        'GET /archived-lists': () => (patched ? bad() : json({ data: [] })),
        'PATCH /lists/l1/archive': () => { patched = true; return json({ data: list('l1', { archived: true }) }); },
      }));
      await h.fail('archive_list', { boardId: 'b1', listId: 'l1' }, 'invalid-response');
      assert.deepEqual(calls(h).map(([method]) => method), ['GET', 'GET', 'PATCH', 'GET']);
    }
  },
  archive_list_state_conflict: async (h) => {
    const open = { 'GET /lists': () => json({ data: [list('l1')] }), 'GET /archived-lists': () => json({ data: [] }) };
    // The PATCH reports the list open (a concurrent archive toggled it back).
    h.respond(routes({ ...open, 'PATCH /lists/l1/archive': () => json({ data: list('l1', { archived: false }) }) }));
    await h.fail('archive_list', { boardId: 'b1', listId: 'l1' }, 'archive-state-conflict');
    // Archived per the PATCH, but missing from the archived read-back.
    h.respond(routes({ ...open, 'PATCH /lists/l1/archive': () => json({ data: list('l1', { archived: true }) }) }));
    await h.fail('archive_list', { boardId: 'b1', listId: 'l1' }, 'archive-state-conflict');
  },
  archive_list_not_in_board: async (h) => {
    h.respond(routes({ 'GET /lists': () => json({ data: [list('l1')] }), 'GET /archived-lists': () => json({ data: [] }) }));
    await h.fail('archive_list', { boardId: 'b1', listId: 'other' }, 'not-in-board');
    assert.ok(h.requests.every((r) => r.method === 'GET'));
  },
  delete_list: async (h) => {
    const args = { boardId: 'b1', listId: 'l1' };
    let gone = false;
    const ok = {
      'DELETE /lists/l1': () => { gone = true; return noContent(); },
      'GET /lists': () => json({ data: gone ? [list('l2')] : [list('l1'), list('l2')] }),
      'GET /archived-lists': () => json({ data: [] }),
    };
    h.respond(routes(ok));
    assert.deepEqual(await h.ok('delete_list', args), { deleted: true, id: 'l1' });
    assert.deepEqual(calls(h), [
      ['GET', '/api/v1/boards/b1/lists', undefined],
      ['GET', '/api/v1/boards/b1/archived-lists', undefined],
      ['DELETE', '/api/v1/lists/l1', undefined],
      ['GET', '/api/v1/boards/b1/lists', undefined],
      ['GET', '/api/v1/boards/b1/archived-lists', undefined],
    ]);
    h.respond(routes({ ...ok, 'GET /lists': () => json({ data: [list('l1')] }) }));
    await h.fail('delete_list', args, 'delete-failed');
    // The server refuses a non-empty list without confirm:true (Python sends none either).
    h.respond(routes({ ...ok, 'DELETE /lists/l1': () => apiError(409, 'delete-requires-confirmation'), 'GET /lists': () => json({ data: [list('l1')] }) }));
    await h.fail('delete_list', args, 'delete-requires-confirmation');
    // The route answers 204; a JSON 200 body is not its success.
    h.respond(routes({ ...ok, 'DELETE /lists/l1': () => json({ data: list('l1') }), 'GET /lists': () => json({ data: [list('l1')] }) }));
    await h.fail('delete_list', args, 'invalid-response');
    await badResponses(h, 'delete_list', args, { ...ok, 'GET /lists': () => json({ data: [list('l1')] }) }, 'GET /lists');
  },
  delete_list_archived_html: async (h) => {
    // An archived list is absent from GET /lists even when not deleted: an
    // HTML-200 DELETE must not pass as success.
    const row = list('l1', { archived: true });
    h.respond(routes({ 'DELETE /lists/l1': html, 'GET /lists': () => json({ data: [] }), 'GET /archived-lists': () => json({ data: [row] }) }));
    await h.fail('delete_list', { boardId: 'b1', listId: 'l1' }, 'invalid-response');
    // A 204 that left it in the archived lists is delete-failed.
    h.respond(routes({ 'DELETE /lists/l1': noContent, 'GET /lists': () => json({ data: [] }), 'GET /archived-lists': () => json({ data: [row] }) }));
    await h.fail('delete_list', { boardId: 'b1', listId: 'l1' }, 'delete-failed');
  },
  delete_list_not_in_board: async (h) => {
    h.respond(routes({ 'DELETE /lists/other': noContent, 'GET /lists': () => json({ data: [list('l1')] }), 'GET /archived-lists': () => json({ data: [] }) }));
    await h.fail('delete_list', { boardId: 'b1', listId: 'other' }, 'not-in-board');
    assert.ok(h.requests.every((r) => r.method === 'GET'), 'no DELETE on a list from another board');
  },
  update_board: async (h) => {
    const ok = { 'PATCH /boards/b1': () => json({ data: board }), 'GET /boards/b1': () => json({ data: board, includes: { lists: [] } }) };
    const cases: Array<[Record<string, unknown>, unknown]> = [
      [{ title: ' Board ' }, { title: ' Board ' }],
      [{ visibility: 'PRIVATE' }, { visibility: 'PRIVATE' }],
      [{ title: 'Board', description: 'd', visibility: 'PRIVATE' }, { title: 'Board', description: 'd', visibility: 'PRIVATE' }],
    ];
    for (const [extra, body] of cases) {
      h.respond(routes(ok));
      assert.deepEqual(await h.ok('update_board', { boardId: 'b1', ...extra }), board);
      assert.deepEqual(calls(h), [['PATCH', '/api/v1/boards/b1', body], ['GET', '/api/v1/boards/b1', undefined]]);
    }
    // An empty description is stored as null.
    const cleared = { ...board, description: null };
    h.respond(routes({ ...ok, 'GET /boards/b1': () => json({ data: cleared }) }));
    assert.deepEqual(await h.ok('update_board', { boardId: 'b1', description: '' }), cleared);
    h.respond(routes(ok));
    await h.fail('update_board', { boardId: 'b1' }, 'nothing-to-update');
    assert.equal(h.requests.length, 0);
    assert.equal((await h.call('update_board', { boardId: 'b1', visibility: 'SECRET' })).isError, true);
    assert.equal(h.requests.length, 0);
    // Read-back disagrees with any requested field.
    for (const wrong of [{ visibility: 'PUBLIC' }, { title: 'Other' }, { description: 'other' }, { description: '' }]) {
      h.respond(routes(ok));
      await h.fail('update_board', { boardId: 'b1', ...wrong }, 'readback-failed');
    }
    h.respond(routes({ ...ok, 'PATCH /boards/b1': () => apiError(403, 'insufficient-role') }));
    await h.fail('update_board', { boardId: 'b1', title: 'x' }, 'insufficient-role');
    assert.equal(h.requests.length, 1);
    await badResponses(h, 'update_board', { boardId: 'b1', title: 'Board' }, ok, 'PATCH /boards/b1');
    await badResponses(h, 'update_board', { boardId: 'b1', title: 'Board' }, ok, 'GET /boards/b1');
  },
});
