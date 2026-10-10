import assert from 'node:assert/strict';
import { mock, spyOn } from 'bun:test';

// Each scenario runs in a fresh process: no shared module mocks, transports or timers.
const scenario = process.argv[2];
assert.ok(scenario);
const minute = 60_000;
const epoch = Date.parse('2026-10-10T10:00:00Z');
let now = epoch;
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(value?: string | number) {
    super(value ?? now);
  }

  static override now() {
    return now;
  }
}
globalThis.Date = FakeDate as DateConstructor;
let sweep: (() => void) | undefined;
Object.defineProperty(globalThis, 'setInterval', {
  value: (callback: unknown) => {
    assert.equal(typeof callback, 'function');
    sweep = callback as () => void;
    return 1;
  },
});

// Only persistence/auth/tool registration are fixtures. Session code, HTTP handler,
// Request/Response, McpServer and SDK transport execute their real implementations.
type SessionRow = { id: string; user_id: string; last_active_at: Date };
const rows = new Map<string, SessionRow>();
const touches: string[] = [];
let rejectTouch = false;
const unhandledRejections: unknown[] = [];
process.on('unhandledRejection', (error) => unhandledRejections.push(error));
function db(table: string) {
  assert.equal(table, 'mcp_sessions');
  let id: string | undefined;
  let cutoff: Date | undefined;
  const query = {
    where(key: { id: string } | string, operator?: string, value?: Date) {
      if (typeof key === 'object') id = key.id;
      else {
        assert.equal(key, 'last_active_at');
        assert.equal(operator, '<');
        cutoff = value;
      }
      return query;
    },
    insert(row: SessionRow) {
      rows.set(row.id, row);
      return Promise.resolve();
    },
    select() {
      return query;
    },
    first() {
      return Promise.resolve(id ? rows.get(id) : undefined);
    },
    async update(update: { last_active_at: Date }) {
      assert.ok(id);
      touches.push(id);
      if (rejectTouch) {
        await Promise.resolve();
        throw new Error('fixture DB touch rejected');
      }
      const row = rows.get(id);
      if (row) row.last_active_at = update.last_active_at;
    },
    del() {
      if (id) rows.delete(id);
      else if (cutoff) {
        for (const [key, row] of rows) {
          if (row.last_active_at < cutoff) rows.delete(key);
        }
      }
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
await mock.module('../registerTools', () => ({ registerMcpTools: () => {} }));

const { mcpHttpHandler } = await import('./index');
const { getSession } = await import('./sessions');
const headers = {
  Authorization: 'Bearer owner',
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};
async function initialize() {
  const initialized = await mcpHttpHandler(
    new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'liveness-regression', version: '1.0.0' },
        },
      }),
    })
  );
  assert.equal(initialized?.status, 200);
  await initialized.text();
  const id = initialized.headers.get('mcp-session-id');
  assert.ok(id);
  return id;
}
const sessionId = await initialize();
const session = await getSession(sessionId);
assert.ok(session?.transport);
const close = spyOn(session.transport, 'close');
// Drain initialization work before starting the timing assertions.
await new Promise<void>((resolve) => setImmediate(resolve));
touches.length = 0;

async function request(method = 'POST', token = 'owner', id = sessionId) {
  const response = await mcpHttpHandler(
    new Request('http://localhost/api/mcp', {
      method,
      headers: { ...headers, Authorization: `Bearer ${token}`, 'mcp-session-id': id },
      ...(method === 'POST'
        ? { body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) }
        : {}),
    })
  );
  assert.ok(response);
  return response;
}
async function ping(token = 'owner', id = sessionId) {
  const response = await request('POST', token, id);
  await response.text();
  return response;
}
async function evictAt(minutes: number) {
  now = epoch + minutes * minute;
  assert.ok(sweep);
  sweep();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

switch (scenario) {
  case 'active-owner': {
    now = epoch + 29 * minute;
    assert.equal((await ping()).status, 200);
    await evictAt(31);
    assert.equal(
      close.mock.calls.length,
      0,
      'owner traffic at minute 29 must keep transport alive at minute 31'
    );
    assert.equal((await ping()).status, 200);
    assert.ok(rows.has(sessionId), 'distributed metadata must also remain alive');
    await evictAt(61);
    assert.equal(close.mock.calls.length, 0, 'TTL is measured from the latest owner request');
    await evictAt(62);
    assert.equal(
      close.mock.calls.length,
      1,
      'formerly active sessions still expire after idle TTL'
    );
    assert.equal((await ping()).status, 404);
    break;
  }
  case 'rejected-db-touch': {
    rejectTouch = true;
    now = epoch + 29 * minute;
    assert.equal((await ping()).status, 200);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(touches, [sessionId], 'must exercise an actual rejected DB update');
    assert.equal(unhandledRejections.length, 0, 'best-effort DB touch must handle rejection');
    await evictAt(31);
    assert.equal(
      close.mock.calls.length,
      0,
      'DB failure must not lose authenticated local liveness'
    );
    assert.equal((await ping()).status, 200);
    break;
  }
  case 'intruder': {
    now = epoch + 29 * minute;
    for (const method of ['POST', 'GET', 'DELETE']) {
      assert.equal((await request(method, 'intruder')).status, 403);
    }
    assert.deepEqual(touches, [], 'authenticated non-owner must not extend distributed TTL');
    assert.equal(rows.get(sessionId)?.last_active_at.getTime(), epoch);
    await evictAt(31);
    assert.equal(close.mock.calls.length, 1, 'authenticated non-owner must not extend local TTL');
    assert.equal(rows.has(sessionId), false);
    assert.equal((await ping()).status, 404);
    break;
  }
  case 'idle': {
    await evictAt(30);
    assert.equal(close.mock.calls.length, 0, 'exact TTL boundary is not stale');
    assert.ok(rows.has(sessionId));
    await evictAt(31);
    assert.equal(close.mock.calls.length, 1);
    assert.equal(rows.has(sessionId), false);
    assert.equal((await ping()).status, 404);
    await evictAt(36);
    assert.equal(close.mock.calls.length, 1, 'stale transports close once');
    break;
  }
  case 'unauthenticated': {
    now = epoch + 29 * minute;
    assert.equal((await ping('expired')).status, 401);
    const response = await mcpHttpHandler(
      new Request('http://localhost/api/mcp', {
        headers: { 'mcp-session-id': sessionId },
      })
    );
    assert.equal(response?.status, 401);
    assert.deepEqual(touches, []);
    await evictAt(31);
    assert.equal(close.mock.calls.length, 1);
    assert.equal(rows.has(sessionId), false);
    break;
  }
  case 'unknown-session': {
    now = epoch + 29 * minute;
    assert.equal((await ping('owner', 'guessed-id')).status, 404);
    assert.deepEqual(touches, []);
    assert.equal(rows.has('guessed-id'), false);
    await evictAt(31);
    assert.equal(close.mock.calls.length, 1);
    break;
  }
  case 'read-only-lookup': {
    now = epoch + 29 * minute;
    assert.ok((await getSession(sessionId))?.transport);
    assert.deepEqual(touches, [], 'lookup before ownership verification must be read-only');
    await evictAt(31);
    assert.equal(close.mock.calls.length, 1);
    assert.equal(rows.has(sessionId), false);
    break;
  }
  case 'db-only-reinitialize': {
    // After restart/on another instance, metadata survives but sockets do not.
    const oldId = 'persisted-on-another-instance';
    rows.set(oldId, { id: oldId, user_id: 'owner', last_active_at: new Date(epoch) });
    now = epoch + 29 * minute;
    assert.equal((await ping('intruder', oldId)).status, 403);
    const response = await request('POST', 'owner', oldId);
    assert.equal(response.status, 404);
    assert.match(await response.text(), /Re-initialize/);
    assert.deepEqual(touches, [], 'metadata-only requests cannot keep a missing transport alive');
    const newId = await initialize();
    assert.notEqual(newId, oldId);
    assert.equal((await ping('owner', newId)).status, 200);
    await evictAt(31);
    assert.equal(rows.has(oldId), false);
    assert.ok(rows.has(newId));
    assert.equal((await ping('owner', newId)).status, 200);
    break;
  }
  case 'owner-get': {
    now = epoch + 29 * minute;
    const response = await request('GET');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Content-Type') ?? '', /text\/event-stream/);
    await evictAt(31);
    assert.equal(close.mock.calls.length, 0, 'authenticated GET refreshes local liveness');
    assert.ok(rows.has(sessionId));
    assert.deepEqual(touches, [sessionId]);
    await response.body?.cancel();
    break;
  }
  case 'owner-delete': {
    now = epoch + 29 * minute;
    assert.equal((await request('DELETE')).status, 204);
    assert.deepEqual(touches, [], 'deletion must not race a keepalive write');
    assert.equal(close.mock.calls.length, 1);
    assert.equal(rows.has(sessionId), false);
    assert.equal((await ping()).status, 404);
    await evictAt(31);
    assert.equal(close.mock.calls.length, 1);
    break;
  }
  default:
    throw new Error(`Unknown scenario: ${scenario}`);
}
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(unhandledRejections.length, 0, 'no asynchronous DB rejection may escape the request');
console.info(`PASS ${scenario}`);
