import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

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
const { renderHook, act } = await import('@testing-library/react');
const { socket } = await import('../../client/socket');
const { useWebSocket } = await import('../../hooks/useWebSocket');
const { usePollingFallback } = await import('../../PollingFallback');

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
dom.window.close();
console.info('hook recovery and snapshot polling passed');
