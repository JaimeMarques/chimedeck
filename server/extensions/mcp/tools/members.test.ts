import { strict as assert } from 'node:assert';
import { registerMemberTools } from './members';
import {
  apiError, defineToolScenarios, expectAnnotations, html, json, type Harness, type RecordedRequest,
} from './toolSupport.fixture';

const user = { id: 'u1', email: 'a@example.test', name: 'A', avatar_url: null };
const card = (members: unknown[]) => ({ data: { id: 'c1', title: 'Card' }, includes: { labels: [], members } });
const member = (role: string) => ({ user_id: 'u1', email: 'a@example.test', display_name: 'A', role });
const calls = (h: Harness) => h.requests.map(({ method, path, body }) => ({ method, path, body }));
const empty = () => new Response(null, { status: 204 });

// Write-then-read tools: the write fails, null/HTML-200 answers, the read-back fails.
async function writeErrors(h: Harness, name: string, args: Record<string, unknown>, write: string) {
  const isWrite = (r: RecordedRequest) => r.method === write;
  h.respond((r) => (isWrite(r) ? apiError(404, 'board-not-found') : json(null)));
  await h.fail(name, args, 'board-not-found');
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

defineToolScenarios(import.meta, registerMemberTools, {
  registration: (h) => {
    expectAnnotations(h, ['add_card_member', 'remove_card_member', 'add_board_member', 'set_board_member_role'],
      { readOnlyHint: undefined });
  },
  add_card_member: async (h) => {
    const after = card([user]);
    h.respond((r) => (r.method === 'POST' ? json({ data: { card_id: 'c1', user_id: 'u1' } }, 201) : json(after)));
    assert.deepEqual(await h.ok('add_card_member', { cardId: 'c1', userId: 'u1' }), after);
    assert.deepEqual(calls(h), [
      { method: 'POST', path: '/api/v1/cards/c1/members', body: { userId: 'u1' } },
      { method: 'GET', path: '/api/v1/cards/c1', body: undefined },
    ]);
    h.respond((r) => (r.method === 'POST' ? json({ data: {} }) : json(card([]))));
    await h.fail('add_card_member', { cardId: 'c1', userId: 'u1' }, 'readback-failed');
    h.respond((r) => (r.method === 'POST' ? json({ data: {} }) : json({ data: { id: 'c1' }, includes: {} })));
    await h.fail('add_card_member', { cardId: 'c1', userId: 'u1' }, 'invalid-response');
    await writeErrors(h, 'add_card_member', { cardId: 'c1', userId: 'u1' }, 'POST');
  },
  remove_card_member: async (h) => {
    const after = card([]);
    h.respond((r) => (r.method === 'DELETE' ? empty() : json(after)));
    assert.deepEqual(await h.ok('remove_card_member', { cardId: 'c1', userId: 'u/1' }), after);
    assert.deepEqual(calls(h), [
      { method: 'DELETE', path: '/api/v1/cards/c1/members/u%2F1', body: undefined },
      { method: 'GET', path: '/api/v1/cards/c1', body: undefined },
    ]);
    h.respond((r) => (r.method === 'DELETE' ? empty() : json(card([user]))));
    await h.fail('remove_card_member', { cardId: 'c1', userId: 'u1' }, 'readback-failed');
    await writeErrors(h, 'remove_card_member', { cardId: 'c1', userId: 'u1' }, 'DELETE');
  },
  add_board_member: async (h) => {
    const roster = { data: [member('ADMIN'), { ...member('MEMBER'), user_id: 'u2' }] };
    h.respond((r) => (r.method === 'POST' ? json({ data: user }, 201) : json(roster)));
    assert.deepEqual(await h.ok('add_board_member', { boardId: 'b1', userId: 'u1', role: 'admin' }), member('ADMIN'));
    assert.deepEqual(calls(h), [
      { method: 'POST', path: '/api/v1/boards/b1/members', body: { userId: 'u1', role: 'ADMIN' } },
      { method: 'GET', path: '/api/v1/boards/b1/members', body: undefined },
    ]);
    // Role defaults to MEMBER, as Python sends "member"; no roster pre-check.
    h.respond((r) => (r.method === 'POST' ? json({ data: user }, 201) : json(roster)));
    assert.deepEqual(await h.ok('add_board_member', { boardId: 'b1', userId: 'u2' }), roster.data[1]);
    assert.deepEqual(calls(h)[0], { method: 'POST', path: '/api/v1/boards/b1/members', body: { userId: 'u2', role: 'MEMBER' } });
    // Server's 409 for an existing member is passed through by name.
    h.respond(() => Response.json({ name: 'board-member-exists', data: { message: 'x' } }, { status: 409 }));
    await h.fail('add_board_member', { boardId: 'b1', userId: 'u1' }, 'board-member-exists');
    // Missing from the roster, or holding another role, is not success.
    h.respond((r) => (r.method === 'POST' ? json({ data: user }) : json({ data: [] })));
    await h.fail('add_board_member', { boardId: 'b1', userId: 'u1' }, 'readback-failed');
    h.respond((r) => (r.method === 'POST' ? json({ data: user }) : json(roster)));
    await h.fail('add_board_member', { boardId: 'b1', userId: 'u1', role: 'member' }, 'readback-failed');
    // Python's "observer" is not a server role.
    h.respond(() => json({ data: [] }));
    assert.equal((await h.call('add_board_member', { boardId: 'b1', userId: 'u1', role: 'observer' })).isError, true);
    assert.equal(h.requests.length, 0);
    await writeErrors(h, 'add_board_member', { boardId: 'b1', userId: 'u1' }, 'POST');
  },
  set_board_member_role: async (h) => {
    h.respond((r) => (r.method === 'PATCH' ? json({ data: user }) : json({ data: [member('member')] })));
    assert.deepEqual(await h.ok('set_board_member_role', { boardId: 'b1', userId: 'u1', role: 'member' }),
      member('member'));
    assert.deepEqual(calls(h), [
      { method: 'PATCH', path: '/api/v1/boards/b1/members/u1', body: { role: 'MEMBER' } },
      { method: 'GET', path: '/api/v1/boards/b1/members', body: undefined },
    ]);
    // Last-admin guard (409) passes through; a role that did not change is not success.
    h.respond(() => Response.json({ name: 'last-board-admin', data: {} }, { status: 409 }));
    await h.fail('set_board_member_role', { boardId: 'b1', userId: 'u1', role: 'member' }, 'last-board-admin');
    h.respond((r) => (r.method === 'PATCH' ? json({ data: user }) : json({ data: [member('ADMIN')] })));
    await h.fail('set_board_member_role', { boardId: 'b1', userId: 'u1', role: 'member' }, 'readback-failed');
    h.respond(() => json({ data: [] }));
    assert.equal((await h.call('set_board_member_role', { boardId: 'b1', userId: 'u1' })).isError, true);
    assert.equal(h.requests.length, 0);
    await writeErrors(h, 'set_board_member_role', { boardId: 'b1', userId: 'u1', role: 'admin' }, 'PATCH');
  },
});
