import { strict as assert } from 'node:assert';
import { registerSearchCards } from './searchCards';
import { registerSearchBoard } from './searchBoard';
import { apiError, defineToolScenarios, json, type RecordedRequest } from './toolSupport.fixture';

const ws = '11111111-1111-4111-8111-111111111111';
const board = '22222222-2222-4222-8222-222222222222';
const list = '33333333-3333-4333-8333-333333333333';
const id = 'abcdefab-4444-4444-8444-444444444444';
const other = '55555555-5555-4555-8555-555555555555';
const row = {
  id,
  type: 'card',
  title: 'Synthetic',
  list_id: list,
  board_id: board,
  workspace_id: ws,
  rank: 3,
};
const detail = {
  data: { id, list_id: list, description: 'Complete العربية 🐦', unrelated: 'do not merge' },
  includes: {
    list: { id: list, board_id: board },
    board: { id: board },
    children: ['do not merge'],
  },
};
const args = { workspaceId: ws, query: 'Synthetic', includeDescription: true };
const register = (server: Parameters<typeof registerSearchCards>[0], token: string) => {
  registerSearchCards(server, token);
  registerSearchBoard(server, token);
};
const respond = (request: RecordedRequest, data: unknown[], fresh = detail) => {
  if (request.path.includes('/search?'))
    return json({ data, metadata: { cursor: 'kept', user_agent: 'private' } });
  if (request.path === `/api/v1/cards/${id}`) return json(fresh);
  if (request.path === `/api/v1/boards/${board}`)
    return json({ data: { id: board, workspace_id: ws } });
  throw new Error('Unexpected fixture request');
};

defineToolScenarios(import.meta, register, {
  'default stays one request; full overrides includeDescription false and preserves mixed order/envelope':
    async (h) => {
      const mixed = [
        { id: board, type: 'board', title: 'Board', extra: 'kept' },
        row,
        { ...row, id: id.toUpperCase() },
      ];
      h.respond((request) => respond(request, mixed));
      const compact = (await h.ok('search_cards', { workspaceId: ws, query: 'Synthetic' })) as {
        data: Record<string, unknown>[];
      };
      assert.equal(h.requests.length, 1);
      assert.ok(!('description' in (compact.data[1] ?? {})));
      h.respond((request) => respond(request, mixed));
      const full = (await h.ok('search_cards', {
        ...args,
        view: 'full',
        includeDescription: false,
      })) as { data: Record<string, unknown>[]; metadata: unknown };
      assert.deepEqual(full.data, [
        mixed[0],
        { ...row, description: detail.data.description },
        { ...row, id: id.toUpperCase(), description: detail.data.description },
      ]);
      assert.deepEqual(full.metadata, { cursor: 'kept' });
      assert.equal(h.requests.length, 3);
      assert.ok(
        h.requests.every(
          (request) => request.method === 'GET' && request.authorization?.startsWith('Bearer ')
        )
      );
      assert.ok(!JSON.stringify(full).includes('do not merge'));
    },
  'existing empty string and null descriptions skip hydration; board normal and wildcard remain one GET':
    async (h) => {
      for (const description of ['', null, 'already complete']) {
        h.respond((request) => respond(request, [{ ...row, description }]));
        const full = (await h.ok('search_cards', { ...args, view: 'full' })) as {
          data: Record<string, unknown>[];
        };
        assert.equal(full.data[0]?.description, description);
        assert.equal(h.requests.length, 1);
        h.respond((request) => respond(request, [{ ...row, description }]));
        const compact = (await h.ok('search_cards', args)) as { data: Record<string, unknown>[] };
        assert.equal(compact.data[0]?.description, description === null ? undefined : description);
        assert.equal(h.requests.length, 1);
      }
      for (const query of ['Synthetic', '*']) {
        h.respond((request) =>
          respond(request, [{ ...row, description: detail.data.description }])
        );
        const result = (await h.ok('search_board', { boardId: board, query, view: 'full' })) as {
          data: Record<string, unknown>[];
        };
        assert.equal(result.data[0]?.description, detail.data.description);
        assert.equal(h.requests.length, 1);
      }
    },
  'selected bound malformed present values and contradictory duplicate scopes fail before hydration':
    async (h) => {
      for (const data of [
        [{ ...row, description: 17 }],
        [{ ...row, id: 'not-uuid' }],
        [{ ...row, workspace_id: other }],
        [row, { ...row, list_id: other }],
        [row, { ...row, board_id: other }],
        [
          { ...row, description: 'one' },
          { ...row, description: 'two' },
        ],
        [row, row, row],
      ]) {
        h.respond((request) => respond(request, data));
        await h.fail('search_cards', { ...args, limit: 2 }, 'invalid-response');
        assert.equal(h.requests.length, 1);
      }
    },
  'fresh card hierarchy description and board workspace failures never return partial text': async (
    h
  ) => {
    for (const fresh of [
      { ...detail, data: { ...detail.data, id: other } },
      { ...detail, data: { ...detail.data, list_id: other } },
      { ...detail, data: { id, list_id: list } },
      { ...detail, data: { ...detail.data, description: 17 } },
      { ...detail, includes: { ...detail.includes, list: { id: other, board_id: board } } },
      { ...detail, includes: { ...detail.includes, list: { id: list, board_id: other } } },
      { ...detail, includes: { ...detail.includes, board: { id: other } } },
    ]) {
      h.respond((request) => respond(request, [row], fresh as typeof detail));
      await h.fail('search_cards', args, 'invalid-response');
    }
    for (const data of [
      { id: board, workspace_id: other },
      { id: other, workspace_id: ws },
      { id: board },
    ]) {
      h.respond((request) =>
        request.path === `/api/v1/boards/${board}` ? json({ data }) : respond(request, [row])
      );
      await h.fail('search_cards', args, 'invalid-response');
    }
    for (const path of [`/api/v1/cards/${id}`, `/api/v1/boards/${board}`]) {
      h.respond((request) =>
        request.path === path ? apiError(403, 'forbidden') : respond(request, [row])
      );
      await h.fail('search_cards', args, 'forbidden');
    }
    h.respond((request) => respond(request, [row, { ...row, description: 'stale contradiction' }]));
    await h.fail('search_cards', args, 'invalid-response');
  },
  'two unique cards share one board read and preserve null from fresh detail': async (h) => {
    h.respond((request) =>
      request.path === `/api/v1/cards/${other}`
        ? json({ ...detail, data: { ...detail.data, id: other, description: null } })
        : respond(request, [row, { ...row, id: other }])
    );
    const full = (await h.ok('search_cards', { ...args, view: 'full' })) as {
      data: Record<string, unknown>[];
    };
    assert.equal(full.data[0]?.description, detail.data.description);
    assert.equal(full.data[1]?.description, null);
    assert.equal(h.requests.length, 4);
    assert.equal(
      h.requests.filter((request) => request.path === `/api/v1/boards/${board}`).length,
      1
    );
  },
});
