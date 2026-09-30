import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { RealtimeSocket } from '../client/socket';

class FakeWebSocket extends EventTarget {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }
  send(frame: string) { this.sent.push(frame); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  message(frame: object) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }));
  }
  closed(code = 1006, reason = '') {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason }));
  }
}

const original = {
  WebSocket: globalThis.WebSocket,
  now: Date.now,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
};
let now = 0;
let nextId = 0;
const timers = new Map<number, { fn: () => void; interval: boolean }>();
let client: RealtimeSocket;
function tick(ms: number) {
  now += ms;
  for (const [id, timer] of [...timers]) {
    if (!timers.has(id)) continue;
    if (!timer.interval) timers.delete(id);
    timer.fn();
  }
}
function latest() {
  const ws = FakeWebSocket.instances.at(-1);
  if (!ws) throw new Error('Expected a socket');
  return ws;
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  now = 0;
  timers.clear();
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  Date.now = () => now;
  globalThis.setTimeout = ((fn: () => void) => {
    const id = ++nextId;
    timers.set(id, { fn, interval: false });
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.setInterval = ((fn: () => void) => {
    const id = ++nextId;
    timers.set(id, { fn, interval: true });
    return id;
  }) as unknown as typeof setInterval;
  globalThis.clearTimeout = globalThis.clearInterval = ((id: number) => {
    timers.delete(id);
  }) as unknown as typeof clearTimeout;
  client = new RealtimeSocket();
  client.connect({ boardId: 'b1', token: 'token' });
});
afterEach(() => {
  client.disconnect({ boardId: 'b1' });
  globalThis.WebSocket = original.WebSocket;
  Date.now = original.now;
  globalThis.setTimeout = original.setTimeout;
  globalThis.clearTimeout = original.clearTimeout;
  globalThis.setInterval = original.setInterval;
  globalThis.clearInterval = original.clearInterval;
});

describe('production socket recovery', () => {
  test('answers server heartbeats across idle intervals without forwarding control frames', () => {
    const events: string[] = [];
    client.subscribe({ onEvent: (event) => { events.push(event.type); } });
    latest().open();
    const ws = latest();
    for (let i = 0; i < 5; i++) {
      now += 30_000;
      ws.message({ type: 'ping' });
      ws.message({ type: 'pong' });
      tick(0);
    }
    expect(ws.sent.filter((frame) => frame === '{"type":"ping"}')).toHaveLength(5);
    expect(events).toEqual([]);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  test('stuck connecting attempts activate polling and retired events cannot corrupt replacement', () => {
    let polling = 0;
    client.subscribe({ onPollingActive: () => { polling++; } });
    const retired = latest();
    tick(61_000);
    retired.closed();
    retired.open();
    expect(client.isConnected).toBe(false);
    tick(61_000);
    tick(61_000);
    expect(client.usingPollingFallback).toBe(true);
    expect(polling).toBe(1);
    latest().open();
    expect(client.isConnected).toBe(true);
    expect(client.usingPollingFallback).toBe(false);
  });

  test('missing heartbeat recovers on resume and deliberate disconnect removes every timer', () => {
    latest().open();
    now = 61_000;
    client.recover();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(latest().readyState).toBe(FakeWebSocket.CONNECTING);
    client.disconnect({ boardId: 'b1' });
    expect(timers.size).toBe(0);
    client.recover();
    tick(61_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  test('forced logout cannot reconnect through recovery', () => {
    latest().open();
    let logouts = 0;
    client.setForcedLogoutCallback(() => { logouts++; });
    latest().closed(4001);
    client.recover();
    tick(61_000);
    expect(logouts).toBe(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(timers.size).toBe(0);
  });

  test('expired socket silently renews and authenticates replacement with fresh token', async () => {
    latest().open();
    let renewals = 0;
    let logouts = 0;
    client.setExpiredTokenCallback(() => { renewals++; return Promise.resolve('fresh-token'); });
    client.setForcedLogoutCallback(() => { logouts++; });
    latest().closed(4001, 'session expired');
    await Promise.resolve();
    expect(renewals).toBe(1);
    expect(logouts).toBe(0);
    expect(latest().url).toContain('token=fresh-token');
    latest().open();
    expect(client.isConnected).toBe(true);
  });

  test('genuine revocation and failed renewal retain terminal logout', async () => {
    latest().open();
    let renewals = 0;
    let logouts = 0;
    client.setExpiredTokenCallback(() => { renewals++; return Promise.reject(new Error('revoked')); });
    client.setForcedLogoutCallback(() => { logouts++; });
    latest().closed(4001, 'session revoked');
    expect(renewals).toBe(0);
    expect(logouts).toBe(1);
    client.connect({ token: 'token' });
    latest().open();
    latest().closed(4001, 'session expired');
    await Promise.resolve();
    expect(renewals).toBe(1);
    expect(logouts).toBe(2);
    client.disconnect();
  });

  test('logout while renewal is pending cannot reopen a socket', async () => {
    latest().open();
    let complete: ((token: string) => void) | undefined;
    client.setExpiredTokenCallback(() => new Promise((resolve) => { complete = resolve; }));
    latest().closed(4001, 'session expired');
    client.disconnect({ boardId: 'b1' });
    complete?.('fresh-token');
    await Promise.resolve();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(timers.size).toBe(0);
  });
});
