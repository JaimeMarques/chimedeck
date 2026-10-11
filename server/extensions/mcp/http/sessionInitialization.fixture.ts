import assert from 'node:assert/strict';
import { mock, spyOn } from 'bun:test';

// Fresh process per scenario isolates persistence fixtures from other MCP suites.
// The exported HTTP handler, session cache, McpServer and SDK transport are real.
const scenario = process.argv[2];
assert.ok(scenario);
Object.defineProperty(globalThis, 'setInterval', { value: () => 1 });
type SessionRow = { id: string; user_id: string; last_active_at: Date };
const rows = new Map<string, SessionRow>();
let inserts = 0;
let registrations = 0;
let finishInsert: (() => void) | undefined;
let rejectInsert: ((error: Error) => void) | undefined;
const unhandledRejections: unknown[] = [];
process.on('unhandledRejection', (error) => unhandledRejections.push(error));
function db(table: string) {
  assert.equal(table, 'mcp_sessions');
  let id: string | undefined;
  const query = {
    where(key: { id: string }) {
      id = key.id;
      return query;
    },
    insert(row: SessionRow) {
      inserts++;
      return new Promise<void>((resolve, reject) => {
        finishInsert = () => {
          rows.set(row.id, row);
          resolve();
        };
        rejectInsert = reject;
      });
    },
    select() {
      return query;
    },
    first() {
      return Promise.resolve(id ? rows.get(id) : undefined);
    },
    update(update: { last_active_at: Date }) {
      assert.ok(id);
      const row = rows.get(id);
      if (row) row.last_active_at = update.last_active_at;
      return Promise.resolve();
    },
    del() {
      assert.ok(id);
      rows.delete(id);
      return Promise.resolve();
    },
  };
  return query;
}
db.fn = { now: () => new Date() };
await mock.module('../../../common/db', () => ({ db }));
await mock.module('../../auth/middlewares/authentication', () => ({
  authenticate: (req: Request) => {
    const token = req.headers.get('Authorization');
    if (token !== 'Bearer owner' && token !== 'Bearer intruder') {
      return Promise.resolve(Response.json({ name: 'unauthorized' }, { status: 401 }));
    }
    Object.assign(req, { currentUser: { id: token.slice(7) } });
    return Promise.resolve(null);
  },
  parseBearerToken: (header: string | null) => header?.slice(7) ?? null,
}));
await mock.module('../registerTools', () => ({
  registerMcpTools: () => {
    registrations++;
  },
}));
const { mcpHttpHandler } = await import('./index');
const { getSession } = await import('./sessions');
const headers = {
  Authorization: 'Bearer owner',
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};
const initializeBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'initialization-regression', version: '1.0.0' },
  },
});
for (const authorization of ['', 'Bearer expired']) {
  const denied = await mcpHttpHandler(
    new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers: { ...headers, Authorization: authorization },
      body: initializeBody,
    })
  );
  assert.equal(denied?.status, 401);
  assert.equal(denied.headers.get('mcp-session-id'), null);
  await denied.text();
}
assert.equal(inserts, 0, 'unauthenticated initialization must not persist a session');
assert.equal(registrations, 0, 'unauthenticated initialization must not create an MCP server');
async function initialize() {
  const initialized = await mcpHttpHandler(
    new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers,
      body: initializeBody,
    })
  );
  assert.equal(initialized?.status, 200);
  const id = initialized.headers.get('mcp-session-id');
  assert.ok(id);
  // Consume the actual SDK initialize result before following up with this ID.
  assert.match(await initialized.text(), /protocolVersion/);
  return id;
}
const sessionId = await initialize();
assert.ok(finishInsert, 'the fixture must exercise an actual pending insertion');
assert.equal(rows.has(sessionId), false, 'insertion is still pending');
async function request(method: string, token = 'owner') {
  const response = await mcpHttpHandler(
    new Request('http://localhost/api/mcp', {
      method,
      headers: { ...headers, Authorization: `Bearer ${token}`, 'mcp-session-id': sessionId },
      ...(method === 'POST'
        ? { body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) }
        : {}),
    })
  );
  assert.ok(response);
  return response;
}
async function verifyOwnerTransport() {
  const ping = await request('POST');
  assert.equal(
    ping.status,
    200,
    'initialize must publish a usable local session before DB insertion'
  );
  assert.match(await ping.text(), /"result":\{\}/);
  const stream = await request('GET');
  assert.equal(stream.status, 200, 'owner GET must resolve the local SDK transport');
  assert.match(stream.headers.get('Content-Type') ?? '', /text\/event-stream/);
  await stream.body?.cancel();
  assert.ok((await getSession(sessionId))?.transport);
  for (const method of ['POST', 'GET', 'DELETE']) {
    const forbidden = await request(method, 'intruder');
    assert.equal(forbidden.status, 403, 'local publication must preserve ownership');
    await forbidden.text();
  }
  const intruderInitialize = await mcpHttpHandler(
    new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers: { ...headers, Authorization: 'Bearer intruder', 'mcp-session-id': sessionId },
      body: initializeBody,
    })
  );
  assert.equal(intruderInitialize?.status, 403, 'intruder cannot re-initialize an owner session');
  await intruderInitialize.text();
  assert.equal(inserts, 1, 'denied requests must not create additional session metadata');
  assert.equal(registrations, 1, 'denied requests must not initialize another MCP server');
}
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));
switch (scenario) {
  case 'delayed-insert': {
    await verifyOwnerTransport();
    finishInsert();
    await drain();
    assert.ok(rows.has(sessionId), 'live session metadata should persist when insertion completes');
    await verifyOwnerTransport();
    break;
  }
  case 'rejected-insert': {
    assert.ok(rejectInsert);
    rejectInsert(new Error('fixture DB insertion rejected'));
    await drain();
    assert.equal(rows.has(sessionId), false);
    await verifyOwnerTransport();
    break;
  }
  case 'delete-before-insert':
  case 'delete-before-rejection': {
    await verifyOwnerTransport();
    const session = await getSession(sessionId);
    assert.ok(session?.transport);
    const close = spyOn(session.transport, 'close');
    assert.equal((await request('DELETE')).status, 204);
    assert.equal(close.mock.calls.length, 1, 'delete must close the local transport once');
    assert.equal((await request('POST')).status, 404, 'delete removes local access immediately');
    assert.equal(rows.has(sessionId), false);
    if (scenario === 'delete-before-insert') finishInsert();
    else {
      assert.ok(rejectInsert);
      rejectInsert(new Error('fixture DB insertion rejected after deletion'));
    }
    await drain();
    assert.equal(
      rows.has(sessionId),
      false,
      'late insertion must not resurrect deleted DB metadata'
    );
    assert.equal(
      await getSession(sessionId),
      null,
      'late persistence must not republish the local transport'
    );
    assert.equal((await request('POST')).status, 404);
    assert.equal(close.mock.calls.length, 1);
    break;
  }
  default:
    throw new Error(`Unknown scenario: ${scenario}`);
}
await drain();
assert.deepEqual(
  unhandledRejections,
  [],
  'best-effort insertion must not leak unhandled rejection'
);
if (!scenario.startsWith('delete-before-')) {
  assert.equal((await request('DELETE')).status, 204);
}
assert.equal(await getSession(sessionId), null);
console.info(`PASS ${scenario}`);
