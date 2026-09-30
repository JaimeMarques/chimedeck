import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mock } from 'bun:test';
import { AxiosError } from 'axios';
import { configureStore } from '@reduxjs/toolkit';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  navigator: dom.window.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
});

class FakeWebSocket extends EventTarget {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  static current: FakeWebSocket;
  readyState = 0;
  constructor(_url: string) { super(); FakeWebSocket.current = this; }
  send(_frame: string) {}
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  message() { this.dispatchEvent(new MessageEvent('message', { data: '{"type":"board_event"}' })); }
}
globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
// [why] Only IndexedDB persistence is replaced; socket, queue and hooks are real.
await mock.module('../../../../mods/offlineQueue', () => ({
  enqueueMutation: () => Promise.resolve(),
  acknowledgeMutation: () => Promise.resolve(),
}));
const { renderHook, act } = await import('@testing-library/react');
const { socket } = await import('../../client/socket');
const { useWebSocket } = await import('../../hooks/useWebSocket');
const { usePollingFallback } = await import('../../PollingFallback');
const { useBoardSnapshot } = await import('../../hooks/useBoardSnapshot');
const { messageQueue } = await import('../../client/messageQueue');

socket.connect({ token: 'token' });
FakeWebSocket.current.open();
let oldEvents = 0;
let currentEvents = 0;
let snapshots = 0;
const hook = renderHook(({ updated }) => useWebSocket({
  boardId: 'b1', token: 'token', lastSequence: 0,
  onEvent: () => { if (updated) currentEvents++; else oldEvents++; },
  onReconnect: () => { snapshots++; },
}), { initialProps: { updated: false } });
assert.equal(hook.result.current.connectionState, 'connected');
assert.equal(snapshots, 0, 'adopting singleton must not trigger mount fetch loops');
hook.rerender({ updated: true });
act(() => { FakeWebSocket.current.message(); });
assert.equal(oldEvents, 0);
assert.equal(currentEvents, 1);
await act(async () => {
  document.dispatchEvent(new dom.window.Event('visibilitychange'));
  await Promise.resolve();
});
assert.equal(snapshots, 1, 'returning to visible tab refreshes board');
await act(async () => {
  window.dispatchEvent(new dom.window.Event('online'));
  await Promise.resolve();
});
assert.equal(snapshots, 2, 'network recovery refreshes board');
hook.unmount();
document.dispatchEvent(new dom.window.Event('visibilitychange'));
window.dispatchEvent(new dom.window.Event('online'));
assert.equal(snapshots, 2, 'unmount removes recovery listeners');
socket.disconnect();
assert.equal(socket.isConnected, false);

let completeMutation: ((response: Response) => void) | undefined;
const originalFetch = globalThis.fetch;
globalThis.fetch = (() => new Promise<Response>((resolve) => { completeMutation = resolve; })) as unknown as typeof fetch;
messageQueue.hydrate([{ id: 'mutation', boardId: 'b1', method: 'PATCH', url: '/queued', enqueuedAt: 0 }]);
let oldSnapshots = 0;
let newSnapshots = 0;
const navigating = renderHook(({ boardId }) => useWebSocket({
  boardId, token: 'token', lastSequence: 0, onEvent: () => {},
  onReconnect: () => { if (boardId === 'b1') oldSnapshots++; else newSnapshots++; },
}), { initialProps: { boardId: 'b1' } });
act(() => { FakeWebSocket.current.open(); });
navigating.rerender({ boardId: 'b2' });
await act(async () => {
  completeMutation?.(new Response('{}'));
  await Promise.resolve();
});
assert.equal(oldSnapshots, 0, 'a delayed queued replay cannot refresh the previous board');
assert.equal(newSnapshots, 0, 'retired open handler cannot refresh the replacement board');
await act(async () => { FakeWebSocket.current.open(); await Promise.resolve(); });
assert.equal(newSnapshots, 1);
navigating.unmount();
globalThis.fetch = originalFetch;

let snapshotPolls = 0;
let eventPolls = 0;
const fetchSnapshot = () => { snapshotPolls++; return Promise.resolve(); };
const onEvents = () => { eventPolls++; };
const polling = renderHook(({ active }) => { usePollingFallback({
  boardId: 'b1', active, lastSequence: 0, fetchSnapshot, onEvents,
}); }, { initialProps: { active: true } });
await act(async () => { await Promise.resolve(); });
assert.equal(snapshotPolls, 1);
assert.equal(eventPolls, 0, 'zero cursor must not replay event history in snapshot mode');
polling.rerender({ active: true });
assert.equal(snapshotPolls, 1, 'rerender must not restart immediate polling');
polling.rerender({ active: false });
polling.unmount();

let requests = 0;
let aborts = 0;
const completions: Array<(value: unknown) => void> = [];
const snapshotHook = renderHook(({ boardId }) => useBoardSnapshot({
  boardId,
  fetchSnapshot: () => {
    requests++;
    return Object.assign(new Promise<unknown>((resolve) => { completions.push(resolve); }), {
      abort: () => { aborts++; },
    });
  },
}), { initialProps: { boardId: 'b1' } });
let refresh: Promise<void>;
await act(async () => {
  refresh = snapshotHook.result.current();
  await snapshotHook.result.current();
  await snapshotHook.result.current();
});
assert.equal(requests, 1, 'poll and recovery share one in-flight snapshot');
await act(async () => {
  completions[0]?.({ type: 'board/fetchData/rejected' });
  await Promise.resolve();
});
assert.equal(requests, 2, 'failed in-flight poll cannot swallow reconnect recovery');
await act(async () => {
  completions[1]?.({ type: 'board/fetchData/fulfilled' });
  await refresh;
});
assert.equal(requests, 2, 'overlapping recovery triggers coalesce to one trailing fetch');
await act(async () => {
  refresh = snapshotHook.result.current();
  await snapshotHook.result.current();
});
snapshotHook.rerender({ boardId: 'b2' });
assert.equal(aborts, 1);
await act(async () => {
  completions[2]?.({ type: 'board/fetchData/rejected' });
  await refresh;
});
assert.equal(requests, 3, 'navigation cancels old-board trailing refresh');
snapshotHook.unmount();

let staleRetries = 0;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
let scheduledRetry: (() => void) | null = null;
globalThis.setTimeout = ((callback: () => void, delay: number) => {
  assert.equal(delay, 5_000);
  scheduledRetry = callback;
  return 1;
}) as unknown as typeof setTimeout;
globalThis.clearTimeout = (() => { scheduledRetry = null; }) as typeof clearTimeout;
const retryHook = renderHook(() => useBoardSnapshot({
  boardId: 'b1',
  fetchSnapshot: () => {
    staleRetries++;
    return Object.assign(Promise.resolve({ payload: staleRetries < 3 ? 'snapshot-stale' : null }), { abort: () => {} });
  },
  shouldRetry: (result) => (result as { payload: string | null }).payload === 'snapshot-stale',
}));
await act(async () => { await retryHook.result.current(); });
assert.equal(staleRetries, 1);
await act(async () => { scheduledRetry?.(); await Promise.resolve(); });
assert.equal(staleRetries, 2, 'stale snapshot schedules a delayed trailing retry');
await act(async () => { scheduledRetry?.(); await Promise.resolve(); });
assert.equal(staleRetries, 3, 'repeated live collisions eventually recover after traffic settles');
assert.equal(scheduledRetry, null, 'accepted snapshot stops retrying');
retryHook.unmount();
globalThis.setTimeout = originalSetTimeout;
globalThis.clearTimeout = originalClearTimeout;

const { apiClient, setTokenGetter, setCredentialsCallback, renewAccessToken, cancelAuthRecovery, AuthRecoveryCancelledError } =
  await import('../../../../common/api/client');
const { authDuckReducer, setCredentials, clearAuth } = await import('../../../Auth/duck/authDuck');
const authStore = configureStore({ reducer: { auth: authDuckReducer } });
const user = { id: 'u1', name: 'User', email: 'user@example.test' };
authStore.dispatch(setCredentials({ user, accessToken: 'old-token' }));
setTokenGetter(() => authStore.getState().auth.accessToken);
setCredentialsCallback((credentials) => { authStore.dispatch(setCredentials(credentials)); });
let refreshCalls = 0;
let completeRefresh: ((credentials: { data: { user: typeof user; accessToken: string } }) => void) | undefined;
apiClient.defaults.adapter = async (config) => {
  if (config.url === '/auth/refresh') {
    refreshCalls++;
    const data = await new Promise((resolve) => { completeRefresh = resolve; });
    return { config, data, status: 200, statusText: 'OK', headers: {} };
  }
  if (config.headers.Authorization === 'Bearer old-token') {
    throw new AxiosError('Expired token', '401', config, undefined, {
      config, status: 401, statusText: 'Unauthorized', headers: {},
      data: { error: { message: 'Invalid or expired access token' } },
    });
  }
  assert.equal(config.headers.Authorization, 'Bearer fresh-token');
  return { config, data: { data: 'protected-response' }, status: 200, statusText: 'OK', headers: {} };
};
const httpRequest = apiClient.get('/protected');
const socketRenewal = renewAccessToken();
for (let index = 0; index < 10; index++) await Promise.resolve();
assert.equal(refreshCalls, 1, 'HTTP and socket renewal share one refresh-cookie rotation');
assert.equal(authStore.getState().auth.status, 'authenticated', 'silent renewal cannot unmount protected routes');
completeRefresh?.({ data: { user, accessToken: 'fresh-token' } });
const [httpResponse, freshToken] = await Promise.all([httpRequest, socketRenewal]);
assert.deepEqual(httpResponse, { data: 'protected-response' });
assert.equal(freshToken, 'fresh-token');
assert.equal(authStore.getState().auth.accessToken, 'fresh-token');

const lateRenewal = renewAccessToken();
for (let index = 0; index < 10; index++) await Promise.resolve();
authStore.dispatch(clearAuth());
cancelAuthRecovery();
completeRefresh?.({ data: { user, accessToken: 'resurrected-token' } });
await assert.rejects(lateRenewal, AuthRecoveryCancelledError);
assert.equal(authStore.getState().auth.accessToken, null, 'late refresh cannot resurrect logout');
dom.window.close();
console.info('hook recovery and snapshot polling passed');
