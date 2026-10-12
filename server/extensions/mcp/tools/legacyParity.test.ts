import { strict as assert } from 'node:assert';
import { registerMcpTools } from '../registerTools';
import { apiError, defineToolScenarios, html, json, TOKEN } from './toolSupport.fixture';

defineToolScenarios(import.meta, registerMcpTools, {
  'list alias lookup precedes canonical creation and preserves acknowledged later failure': async (
    h
  ) => {
    const boardId = '11111111-1111-4111-8111-111111111111';
    for (const fail of [false, true]) {
      h.respond(({ path, method }) =>
        path.endsWith('/labboard')
          ? json({ data: { id: boardId } })
          : method === 'POST'
            ? json({ data: { id: 'known-list' } })
            : fail
              ? apiError(500, 'read-failed')
              : json({ data: [{ id: 'known-list', board_id: boardId, title: 'List' }] })
      );
      const result = (await h.ok('create_list', { boardId: 'labboard', title: 'List' })) as Record<
        string,
        unknown
      >;
      assert.equal(result.id, 'known-list');
      assert.equal(result.verified, !fail);
      assert.deepEqual(
        h.requests.map((entry) => entry.method),
        ['GET', 'POST', 'GET']
      );
      assert.equal(h.requests[1]?.path, `/api/v1/boards/${boardId}/lists`);
    }
    for (const response of [apiError(403, 'forbidden'), json({ data: { id: 'not-canonical' } })]) {
      h.respond(() => response);
      assert.equal(
        (await h.call('create_list', { boardId: 'labboard', title: 'List' })).isError,
        true
      );
      assert.equal(h.requests.length, 1);
    }
  },
  'board background verification distinguishes exact observable values from lossy proxy': async (
    h
  ) => {
    const id = '11111111-1111-4111-8111-111111111111';
    const proxy = `/api/v1/boards/${id}/background`;
    for (const [input, actual, valid, lossy] of [
      [undefined, undefined, true, false],
      ['', null, true, false],
      ['', proxy, false, false],
      ['   ', proxy, false, false],
      ['  ', null, true, false],
      [' https://outside.test/a?b=1 ', 'https://outside.test/a?b=1', true, false],
      [' bare-key ', 'bare-key', true, false],
      ['#123456', '#123456', true, false],
      ['https://remote-bucket.s3.amazonaws.com/key', proxy, true, true],
      [proxy, proxy, true, true],
      ['value', undefined, false, false],
      ['value', {}, false, false],
      ['value', 'wrong', false, false],
    ] as const) {
      h.respond(({ method }) =>
        json({
          data:
            method === 'POST'
              ? { id }
              : {
                  id,
                  workspace_id: 'ws1',
                  title: 'Board',
                  visibility: 'PRIVATE',
                  ...(actual === undefined ? {} : { background: actual }),
                },
        })
      );
      const result = (await h.ok('create_board', {
        workspaceId: 'ws1',
        title: 'Board',
        ...(input === undefined ? {} : { background: input }),
      })) as Record<string, unknown>;
      assert.equal(result.id, id);
      assert.equal(result.request_outcome, 'succeeded');
      assert.equal(result.verified, valid && !lossy);
      if (lossy) {
        assert.deepEqual(result.unverified, ['background']);
        assert.equal(result.verification_error, undefined);
      } else if (!valid) assert.ok(result.verification_error);
    }
  },
  'board and list creation preserve IDs and selected text once after readback': async (h) => {
    h.respond(({ method }) =>
      json({
        data:
          method === 'POST'
            ? { id: 'b1' }
            : {
                id: 'b1',
                workspace_id: 'ws1',
                title: 'Board text العربية',
                description: 'Full description',
                visibility: 'PRIVATE',
              },
      })
    );
    const board = (await h.ok('create_board', {
      workspaceId: 'ws1',
      title: 'Board text العربية',
      description: 'Full description',
    })) as Record<string, unknown>;
    assert.equal(board.verified, true);
    assert.equal(board.request_outcome, 'succeeded');
    assert.deepEqual(board.observed, {});
    assert.equal(JSON.stringify(board).split('Full description').length - 1, 1);
    assert.deepEqual(
      h.requests.map((request) => request.method),
      ['POST', 'GET']
    );
    h.respond(({ method }) =>
      json({
        data:
          method === 'POST'
            ? { id: 'l1' }
            : [{ id: 'l1', board_id: '11111111-1111-4111-8111-111111111111', title: 'List text' }],
      })
    );
    const list = (await h.ok('create_list', {
      boardId: '11111111-1111-4111-8111-111111111111',
      title: 'List text',
    })) as Record<string, unknown>;
    assert.equal(list.verified, true);
    assert.equal(JSON.stringify(list).split('List text').length - 1, 1);
    assert.deepEqual(list.observed, {});
  },
  'board and list secondary read failures retain acknowledged IDs without observed fields': async (
    h
  ) => {
    for (const [name, args] of [
      ['create_board', { workspaceId: 'ws1', title: 'Board' }],
      ['create_list', { boardId: '11111111-1111-4111-8111-111111111111', title: 'List' }],
    ] as const) {
      for (const read of [
        () => apiError(403, 'forbidden'),
        html,
        () => json({ data: name === 'create_board' ? { id: 'wrong' } : [{ id: 'wrong' }] }),
      ]) {
        h.respond(({ method }) => (method === 'POST' ? json({ data: { id: 'known' } }) : read()));
        const result = (await h.ok(name, args)) as Record<string, unknown>;
        assert.equal(result.id, 'known');
        assert.equal(result.verified, false);
        assert.equal(result.request_outcome, 'succeeded');
        assert.equal(result.observed, undefined);
        assert.ok(result.verification_error);
      }
      h.respond(() => apiError(500, 'internal-error'));
      const unknown = (await h.ok(name, args)) as Record<string, unknown>;
      assert.equal(unknown.request_outcome, 'unknown');
      assert.equal(unknown.verified, false);
      h.respond(() => apiError(403, 'forbidden'));
      await h.fail(name, args, 'forbidden');
      assert.equal(h.requests.length, 1);
    }
  },
  'invite membership composite identity survives read failure without invented object ID': async (
    h
  ) => {
    const args = { boardId: 'b1', email: 'person@example.test', role: 'member' };
    h.respond(({ method }) =>
      json({
        data:
          method === 'POST'
            ? { id: 'u1' }
            : [{ user_id: 'u1', role: 'MEMBER', email: 'person@example.test' }],
      })
    );
    const result = (await h.ok('invite_to_board', args)) as Record<string, unknown>;
    assert.deepEqual(result, {
      board_id: 'b1',
      user_id: 'u1',
      request_outcome: 'succeeded',
      verified: true,
      verified_fields: ['membership', 'role'],
      observed: { present: true, role: 'MEMBER' },
    });
    for (const read of [
      () => apiError(403, 'forbidden'),
      html,
      () => json({ data: [{ user_id: 'u1', role: 'ADMIN' }] }),
      () => json({ data: [] }),
    ]) {
      h.respond(({ method }) => (method === 'POST' ? json({ data: { id: 'u1' } }) : read()));
      const failed = (await h.ok('invite_to_board', args)) as Record<string, unknown>;
      assert.equal(failed.board_id, 'b1');
      assert.equal(failed.user_id, 'u1');
      assert.equal(failed.id, undefined);
      assert.equal(failed.verified, false);
      assert.equal(failed.observed, undefined);
    }
    for (const code of ['ambiguous-email', 'board-member-exists', 'user-not-workspace-member']) {
      h.respond(() => apiError(409, code));
      await h.fail('invite_to_board', args, code);
      assert.equal(h.requests.length, 1);
    }
  },
  'legacy pass-through privacy and error boundaries preserve feature refusals': async (h) => {
    for (const [name, args] of [
      ['get_state_transitions', { boardId: 'b1' }],
      ['get_state_transition_rules', { boardId: 'b1' }],
      ['set_state_transitions', { boardId: 'b1', graph: [] }],
      ['copy_state_transitions', { boardId: 'b1', targetBoardId: 'b2' }],
      ['historical_import_validate', { plan: {} }],
      ['historical_import_dry_run', { plan: {} }],
      ['historical_import_reset', { planHash: 'a'.repeat(64) }],
    ] as const) {
      h.respond(() => apiError(501, 'not-implemented'));
      const failed = await h.call(name, args);
      assert.equal(failed.isError, true);
      assert.ok(!failed.text.includes(TOKEN));
      h.respond(() =>
        json({
          data: {
            retained: 'yes',
            nested: { ip_address: 'private', user_agent: 'private', content: TOKEN },
          },
        })
      );
      const response = await h.call(name, args);
      assert.equal(response.isError, false);
      assert.ok(!response.text.includes('private'));
      assert.ok(response.text.includes('retained'));
    }
    h.respond(() => apiError(403, `secret ${TOKEN}`));
    await h.fail('invite_to_board', { boardId: 'b1', email: 'person@example.test' }, 'api-error');
  },
});
