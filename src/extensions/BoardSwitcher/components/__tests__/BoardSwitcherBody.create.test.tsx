// Double-submit guard for "Create new board" in the switcher, mounted under jsdom
// (same bootstrap as Comment/components/__tests__/commentItemRender.test.ts).
import { afterEach, describe, expect, it } from 'bun:test';
import { JSDOM } from 'jsdom';
import type { Middleware } from '@reduxjs/toolkit';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://chimedeck.test/b/b1' });
const win = dom.window as unknown as Record<string, unknown>;
win.matchMedia = () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} });
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (!(key in globalThis)) {
    Object.defineProperty(globalThis, key, { value: win[key], writable: true, configurable: true });
  }
}
for (const key of ['window', 'document', 'navigator', 'location'] as const) {
  Object.defineProperty(globalThis, key, { value: key === 'window' ? dom.window : win[key], writable: true, configurable: true });
}

const { configureStore } = await import('@reduxjs/toolkit');
const { Provider } = await import('react-redux');
const { MemoryRouter, useLocation } = await import('react-router-dom');
const { act, cleanup, fireEvent, render } = await import('@testing-library/react');
const { default: boardSwitcher } = await import('../../boardSwitcher.slice');
const { default: BoardSwitcherBody } = await import('../BoardSwitcherBody');
const { clearAuth } = await import('../../../Auth/duck/authDuck');

function makeStore() {
  const posts: string[] = [];
  const settle: Array<() => void> = [];
  const actions: string[] = [];
  const api = {
    get: (url: string) => Promise.resolve({ data: url === '/workspaces' ? [{ id: 'w1', name: 'Phoenix' }] : [] }),
    // Held until the test calls settle[i]().
    post: (url: string) => {
      posts.push(url);
      return new Promise((resolve) => { settle.push(() => { resolve({ data: { id: 'new1', title: 'Dup check' } }); }); });
    },
  };
  const log: Middleware = () => (next) => (action) => {
    actions.push((action as { type: string }).type);
    return next(action);
  };
  const store = configureStore({
    reducer: {
      boardSwitcher,
      workspaceShell: () => ({ workspaces: [{ id: 'w1', name: 'Phoenix' }], activeWorkspaceId: 'w1' }),
      board: () => ({ board: null }),
    },
    middleware: (gDM) =>
      gDM({ thunk: { extraArgument: { api } }, serializableCheck: false }).concat(log),
  });
  return { store, posts, settle, actions };
}

let path = '';
const PathProbe = () => { path = useLocation().pathname; return null; };

function mount(store: ReturnType<typeof makeStore>['store']) {
  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={['/b/b1']}>
        <BoardSwitcherBody variant="pinned" />
        <PathProbe />
      </MemoryRouter>
    </Provider>,
  );
}

/** Opens the create modal, types a title and returns the Create button. */
async function openCreate(screen: ReturnType<typeof mount>) {
  fireEvent.click(await screen.findByText('Create new board', { exact: false }));
  const input = screen.getByPlaceholderText('Board title');
  // [why] In the full `bun test src` run react-dom may already be loaded by a file without a
  // DOM, so it uses its old-IE input polyfill (attachEvent + focusin/keyup). Stubbing
  // attachEvent and sending focusin/keyup makes onChange fire under either mode.
  Object.assign(input, { attachEvent: () => {}, detachEvent: () => {} });
  fireEvent.focusIn(input);
  fireEvent.change(input, { target: { value: 'Dup check' } });
  fireEvent.keyUp(input);
  return { input, create: screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement };
}

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

afterEach(() => { cleanup(); });

describe('BoardSwitcherBody create', () => {
  it('sends one create for two rapid submits and disables Create while in flight', async () => {
    // [why] Queries from render(), not `screen`: screen binds document.body at import time,
    // which breaks when another test file loaded testing-library before jsdom globals.
    const { store, posts } = makeStore();
    const screen = mount(store);
    const { input, create } = await openCreate(screen);
    // [why] One outer act: both clicks land before React re-renders, so this exercises
    // the synchronous guard, not just the disabled button.
    act(() => {
      fireEvent.click(create);
      fireEvent.click(create);
    });
    expect(posts).toEqual(['/workspaces/w1/boards']);
    expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(true);
    const form = input.closest('form');
    if (form) fireEvent.submit(form); // Enter re-submit path
    expect(posts).toHaveLength(1);
  });

  it('keeps the guard across a remount and does not navigate once the starter is gone', async () => {
    const { store, posts, settle, actions } = makeStore();
    const first = mount(store);
    const started = (await openCreate(first)).create;
    act(() => { fireEvent.click(started); });
    expect(posts).toHaveLength(1);
    first.unmount(); // user closed the switcher

    const second = mount(store);
    const { create } = await openCreate(second);
    expect(create.disabled).toBe(true);
    const form = create.closest('form');
    if (form) act(() => { fireEvent.submit(form); });
    expect(posts).toHaveLength(1);

    settle[0]?.();
    await flush();
    expect(path).toBe('/b/b1');
    expect(actions).not.toContain('workspaceShell/setActiveWorkspace');
    expect((second.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not navigate when the session changed before the create finished', async () => {
    const { store, settle, actions } = makeStore();
    const screen = mount(store);
    const { create } = await openCreate(screen);
    act(() => { fireEvent.click(create); });
    act(() => { store.dispatch(clearAuth()); });
    settle[0]?.();
    await flush();
    expect(path).toBe('/b/b1');
    expect(actions).not.toContain('workspaceShell/setActiveWorkspace');
  });
});
