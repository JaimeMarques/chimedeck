import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mock } from 'bun:test';
import { AxiosError, AxiosHeaders } from 'axios';
import type { AppDispatch } from '~/store';
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
  constructor(readonly url: string) { super(); FakeWebSocket.current = this; }
  send(_frame: string) {}
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  message(type = 'board_event') { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type }) })); }
  closed(code = 1006, reason = '') {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason }));
  }
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
const { RetryableRecoveryError } = await import('../../../../common/api/recoveryErrors');

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
assert.equal(snapshots, 0, 'healthy tab return preserves progressive hydration');
await act(async () => {
  window.dispatchEvent(new dom.window.Event('online'));
  await Promise.resolve();
});
assert.equal(snapshots, 0, 'healthy online notification does not fetch a full board');
const originalNow = Date.now;
const wakeAt = Date.now() + 61_000;
Date.now = () => wakeAt;
await act(async () => {
  document.dispatchEvent(new dom.window.Event('visibilitychange'));
  await Promise.resolve();
});
assert.equal(snapshots, 0, 'wake while reconnecting does not race an offline full-board fetch');
await act(async () => { FakeWebSocket.current.open(); await Promise.resolve(); });
Date.now = originalNow;
assert.equal(snapshots, 1, 'stale socket recovery fetches exactly once on successful open');
hook.unmount();
document.dispatchEvent(new dom.window.Event('visibilitychange'));
window.dispatchEvent(new dom.window.Event('online'));
assert.equal(snapshots, 1, 'unmount removes recovery listeners');
socket.disconnect();
assert.equal(socket.isConnected, false);

let initialSnapshots = 0;
const initial = renderHook(() => useWebSocket({
  boardId: 'first', token: 'token', lastSequence: 0, onEvent: () => {},
  onReconnect: () => { initialSnapshots++; },
}));
await act(async () => { FakeWebSocket.current.open(); await Promise.resolve(); });
assert.equal(initialSnapshots, 0, 'first successful open keeps the paged foreground snapshot');
act(() => { FakeWebSocket.current.closed(); });
await act(async () => {
  window.dispatchEvent(new dom.window.Event('online'));
  await Promise.resolve();
});
assert.equal(initialSnapshots, 0, 'down connection waits for open instead of duplicate GETs');
await act(async () => { FakeWebSocket.current.open(); await Promise.resolve(); });
assert.equal(initialSnapshots, 1);
initial.unmount();

let renewedSnapshots = 0;
let finishSocketRenewal: ((token: string) => void) | undefined;
socket.setExpiredTokenCallback(() => new Promise((resolve) => { finishSocketRenewal = resolve; }));
const renewingHook = renderHook(({ token }) => useWebSocket({
  boardId: 'same-board', token, lastSequence: 0, onEvent: () => {},
  onReconnect: () => { renewedSnapshots++; },
}), { initialProps: { token: 'old-token' } });
await act(async () => { FakeWebSocket.current.open(); await Promise.resolve(); });
assert.equal(renewedSnapshots, 0);
FakeWebSocket.current.message('pong');
renewingHook.rerender({ token: 'healthy-refreshed-token' });
await act(async () => { FakeWebSocket.current.open(); await Promise.resolve(); });
assert.equal(renewedSnapshots, 1, 'healthy same-board HTTP token replacement still reconciles its connection gap');
FakeWebSocket.current.message('pong');
act(() => { FakeWebSocket.current.closed(4001, 'session expired'); });
renewingHook.rerender({ token: 'renewed-token' });
await act(async () => {
  finishSocketRenewal?.('renewed-token');
  await Promise.resolve();
});
await act(async () => { FakeWebSocket.current.open(); await Promise.resolve(); });
assert.equal(renewedSnapshots, 2, 'same-board token lifecycle preserves real recovery intent');
act(() => { FakeWebSocket.current.closed(); });
renewingHook.rerender({ token: 'http-renewed-token' });
await act(async () => { FakeWebSocket.current.open(); await Promise.resolve(); });
assert.equal(renewedSnapshots, 3, 'HTTP renewal during transport outage still reconciles once');
renewingHook.unmount();

let retainedPolls = 0;
const intervalCallbacks = new Map<ReturnType<typeof setInterval>, () => void>();
const savedSetInterval = globalThis.setInterval;
const savedClearInterval = globalThis.clearInterval;
globalThis.setInterval = ((callback: () => void, delay: number) => {
  const id = savedSetInterval(callback, delay);
  intervalCallbacks.set(id, callback);
  return id;
}) as unknown as typeof setInterval;
globalThis.clearInterval = ((id: ReturnType<typeof setInterval>) => {
  intervalCallbacks.delete(id);
  savedClearInterval(id);
}) as typeof clearInterval;
const retainedSnapshot = () => { retainedPolls++; return Promise.resolve(); };
const ignoreEvents = () => {};
const retainedPollingHook = renderHook(({ token }) => {
  const connection = useWebSocket({ boardId: 'polling-board', token, lastSequence: 0, onEvent: ignoreEvents });
  usePollingFallback({ boardId: 'polling-board', active: connection.pollingActive, lastSequence: 0, fetchSnapshot: retainedSnapshot, onEvents: ignoreEvents });
  return connection;
}, { initialProps: { token: 'before-refresh' } });
for (let index = 0; index < 3; index++) {
  await act(async () => {
    FakeWebSocket.current.closed();
    window.dispatchEvent(new dom.window.Event('online'));
    await Promise.resolve();
  });
}
assert.equal(retainedPollingHook.result.current.pollingActive, true);
assert.equal(retainedPolls, 1);
retainedPollingHook.rerender({ token: 'after-refresh' });
assert.equal(retainedPollingHook.result.current.pollingActive, true, 'same-board token rotation retains down-transport fallback');
assert.equal(retainedPolls, 1, 'token rotation does not restart immediate snapshot polling');
await act(async () => {
  for (const callback of [...intervalCallbacks.values()]) callback();
  await Promise.resolve();
});
assert.equal(retainedPolls, 2, 'existing fallback cadence continues while replacement WS is blocked');
await act(async () => { FakeWebSocket.current.open(); await Promise.resolve(); });
assert.equal(retainedPollingHook.result.current.pollingActive, false);
retainedPollingHook.unmount();
globalThis.setInterval = savedSetInterval;
globalThis.clearInterval = savedClearInterval;

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
assert.equal(newSnapshots, 0, 'new board initial open does not replay retired recovery');
act(() => { FakeWebSocket.current.closed(); });
await act(async () => {
  window.dispatchEvent(new dom.window.Event('online'));
  FakeWebSocket.current.open();
  await Promise.resolve();
});
assert.equal(newSnapshots, 1);
navigating.unmount();
globalThis.fetch = originalFetch;

let snapshotPolls = 0;
let eventPolls = 0;
const originalSetInterval = globalThis.setInterval;
const pollIntervals: number[] = [];
globalThis.setInterval = ((callback: () => void, delay: number) => {
  pollIntervals.push(delay);
  return originalSetInterval(callback, delay);
}) as unknown as typeof setInterval;
const fetchSnapshot = () => { snapshotPolls++; return Promise.resolve(); };
const onEvents = () => { eventPolls++; };
const polling = renderHook(({ active }) => { usePollingFallback({
  boardId: 'b1', active, lastSequence: 0, fetchSnapshot, onEvents,
}); }, { initialProps: { active: true } });
await act(async () => { await Promise.resolve(); });
assert.equal(snapshotPolls, 1);
assert.equal(eventPolls, 0, 'zero cursor must not replay event history in snapshot mode');
assert.deepEqual(pollIntervals, [30_000], 'snapshot fallback has a bounded thirty-second cadence');
polling.rerender({ active: true });
assert.equal(snapshotPolls, 1, 'rerender must not restart immediate polling');
polling.rerender({ active: false });
polling.unmount();
const eventsPolling = renderHook(() => { usePollingFallback({
  boardId: 'b1', active: true, lastSequence: 0, onEvents,
}); });
assert.deepEqual(pollIntervals, [30_000, 5_000], 'generic event polling retains five-second cadence');
eventsPolling.unmount();
globalThis.setInterval = originalSetInterval;

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
const { default: boardReducer, fetchBoardDataThunk, shouldRetryBoardSnapshot } =
  await import('../../../Board/slices/boardSlice');
let recoveryGets = 0;
const recoveryStore = configureStore({
  reducer: { board: boardReducer },
  middleware: (defaults) => defaults({ thunk: { extraArgument: { api: {
    get: () => {
      recoveryGets++;
      if (recoveryGets === 1) {
        const error = new AxiosError('Temporary outage');
        error.response = { status: 502, statusText: 'Bad Gateway', data: null, headers: {}, config: { headers: new AxiosHeaders() } };
        return Promise.reject(error);
      }
      return Promise.resolve({ data: { id: 'b1', title: 'Recovered' }, includes: { lists: [], cards: [] } });
    },
  } } } }),
});
const recoveryDispatch = recoveryStore.dispatch as unknown as AppDispatch;
const failedSnapshotHook = renderHook(() => useBoardSnapshot({
  boardId: 'b1',
  fetchSnapshot: () => recoveryDispatch(fetchBoardDataThunk({ boardId: 'b1', background: true })),
  shouldRetry: (result) => shouldRetryBoardSnapshot({
    result, appliedRequestId: recoveryStore.getState().board.appliedSnapshotRequestId,
  }),
}));
await act(async () => { await failedSnapshotHook.result.current(); });
assert.equal(recoveryGets, 1);
assert.notEqual(scheduledRetry, null, 'temporary recovery GET failure schedules bounded retry');
await act(async () => { scheduledRetry?.(); await Promise.resolve(); });
assert.equal(recoveryGets, 2);
assert.equal(recoveryStore.getState().board.board?.title, 'Recovered');
assert.equal(scheduledRetry, null, 'successful retried snapshot stops retrying');
failedSnapshotHook.unmount();
globalThis.setTimeout = originalSetTimeout;
globalThis.clearTimeout = originalClearTimeout;

const { apiClient, setTokenGetter, setCredentialsCallback, setAuthRecoveryCallbacks, renewAccessToken, cancelAuthRecovery, allowAuthRecovery, AuthRecoveryCancelledError } =
  await import('../../../../common/api/client');
const { authDuckReducer, setCredentials, clearAuth, refreshCredentials, logoutThunk } = await import('../../../Auth/duck/authDuck');
const authStore = configureStore({ reducer: { auth: authDuckReducer } });
const user = { id: 'u1', name: 'User', email: 'user@example.test' };
setTokenGetter(() => authStore.getState().auth.accessToken);
setCredentialsCallback((credentials) => {
  authStore.dispatch(authStore.getState().auth.user ? refreshCredentials(credentials) : setCredentials(credentials));
});
let refreshCalls = 0;
let completeRefresh: ((credentials: { data: { user: typeof user; accessToken: string } }) => void) | undefined;
apiClient.defaults.adapter = async (config) => {
  if (config.url === '/auth/refresh') {
    refreshCalls++;
    const data = await new Promise((resolve) => { completeRefresh = resolve; });
    return { config, data, status: 200, statusText: 'OK', headers: {} };
  }
  if (config.headers.Authorization !== 'Bearer fresh-token') {
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
assert.equal(authStore.getState().auth.accessToken, null, 'cookie-only recovery starts without a Redux access token');
completeRefresh?.({ data: { user, accessToken: 'fresh-token' } });
const [httpResponse, freshToken] = await Promise.all([httpRequest, socketRenewal]);
assert.deepEqual(httpResponse, { data: 'protected-response' });
assert.equal(freshToken, 'fresh-token');
assert.equal(authStore.getState().auth.accessToken, 'fresh-token');

const sameSessionRenewal = renewAccessToken();
for (let index = 0; index < 10; index++) await Promise.resolve();
assert.equal(authStore.getState().auth.status, 'authenticated', 'silent renewal cannot unmount protected routes');
completeRefresh?.({ data: { user, accessToken: 'fresh-token' } });
await sameSessionRenewal;

const lateRenewal = renewAccessToken();
for (let index = 0; index < 10; index++) await Promise.resolve();
authStore.dispatch(clearAuth());
cancelAuthRecovery();
completeRefresh?.({ data: { user, accessToken: 'resurrected-token' } });
await assert.rejects(lateRenewal, AuthRecoveryCancelledError);
assert.equal(authStore.getState().auth.accessToken, null, 'late refresh cannot resurrect logout');
const callsAtLogout = refreshCalls;
await assert.rejects(renewAccessToken(), AuthRecoveryCancelledError);
assert.equal(refreshCalls, callsAtLogout, 'explicit logout also prevents cookie-only reauthentication');
authStore.dispatch(setCredentials({ user, accessToken: 'new-login' }));
allowAuthRecovery();
const newSessionRenewal = renewAccessToken();
for (let index = 0; index < 10; index++) await Promise.resolve();
completeRefresh?.({ data: { user, accessToken: 'fresh-token' } });
assert.equal(await newSessionRenewal, 'fresh-token', 'a new validated login permits its own renewal');
let failTransientRefresh: ((error: unknown) => void) | undefined;
let transientRefreshCalls = 0;
apiClient.defaults.adapter = async (config) => {
  if (config.url === '/auth/refresh') {
    transientRefreshCalls++;
    await new Promise((_resolve, reject) => { failTransientRefresh = reject; });
    throw new Error('Expected deferred refresh failure');
  }
  throw new AxiosError('Expired token', '401', config, undefined, {
    config, status: 401, statusText: 'Unauthorized', headers: {},
    data: { error: { message: 'Invalid or expired access token' } },
  });
};
const temporaryRenewals = Promise.allSettled([apiClient.get('/transient'), renewAccessToken()]);
for (let index = 0; index < 10; index++) await Promise.resolve();
assert.equal(transientRefreshCalls, 1);
const unavailable = new AxiosError('Refresh unavailable');
unavailable.response = { status: 503, statusText: 'Unavailable', headers: {}, data: null, config: { headers: new AxiosHeaders() } };
failTransientRefresh?.(unavailable);
const temporaryResults = await temporaryRenewals;
for (const result of temporaryResults) {
  assert.equal(result.status, 'rejected');
  assert.ok(result.reason instanceof RetryableRecoveryError);
}
assert.equal(authStore.getState().auth.status, 'authenticated', 'shared transient refresh cannot log out the HTTP participant');
assert.equal(authStore.getState().auth.accessToken, 'fresh-token');
setAuthRecoveryCallbacks({
  onSuspend: () => { socket.suspendAuthRecovery(); },
  canResume: () => authStore.getState().auth.status === 'authenticated',
  onResume: () => { socket.resumeAuthRecovery(); },
});
socket.setExpiredTokenCallback(async () => {
  try { return await renewAccessToken(); }
  catch (error) {
    if (error instanceof AuthRecoveryCancelledError) return null;
    throw error;
  }
});
const authDispatch = authStore.dispatch as unknown as AppDispatch;
for (const cancelledBeforeFailure of [true, false]) {
  const originalToken = authStore.getState().auth.accessToken ?? '';
  const refreshResponses: Array<(data: { data: { user: typeof user; accessToken: string } }) => void> = [];
  let rejectLogout: ((error: unknown) => void) | undefined;
  let logoutDeletes = 0;
  apiClient.defaults.adapter = async (config) => {
    if (config.url === '/auth/refresh') {
      const data = await new Promise((resolve) => { refreshResponses.push(resolve); });
      return { config, data, status: 200, statusText: 'OK', headers: {} };
    }
    assert.equal(config.url, '/auth/session');
    logoutDeletes++;
    await new Promise((_resolve, reject) => { rejectLogout = reject; });
    throw new Error('Expected deferred logout failure');
  };
  socket.resetRenewalThrottle();
  socket.connect({ boardId: 'logout-board', token: originalToken });
  FakeWebSocket.current.open();
  FakeWebSocket.current.message('pong');
  FakeWebSocket.current.closed(4001, 'session expired');
  for (let index = 0; index < 20; index++) await Promise.resolve();
  assert.equal(refreshResponses.length, 1);
  const firstLogout = authDispatch(logoutThunk());
  const secondLogout = authDispatch(logoutThunk());
  for (let index = 0; index < 20; index++) await Promise.resolve();
  assert.equal(logoutDeletes, 1, 'same-session double logout shares its cancellation and DELETE');
  if (cancelledBeforeFailure) {
    refreshResponses[0]?.({ data: { user, accessToken: 'cancelled-token' } });
    for (let index = 0; index < 20; index++) await Promise.resolve();
  }
  const logoutFailure = new AxiosError('Logout unavailable');
  logoutFailure.response = { status: 500, statusText: 'Unavailable', data: null, headers: {}, config: { headers: new AxiosHeaders() } };
  rejectLogout?.(logoutFailure);
  const failedLogouts = await Promise.all([firstLogout, secondLogout]);
  for (const result of failedLogouts) assert.ok(logoutThunk.rejected.match(result));
  assert.equal(authStore.getState().auth.status, 'authenticated');
  assert.equal(authStore.getState().auth.accessToken, originalToken, 'failed logout cannot revive its pre-logout refresh');
  if (!cancelledBeforeFailure) refreshResponses[0]?.({ data: { user, accessToken: 'cancelled-token' } });
  for (let index = 0; index < 20; index++) await Promise.resolve();
  assert.equal(refreshResponses.length, 2, 'failed logout resumes fresh renewal regardless of old cancellation ordering');
  const restoredToken = `restored-${String(cancelledBeforeFailure)}`;
  refreshResponses[1]?.({ data: { user, accessToken: restoredToken } });
  for (let index = 0; index < 20; index++) await Promise.resolve();
  assert.equal(authStore.getState().auth.accessToken, restoredToken);
  assert.ok(FakeWebSocket.current.url.includes(`token=${restoredToken}`));
  FakeWebSocket.current.open();
  assert.equal(socket.isConnected, true);
  socket.disconnect({ boardId: 'logout-board' });
}

for (const outcome of ['network', 'success']) {
  authStore.dispatch(setCredentials({ user, accessToken: `terminal-${outcome}` }));
  allowAuthRecovery();
  let finishOldRefresh: ((data: unknown) => void) | undefined;
  let refreshRequests = 0;
  apiClient.defaults.adapter = async (config) => {
    if (config.url === '/auth/refresh') {
      refreshRequests++;
      const data = await new Promise((resolve) => { finishOldRefresh = resolve; });
      return { config, data, status: 200, statusText: 'OK', headers: {} };
    }
    if (outcome === 'network') throw new AxiosError('Network unavailable', 'ERR_NETWORK', config);
    return { config, data: null, status: 200, statusText: 'OK', headers: {} };
  };
  socket.resetRenewalThrottle();
  socket.connect({ boardId: 'terminal-logout', token: `terminal-${outcome}` });
  FakeWebSocket.current.open();
  FakeWebSocket.current.message('pong');
  FakeWebSocket.current.closed(4001, 'session expired');
  for (let index = 0; index < 20; index++) await Promise.resolve();
  const result = await authDispatch(logoutThunk());
  assert.ok(logoutThunk.fulfilled.match(result));
  assert.equal(authStore.getState().auth.status, 'unauthenticated');
  socket.disconnect({ boardId: 'terminal-logout' });
  finishOldRefresh?.({ data: { user, accessToken: 'cancelled-terminal-token' } });
  for (let index = 0; index < 20; index++) await Promise.resolve();
  assert.equal(refreshRequests, 1, 'completed local logout cannot resume cancelled renewal');
  assert.equal(socket.isConnected, false);
  assert.equal(authStore.getState().auth.accessToken, null);
  await assert.rejects(renewAccessToken(), AuthRecoveryCancelledError);
}
dom.window.close();
console.info('hook recovery and snapshot polling passed');
