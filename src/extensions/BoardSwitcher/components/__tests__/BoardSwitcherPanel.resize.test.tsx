import { afterEach, describe, expect, it } from 'bun:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://chimedeck.test/b/b1' });
const win = dom.window as unknown as Record<string, unknown>;
win.matchMedia = () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} });
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (!(key in globalThis)) Object.defineProperty(globalThis, key, { value: win[key], writable: true, configurable: true });
}
for (const key of ['window', 'document', 'navigator', 'location'] as const) {
  Object.defineProperty(globalThis, key, { value: key === 'window' ? dom.window : win[key], writable: true, configurable: true });
}
class TestPointerEvent extends dom.window.MouseEvent {
  pointerId: number;
  constructor(type: string, init: MouseEventInit & { pointerId?: number }) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}
Object.assign(dom.window, { PointerEvent: TestPointerEvent });

const { configureStore } = await import('@reduxjs/toolkit');
const { Provider } = await import('react-redux');
const { MemoryRouter } = await import('react-router-dom');
const { act, cleanup, fireEvent, render } = await import('@testing-library/react');
const { default: boardSwitcher, setSwitcherPrefs } = await import('../../boardSwitcher.slice');
const { default: BoardSwitcherPanel } = await import('../BoardSwitcherPanel');

function mount() {
  const store = configureStore({
    reducer: {
      boardSwitcher,
      workspaceShell: () => ({ workspaces: [], activeWorkspaceId: null }),
      board: () => ({ board: null }),
    },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware({ thunk: { extraArgument: {
      api: { get: () => Promise.resolve({ data: [] }) },
    } } }),
  });
  store.dispatch(setSwitcherPrefs({ panelWidth: 300 }));
  const ui = render(<Provider store={store}><MemoryRouter><div><div data-testid="desktop-sidebar" /><BoardSwitcherPanel /></div></MemoryRouter></Provider>);
  const separator = ui.getByRole('separator', { name: 'Resize board switcher' });
  let captured: number | null = null;
  Object.assign(separator, {
    setPointerCapture: (id: number) => { captured = id; },
    hasPointerCapture: (id: number) => captured === id,
    releasePointerCapture: () => { captured = null; },
  });
  return { store, ui, separator, captured: () => captured };
}

afterEach(() => { cleanup(); });

describe('BoardSwitcherPanel resizing', () => {
  it('tracks sibling sidebar width during expansion and restores the preferred width on collapse', async () => {
    const originalObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
    let notify = () => {};
    const observed: { current: Element | null } = { current: null };
    let disconnected = false;
    class TestResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) { notify = () => { callback([], this); }; }
      observe(target: Element) { observed.current = target; }
      unobserve() {}
      disconnect() { disconnected = true; }
    }
    Object.defineProperty(globalThis, 'ResizeObserver', { value: TestResizeObserver, configurable: true });
    try {
      window.innerWidth = 768;
      const { separator, store, ui } = mount();
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
      expect(observed.current).toBe(ui.getByTestId('desktop-sidebar'));
      const panel = separator.closest('aside');
      if (!panel) throw new Error('Missing switcher panel');
      let left = 64;
      Object.assign(panel, { getBoundingClientRect: () => ({ left }) });
      act(() => { store.dispatch(setSwitcherPrefs({ panelWidth: 480 })); notify(); });
      expect(separator.getAttribute('aria-valuenow')).toBe('384');
      act(() => { left = 160; notify(); });
      expect(separator.getAttribute('aria-valuenow')).toBe('288');
      act(() => { left = 256; notify(); });
      expect(separator.getAttribute('aria-valuenow')).toBe('192');
      expect(store.getState().boardSwitcher.prefs.panelWidth).toBe(480);
      act(() => { left = 64; notify(); });
      expect(separator.getAttribute('aria-valuenow')).toBe('384');
      expect(store.getState().boardSwitcher.prefs.panelWidth).toBe(480);
      ui.unmount();
      expect(disconnected).toBe(true);
    } finally {
      if (originalObserver) Object.defineProperty(globalThis, 'ResizeObserver', originalObserver);
      else Reflect.deleteProperty(globalThis, 'ResizeObserver');
    }
  });

  it('supports keyboard sizing and viewport shrink without overwriting the preference', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 1200, writable: true });
    const { separator, store } = mount();
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(store.getState().boardSwitcher.prefs.panelWidth).toBe(310);
    fireEvent.keyDown(separator, { key: 'Home' });
    expect(separator.getAttribute('aria-valuenow')).toBe('200');
    fireEvent.keyDown(separator, { key: 'End' });
    expect(store.getState().boardSwitcher.prefs.panelWidth).toBe(480);
    act(() => { window.innerWidth = 768; window.dispatchEvent(new window.Event('resize')); });
    expect(separator.getAttribute('aria-valuenow')).toBe('448');
    expect(store.getState().boardSwitcher.prefs.panelWidth).toBe(480);
    act(() => { window.innerWidth = 1200; window.dispatchEvent(new window.Event('resize')); });
    expect(separator.getAttribute('aria-valuenow')).toBe('480');
  });

  it('keeps drag changes local until release and cancels on pointer cancellation or capture loss', async () => {
    window.innerWidth = 1200;
    const { separator, store, captured, ui } = mount();
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    fireEvent.pointerDown(separator, { button: 0, pointerId: 7, clientX: 300 });
    fireEvent.pointerMove(separator, { pointerId: 7, clientX: 380 });
    expect(separator.getAttribute('aria-valuenow')).toBe('380');
    expect(store.getState().boardSwitcher.prefs.panelWidth).toBe(300);
    fireEvent.pointerUp(separator, { pointerId: 7, clientX: 380 });
    expect(store.getState().boardSwitcher.prefs.panelWidth).toBe(380);
    expect(captured()).toBeNull();
    fireEvent.pointerDown(separator, { button: 0, pointerId: 8, clientX: 380 });
    fireEvent.pointerMove(separator, { pointerId: 8, clientX: 450 });
    fireEvent.pointerCancel(separator, { pointerId: 8 });
    expect(separator.getAttribute('aria-valuenow')).toBe('380');
    fireEvent.pointerDown(separator, { button: 0, pointerId: 9, clientX: 380 });
    fireEvent.pointerMove(separator, { pointerId: 9, clientX: 440 });
    fireEvent.lostPointerCapture(separator, { pointerId: 9 });
    expect(separator.getAttribute('aria-valuenow')).toBe('380');
    fireEvent.pointerDown(separator, { button: 0, pointerId: 10, clientX: 380 });
    ui.unmount();
    expect(captured()).toBeNull();
  });
});
