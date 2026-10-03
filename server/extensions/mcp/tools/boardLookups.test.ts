import { strict as assert } from 'node:assert';
import { registerBoardLookups } from './boardLookups';
import { defineToolScenarios, expectAnnotations, expectReadErrors, json, type Harness } from './toolSupport.fixture';

const ws = 'ws/1?x'; // exercises path encoding
const row = (id: string) => ({ id, name: `name ${id}`, extra: { kept: true } });

// Asserts one GET to `path`, the unwrapped `data` returned verbatim, then the shared error cases.
async function listContract(h: Harness, name: string, args: Record<string, unknown>, path: string, rows: unknown[]) {
  h.respond(() => json({ data: rows }));
  assert.deepEqual(await h.ok(name, args), rows);
  assert.deepEqual(h.requests.map(({ method, path: p, body }) => ({ method, path: p, body })),
    [{ method: 'GET', path, body: undefined }]);
  h.respond(() => json({ data: [] }));
  assert.deepEqual(await h.ok(name, args), []);
  await expectReadErrors(h, name, args);
}

defineToolScenarios(import.meta, registerBoardLookups, {
  registration: (h) => {
    expectAnnotations(h, ['get_me', 'list_workspaces', 'list_workspace_boards', 'list_workspace_members',
      'get_board', 'list_lists', 'list_labels', 'list_board_members', 'list_cards', 'list_archived_cards'],
    { readOnlyHint: true });
  },
  get_me: async (h) => {
    const me = { id: 'u1', email: 'a@example.test', name: 'A' };
    h.respond(() => json({ data: me }));
    assert.deepEqual(await h.ok('get_me'), me);
    assert.deepEqual(h.requests.map((r) => [r.method, r.path]), [['GET', '/api/v1/users/me']]);
    await expectReadErrors(h, 'get_me');
  },
  list_workspaces: (h) => listContract(h, 'list_workspaces', {}, '/api/v1/workspaces', [row('w1')]),
  list_workspace_boards: (h) => listContract(h, 'list_workspace_boards', { workspaceId: ws },
    '/api/v1/workspaces/ws%2F1%3Fx/boards', [row('b1'), row('b2')]),
  list_workspace_members: async (h) => {
    await listContract(h, 'list_workspace_members', { workspaceId: 'w1' }, '/api/v1/workspaces/w1/members',
      [{ userId: 'u1', email: 'a@example.test', name: 'A', role: 'ADMIN' }]);
    h.respond(() => json({ data: [{ user_id: 'u1' }] }));
    await h.fail('list_workspace_members', { workspaceId: 'w1' }, 'invalid-response');
  },
  get_board: async (h) => {
    const body = { data: { id: 'b1', title: 'Board' }, includes: { lists: [row('l1')], cards: [] } };
    h.respond(() => json(body));
    assert.deepEqual(await h.ok('get_board', { boardId: 'abcd1234' }), body);
    assert.deepEqual(h.requests.map((r) => [r.method, r.path]), [['GET', '/api/v1/boards/abcd1234']]);
    await expectReadErrors(h, 'get_board', { boardId: 'b1' });
  },
  list_lists: (h) => listContract(h, 'list_lists', { boardId: 'b1' }, '/api/v1/boards/b1/lists', [row('l1')]),
  list_labels: (h) => listContract(h, 'list_labels', { boardId: 'b1' }, '/api/v1/boards/b1/labels',
    [{ id: 'lb1', name: 'Bug', color: '#f00' }]),
  list_board_members: async (h) => {
    await listContract(h, 'list_board_members', { boardId: 'b1' }, '/api/v1/boards/b1/members',
      [{ user_id: 'u1', email: 'a@example.test', display_name: 'A', role: 'ADMIN' }]);
    h.respond(() => json({ data: [{ id: 'u1' }] }));
    await h.fail('list_board_members', { boardId: 'b1' }, 'invalid-response');
  },
  list_cards: async (h) => {
    const cards = [row('c1'), row('c2')];
    // No pagination args: no query string, no metadata key.
    h.respond(() => json({ data: cards }));
    assert.deepEqual(await h.ok('list_cards', { listId: 'l1' }), { data: cards });
    assert.deepEqual(h.requests.map((r) => [r.method, r.path]), [['GET', '/api/v1/lists/l1/cards']]);
    // Pagination: exact query, metadata passed through unchanged.
    const metadata = { total: 9, limit: 2, offset: 4, nextOffset: 6, hasMore: true };
    h.respond(() => json({ data: cards, metadata }));
    assert.deepEqual(await h.ok('list_cards', { listId: 'l1', limit: 2, offset: 4 }), { data: cards, metadata });
    assert.deepEqual(h.requests.map((r) => r.path), ['/api/v1/lists/l1/cards?limit=2&offset=4']);
    // Out-of-range arguments are rejected before any request.
    h.respond(() => json({ data: cards }));
    assert.equal((await h.call('list_cards', { listId: 'l1', limit: 0 })).isError, true);
    assert.equal(h.requests.length, 0);
    await expectReadErrors(h, 'list_cards', { listId: 'l1' });
  },
  list_archived_cards: (h) => listContract(h, 'list_archived_cards', { boardId: 'b1' },
    '/api/v1/boards/b1/archived-cards', [row('c9')]),
});
