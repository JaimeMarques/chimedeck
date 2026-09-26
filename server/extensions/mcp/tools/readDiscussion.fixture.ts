import { strict as assert } from 'node:assert';
import { mock } from 'bun:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const scenario = Bun.argv[2] ?? 'threaded';
const parentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const replyId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const cardId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const token = 'session-token-never-echo';
const requests: Array<{ path: string; authorization: string | null }> = [];
const row = (id: string, parent: string | null = null, count = 0) => ({
  id, card_id: cardId, parent_id: parent, content: `body ${id}`, deleted: false,
  created_at: '2026-01-01T00:00:00.000Z', author_name: 'Example author', reactions: [{ emoji: '👍' }],
  ...(parent === null ? { reply_count: count } : {}),
});
const parent = row(parentId, null, scenario === 'empty' || scenario === 'unthreaded' ? 0 : scenario === 'ordering' ? 3 : 1);
const other = { ...row(otherId, null, scenario === 'partial' ? 1 : 0), deleted: true, content: '[deleted]' };
const reply = row(replyId, parentId);
const orderedReplies = [reply,
  { ...row('ffffffff-ffff-4fff-8fff-ffffffffffff', parentId), created_at: '2026-01-02T00:00:00.000Z' },
  { ...row('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', parentId), created_at: '2026-01-02T00:00:00.000Z' },
];
const response = (data: unknown) => Response.json(data);
const rest = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(request) {
    const url = new URL(request.url);
    assert.equal(request.method, 'GET');
    assert.equal(url.search, '');
    requests.push({ path: url.pathname, authorization: request.headers.get('authorization') });
    if (scenario === 'denied') return responseError(403);
    if (url.pathname.endsWith('/comments')) {
      if (scenario === 'html') return new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } });
      if (scenario === 'null') return response(null);
      if (scenario === 'malformed') return response({ data: [{ ...parent, reply_count: true }] });
      if (scenario === 'missing-count') {
        const missing: Record<string, unknown> = { ...parent };
        delete missing.reply_count;
        return response({ data: [missing] });
      }
      if (scenario === 'empty') return response({ data: [] });
      if (scenario === 'unthreaded') return response({ data: [parent, other] });
      if (scenario === 'root-pagination') return response({ data: [parent], metadata: { hasMore: true, cursor: 'unknown' } });
      return response({ data: [parent, other] });
    }
    if (scenario === 'partial' && url.pathname === `/api/v1/comments/${otherId}/replies`) {
      return response({ data: [row('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', otherId)] });
    }
    assert.equal(url.pathname, `/api/v1/comments/${parentId}/replies`);
    if (scenario === 'missing' || scenario === 'partial') return responseError(scenario === 'missing' ? 404 : 429);
    if (scenario === 'ordering') return response({ data: orderedReplies });
    if (scenario === 'count-less') return response({ data: [] });
    if (scenario === 'count-more') return response({ data: [reply, { ...reply, id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }] });
    if (scenario === 'wrong-parent') return response({ data: [{ ...reply, parent_id: otherId }] });
    if (scenario === 'wrong-card') return response({ data: [{ ...reply, card_id: 'another-card' }] });
    if (scenario === 'duplicate') return response({ data: [reply, reply] });
    if (scenario === 'root-duplicate') return response({ data: [{ ...reply, id: otherId }] });
    if (scenario === 'nested') return response({ data: [{ ...reply, reply_count: 1 }] });
    if (scenario === 'deleted') return response({ data: [{ ...reply, deleted: true }] });
    if (scenario === 'reply-pagination') return response({ data: [reply], metadata: { next: 'https://untrusted.invalid' } });
    if (scenario === 'redaction') return response({ data: [{ ...reply, content: token }] });
    return response({ data: [reply] });
  },
});
function responseError(status: number) {
  return Response.json({ error: { message: token } }, { status });
}
void mock.module('../config', () => ({ config: { apiUrl: rest.url.origin, token: 'wrong-environment-token' } }));
const { registerMcpTools } = await import('../registerTools');
const server = new McpServer({ name: 'discussion-test', version: '1' });
registerMcpTools(server, token);
const client = new Client({ name: 'discussion-client', version: '1' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);
try {
  const tools = (await client.listTools()).tools;
  for (const name of ['get_card_discussion', 'get_comment_replies']) {
    const tool = tools.find((entry) => entry.name === name);
    assert.ok(tool, `${name} not registered`);
    assert.equal(tool.annotations?.readOnlyHint, true);
  }
  assert.ok(tools.some((tool) => tool.name === 'get_card'));
  assert.ok(tools.some((tool) => tool.name === 'write_comment'));
  if (scenario === 'network') await rest.stop(true);
  const direct = scenario === 'direct' || scenario === 'missing';
  const result = await client.callTool({
    name: direct || scenario === 'validation' ? 'get_comment_replies' : 'get_card_discussion',
    arguments: scenario === 'validation' ? { commentId: 'not-a-uuid' }
      : direct ? { commentId: parentId.toUpperCase() }
        : { cardId: scenario === 'encoded-id' ? 'card?limit=1#fragment' : 'short123' },
  });
  const raw = result.content;
  assert.ok(Array.isArray(raw));
  const first = raw[0] as { type: string; text: string };
  assert.equal(first.type, 'text');
  assert.ok(!first.text.includes(token));
  if (['denied', 'html', 'null', 'malformed', 'missing-count', 'missing', 'network', 'validation'].includes(scenario)) {
    assert.equal(result.isError, true);
    const code = { denied: 'http-403', html: 'bad-response', null: 'bad-response', malformed: 'bad-response',
      'missing-count': 'bad-response', missing: 'http-404', network: 'network' }[scenario];
    if (code) assert.equal(first.text, `Error: ${code}`);
    if (scenario === 'validation') assert.equal(requests.length, 0);
  } else {
    assert.notEqual(result.isError, true);
    const payload = JSON.parse(first.text) as {
      data: Array<ReturnType<typeof row>>;
      complete: boolean;
      issues: Array<{ code: string; parent_id: string | null; expected_reply_count?: number; actual_reply_count?: number }>;
    };
    if (scenario === 'empty') {
      assert.deepEqual(payload, { data: [], complete: true, issues: [] });
      assert.equal(requests.length, 1);
    } else if (scenario === 'unthreaded') {
      assert.deepEqual(payload, { data: [parent, other], complete: true, issues: [] });
      assert.equal(requests.length, 1);
    } else if (scenario === 'direct') {
      assert.deepEqual(payload, { data: [reply], complete: true, issues: [] });
      assert.equal(requests.length, 1);
    } else if (scenario === 'ordering') {
      assert.deepEqual(payload, { data: [parent, ...orderedReplies, other], complete: true, issues: [] });
      assert.equal(requests.length, 2);
    } else if (['threaded', 'encoded-id'].includes(scenario)) {
      // Equal timestamps keep server order; replies stay with their parent,
      // not interleaved with another top-level comment.
      assert.deepEqual(payload, { data: [parent, reply, other], complete: true, issues: [] });
      assert.equal(requests.length, 2);
      if (scenario === 'encoded-id') assert.equal(requests[0]?.path, '/api/v1/cards/card%3Flimit%3D1%23fragment/comments');
    } else if (scenario === 'redaction') {
      assert.equal(payload.complete, true);
      assert.equal(payload.data[1]?.content, '<redacted>');
    } else {
      assert.equal(payload.complete, false);
      const code = scenario.endsWith('pagination') ? 'unrecognized-envelope'
        : scenario.startsWith('count-') ? 'reply-count-mismatch'
          : scenario === 'partial' ? 'http-429'
            : scenario === 'nested' || scenario === 'deleted' ? 'unexpected-reply' : 'bad-response';
      assert.equal(payload.issues[0]?.code, code);
      assert.equal(payload.issues[0].parent_id, scenario === 'root-pagination' ? null : parentId);
      assert.ok(payload.data.some((entry) => entry.id === parentId));
      if (scenario !== 'root-pagination') assert.ok(payload.data.some((entry) => entry.id === otherId));
      assert.equal(requests.length, scenario === 'partial' ? 3 : 2);
      if (scenario === 'partial') assert.equal(payload.data.at(-1)?.parent_id, otherId);
    }
  }
  assert.ok(requests.every((request) => request.authorization === `Bearer ${token}`));
  console.info(`PASS ${scenario}: registered MCP tools, GET-only transport and caller token verified`);
} finally {
  await client.close();
  await server.close();
  await rest.stop(true);
}
