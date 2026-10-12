import { strict as assert } from 'node:assert';
import { z } from 'zod';
import { registerMcpTools } from '../registerTools';
import { config } from '../config';
import python from './pythonOperation.fixture.json';
import projection from './pythonProjection.fixture.json';
import { apiError, defineToolScenarios, html, json } from './toolSupport.fixture';

const cardId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const itemId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const card = (items: unknown[] = [], extra = {}) => ({
  data: {
    id: cardId,
    title: 'New',
    description: 'العربية 🐦',
    list_id: 'list1',
    archived: false,
    due_date: null,
    due_complete: false,
    ...extra,
  },
  includes: { checklists: [], checklistItems: items },
});
const item = (id = itemId, extra = {}) => ({
  id,
  card_id: cardId,
  checklist_id: 'cl1',
  title: 'one',
  checked: false,
  ...extra,
});

defineToolScenarios(import.meta, registerMcpTools, {
  'move defaults to native bottom while explicit null and position zero select top': async (h) => {
    for (const [args, top] of [
      [{}, false],
      [{ afterCardId: null }, true],
      [{ position: 0 }, true],
    ] as const) {
      h.respond(({ path }) =>
        path.includes('/lists/')
          ? json({ data: (top ? [cardId, otherId] : [otherId, cardId]).map((id) => ({ id })) })
          : json(card([], { list_id: 'list1' }))
      );
      const result = await h.ok('move_card', { cardId, targetListId: 'list1', ...args });
      assert.equal(z.object({ verified: z.boolean() }).parse(result).verified, true);
      const patch = h.requests.find((request) => request.method === 'PATCH');
      assert.deepEqual(
        patch?.body,
        top ? { targetListId: 'list1', afterCardId: null } : { targetListId: 'list1' }
      );
    }
  },
  'native SDK payload regression retains text while removing full-card write context': async (
    h
  ) => {
    const fixture = projection.cases.find((entry) => entry.name === 'compact-card');
    assert.ok(fixture);
    h.respond(() => json(fixture.input));
    const compact = await h.call('get_card', { cardId });
    assert.equal(compact.isError, false);
    const baselineBytes = new TextEncoder().encode(JSON.stringify(fixture.input)).byteLength;
    const compactBytes = new TextEncoder().encode(compact.text).byteLength;
    assert.equal(baselineBytes, 1828);
    assert.equal(compactBytes, 1641);
    const write = await h.call('archive_card', { cardId, archived: false });
    assert.equal(write.isError, false);
    assert.ok(new TextEncoder().encode(write.text).byteLength < baselineBytes / 10);
    assert.equal(
      z.object({ write_skipped: z.boolean() }).parse(JSON.parse(write.text)).write_skipped,
      true
    );
  },
  'compact card preserves full text once and recursively scrubs full and opaque views': async (
    h
  ) => {
    const response = {
      ...card(),
      includes: {
        ...card().includes,
        checklists: [{ id: 'cl1', title: 'Checklist', items: [item()] }],
        checklistItems: [item()],
        attachments: [{ name: 'file' }],
        activities: [
          {
            id: 'a1',
            payload: { ip_address: 'private', nested: { user_agent: 'private', text: 'retained' } },
          },
        ],
      },
      unexpected: { user_agent: 'private', kept: true },
    };
    h.respond(() => json(response));
    const compact = (await h.ok('get_card', { cardId, include_activities: true })) as Record<
      string,
      unknown
    >;
    const text = JSON.stringify(compact);
    assert.ok(text.includes('العربية 🐦'));
    assert.equal(text.split('"title":"one"').length - 1, 1);
    assert.ok(!text.includes('private'));
    assert.ok(!text.includes('attachments'));
    const full = JSON.stringify(await h.ok('get_card', { cardId, view: 'full' }));
    assert.ok(full.includes('attachments'));
    assert.ok(!full.includes('private'));
    h.respond(() =>
      json({ ...card(), includes: ['opaque', { ip_address: 'private', kept: true }] })
    );
    const opaque = (await h.ok('get_card', { cardId })) as Record<string, unknown>;
    assert.deepEqual(opaque.includes, ['opaque', { kept: true }]);
  },
  'bounded lists and searches preserve envelope metadata and optional complete descriptions':
    async (h) => {
      const body = {
        data: [{ ...card().data, ui_noise: 'large' }],
        metadata: { hasMore: true },
        future: { kept: 'yes', user_agent: 'private' },
      };
      for (const [name, args] of [
        ['list_cards', { listId: 'list1' }],
        ['search_cards', { workspaceId: 'ws1', query: 'text' }],
        ['search_board', { boardId: 'b1', q: 'text' }],
      ] as const) {
        h.respond(() => json(body));
        const result = (await h.ok(name, args)) as typeof body;
        assert.equal(result.data[0]?.description, undefined);
        assert.deepEqual(result.metadata, { hasMore: true });
        assert.deepEqual(result.future, { kept: 'yes' });
        assert.ok(
          h.requests[0]?.path.includes(name === 'list_cards' ? 'limit=50&offset=0' : 'limit=20')
        );
        const described = (await h.ok(name, { ...args, includeDescription: true })) as typeof body;
        assert.equal(described.data[0]?.description, 'العربية 🐦');
        const full = (await h.ok(name, { ...args, view: 'full' })) as typeof body;
        assert.equal(full.data[0]?.ui_noise, 'large');
        h.respond(() => json(body));
        assert.equal((await h.call(name, { ...args, limit: 101 })).isError, true);
        assert.equal(h.requests.length, 0);
      }
    },
  'latest parent window fetches only selected replies and distinguishes completeness': async (
    h
  ) => {
    const parents = Array.from({ length: 25 }, (_, index) => ({
      id: `parent-${String(index)}`,
      card_id: cardId,
      parent_id: null,
      content: `完整-${String(index)}`,
      created_at: 'same',
      deleted: false,
      reply_count: 1,
    }));
    h.respond(({ path }) =>
      path.endsWith('/comments')
        ? json({ data: parents })
        : json({
            data: [
              {
                id: `reply-${String(path.split('/').at(-2))}`,
                card_id: cardId,
                parent_id: path.split('/').at(-2),
                content: 'reply',
                created_at: 'same',
                deleted: false,
              },
            ],
          })
    );
    const result = (await h.ok('get_card_discussion', { cardId })) as {
      data: Array<{ id: string }>;
      complete: boolean;
      page_complete: boolean;
      pagination: unknown;
    };
    assert.equal(result.complete, false);
    assert.equal(result.page_complete, true);
    assert.equal(result.data[0]?.id, 'parent-5');
    assert.equal(result.data.length, 40);
    assert.equal(h.requests.length, 21);
    assert.deepEqual(result, python.discussion.expected);
    assert.deepEqual(
      h.requests.map((request) => request.method),
      python.discussion.methods
    );
    assert.deepEqual(result.pagination, {
      total_threads: 25,
      returned_threads: 20,
      omitted_threads: 5,
      offset: 0,
      limit: 20,
      next_offset: 20,
    });
    h.requests.length = 0;
    const all = (await h.ok('get_card_discussion', { cardId, all: true })) as {
      complete: boolean;
      data: unknown[];
    };
    assert.equal(all.complete, true);
    assert.equal(all.data.length, 50);
    assert.equal(h.requests.length, 26);
  },
  'omitted malformed parents and reserved parent identities cannot disappear': async (h) => {
    const parents = [
      {
        id: itemId,
        card_id: cardId,
        parent_id: null,
        content: 'old',
        created_at: 'same',
        deleted: false,
        reply_count: 0,
      },
      {
        id: otherId,
        card_id: cardId,
        parent_id: null,
        content: 'new',
        created_at: 'same',
        deleted: false,
        reply_count: 1,
      },
    ];
    h.respond(({ path }) =>
      path.endsWith('/comments')
        ? json({ data: parents })
        : json({ data: [{ ...parents[0], parent_id: otherId, reply_count: 0 }] })
    );
    const result = (await h.ok('get_card_discussion', { cardId, limit: 1 })) as {
      page_complete: boolean;
      issues: unknown[];
    };
    assert.equal(result.page_complete, false);
    assert.ok(result.issues.length);
    h.respond(() => json({ data: [{ ...parents[0], card_id: 'foreign' }, parents[1]] }));
    await h.fail('get_card_discussion', { cardId, limit: 1 }, 'bad-response');
  },
  'exact timestamp writes preserve microseconds and reject lossy or invalid values before HTTP':
    async (h) => {
      const original = '2026-10-12T12:34:56.123456+02:00';
      h.respond(() => json(card([], { due_date: '2026-10-12T10:34:56.123456Z' })));
      const result = (await h.ok('set_card_due', { cardId, dueDate: original })) as {
        verified: boolean;
      };
      assert.equal(result.verified, true);
      assert.deepEqual(h.requests[0]?.body, { due_date: original });
      for (const actual of ['2026-10-12T10:34:56.123457Z', '2026-10-12T10:34:56.1234567Z']) {
        h.respond(() => json(card([], { due_date: actual })));
        await h.fail('set_card_due', { cardId, dueDate: original }, 'readback-mismatch');
      }
      for (const invalid of [
        '2026-02-30T00:00:00Z',
        '2026-10-12',
        '2026-10-12T12:00:00',
        '2026-10-12T00:00:00.1234567Z',
        '2026-10-12T24:00:00Z',
        '2026-10-12T00:00:00+24:00',
      ]) {
        h.respond(() => json(card()));
        assert.equal((await h.call('set_card_due', { cardId, dueDate: invalid })).isError, true);
        assert.equal(h.requests.length, 0);
      }
    },
  'exact finite prices refuse numeric-string rounding and unsafe integer inputs': async (h) => {
    for (const [amount, actual] of [
      [0.1, '0.1000'],
      [1e-7, '0.000000100'],
      [123.45, '+123.450'],
    ] as const) {
      h.respond(() => json(card([], { amount: actual })));
      assert.equal(
        ((await h.ok('set_card_price', { cardId, amount })) as { verified: boolean }).verified,
        true
      );
    }
    for (const actual of ['0.10000000000000001', ' 0.1', '1e-1', 'NaN', '0_1']) {
      h.respond(() => json(card([], { amount: actual })));
      await h.fail('set_card_price', { cardId, amount: 0.1 }, 'readback-mismatch');
    }
    h.respond(() => json(card()));
    assert.equal(
      (await h.call('set_card_price', { cardId, amount: 9007199254740992 })).isError,
      true
    );
    assert.equal(h.requests.length, 0);
  },
  'acknowledged creation survives wrong identity and secondary read failures': async (h) => {
    for (const name of ['create_card', 'copy_card', 'create_checklist', 'add_checklist_item']) {
      const args =
        name === 'create_card'
          ? { listId: 'list1', title: 'New' }
          : name === 'copy_card'
            ? { cardId, targetListId: 'list1' }
            : name === 'create_checklist'
              ? { cardId, title: 'Checklist' }
              : { checklistId: 'cl1', title: 'one' };
      h.respond(({ method }) =>
        method === 'POST' ? json({ data: { id: itemId } }) : apiError(403, 'forbidden')
      );
      const result = (await h.ok(name, args)) as Record<string, unknown>;
      assert.equal(result.id, itemId);
      assert.equal(result.request_outcome, 'succeeded');
      assert.equal(result.verified, false);
      assert.equal(result.observed, undefined);
      assert.ok(result.verification_error);
      h.respond(() => html());
      const unknown = (await h.ok(name, args)) as Record<string, unknown>;
      assert.equal(unknown.request_outcome, 'unknown');
      assert.equal(unknown.id, undefined);
      assert.equal(h.requests.length, 1);
    }
  },
  'comment creation observes only a unique target and retains id on failure': async (h) => {
    const target = { id: itemId, card_id: cardId, parent_id: null, content: 'text' };
    h.respond(({ method, path }) =>
      method === 'POST'
        ? json({ data: target })
        : path.endsWith('/comments')
          ? json({ data: [null, { nonsense: true }, target], metadata: { unknown: true } })
          : json(card())
    );
    const result = (await h.ok('write_comment', { cardId, text: 'text' })) as Record<
      string,
      unknown
    >;
    assert.equal(result.verified, true);
    assert.equal(JSON.stringify(result).split('"text"').length - 1, 1);
    h.respond(({ method, path }) =>
      method === 'POST'
        ? json({ data: target })
        : path.endsWith('/comments')
          ? json({ data: [target, target] })
          : json(card())
    );
    const failed = (await h.ok('write_comment', { cardId, content: 'text' })) as Record<
      string,
      unknown
    >;
    assert.equal(failed.id, itemId);
    assert.equal(failed.verified, false);
    assert.equal(failed.observed, undefined);
  },
  'batch success costs N PATCH + 2 GET and selected text occurs once': async (h) => {
    const rows = [item(), item(otherId)];
    h.respond(({ method, path, body }) => {
      if (method === 'PATCH') {
        const row = rows.find((row) => path.includes(row.id));
        assert.ok(row);
        Object.assign(row, body);
        return json({ data: { id: row.id } });
      }
      return json(card(rows));
    });
    const result = (await h.ok('set_checklist_items', {
      cardId,
      items: [
        { itemId, checked: true },
        { itemId: otherId, title: 'two' },
      ],
    })) as { complete: boolean; items: unknown[] };
    assert.equal(result.complete, true);
    assert.deepEqual(
      h.requests.map((request) => request.method),
      ['GET', 'PATCH', 'PATCH', 'GET']
    );
    assert.equal(JSON.stringify(result).split('"two"').length - 1, 1);
    assert.deepEqual(result, python.batch.expected);
    assert.deepEqual(
      h.requests.map((request) => request.method),
      python.batch.methods
    );
  },
  'batch ambiguous slug5xx remains unknown even when observed state matches': async (h) => {
    const rows = [item(), item(otherId)];
    h.respond(({ method, body }) => {
      if (method === 'PATCH') {
        Object.assign(rows[0] ?? {}, body);
        return apiError(500, 'internal-error');
      }
      return json(card(rows));
    });
    const result = (await h.ok('set_checklist_items', {
      cardId,
      items: [
        { itemId, checked: true },
        { itemId: otherId, checked: true },
      ],
    })) as { complete: boolean; partial: boolean; items: Array<Record<string, unknown>> };
    assert.equal(result.complete, false);
    assert.equal(result.partial, true);
    assert.ok(result.items[0]);
    assert.equal(result.items[0].request_outcome, 'unknown');
    assert.equal(result.items[0].observation, 'matches');
    assert.equal(result.items[0].verified, true);
    assert.ok(result.items[0].error);
    assert.ok(result.items[1]);
    assert.equal(result.items[1].request_outcome, 'not_attempted');
    assert.equal(result.items[1].observation, 'unknown');
    assert.equal(h.requests.length, 3);
  },
  'batch timeout and malformed ack remain unknown after a matching read': async (h) => {
    for (const mode of ['timeout', 'malformed']) {
      const rows = [item()];
      config.timeoutMs = 15;
      h.respond(async ({ method, body }) => {
        if (method === 'PATCH') {
          Object.assign(rows[0] ?? {}, body);
          if (mode === 'timeout') await Bun.sleep(40);
          return mode === 'malformed' ? html() : json({ data: rows[0] });
        }
        return json(card(rows));
      });
      const result = (await h.ok('set_checklist_items', {
        cardId,
        items: [{ itemId, checked: true }],
      })) as { complete: boolean; items: Array<Record<string, unknown>> };
      assert.equal(result.complete, false);
      assert.ok(result.items[0]);
      assert.equal(result.items[0].request_outcome, 'unknown');
      assert.equal(result.items[0].observation, 'matches');
      assert.ok(result.items[0].error);
    }
    config.timeoutMs = 30_000;
  },
  'batch preflight rejects foreign duplicated and cross-card identities without PATCH': async (
    h
  ) => {
    for (const rows of [
      [item(), item(itemId.toUpperCase())],
      [item(itemId, { card_id: 'foreign' })],
    ]) {
      h.respond(() => json(card(rows)));
      await h.fail(
        'set_checklist_items',
        { cardId, items: [{ itemId, checked: true }] },
        'invalid-response'
      );
      assert.equal(h.requests.length, 1);
    }
    h.respond(() => json(card([item()])));
    await h.fail(
      'set_checklist_items',
      { cardId, items: [{ itemId: otherId, checked: true }] },
      'not-in-card'
    );
    assert.equal(h.requests.length, 1);
    for (const items of [
      [
        { itemId, checked: true },
        { itemId: itemId.toUpperCase(), title: 'x' },
      ],
      [{ itemId, checked: 'true' }],
      [{ itemId, checked: true, extra: 'no' }],
      [{ itemId }],
    ]) {
      h.respond(() => json(card()));
      assert.equal((await h.call('set_checklist_items', { cardId, items })).isError, true);
      assert.equal(h.requests.length, 0);
    }
  },
  'batch failed final read retains successful outcomes without verification': async (h) => {
    let reads = 0;
    h.respond(({ method }) =>
      method === 'PATCH'
        ? json({ data: item() })
        : reads++ === 0
          ? json(card([item()]))
          : apiError(403, 'forbidden')
    );
    const result = (await h.ok('set_checklist_items', {
      cardId,
      items: [{ itemId, checked: true }],
    })) as {
      items: Array<Record<string, unknown>>;
      readback_error: unknown;
      complete: boolean;
    };
    assert.ok(result.items[0]);
    assert.equal(result.items[0].request_outcome, 'succeeded');
    assert.equal(result.items[0].observation, 'unknown');
    assert.equal(result.items[0].observed, undefined);
    assert.equal(result.complete, false);
    assert.ok(result.readback_error);
  },
});
