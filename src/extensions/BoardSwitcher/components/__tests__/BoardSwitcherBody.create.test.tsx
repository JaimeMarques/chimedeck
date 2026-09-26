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
const { MemoryRouter, useLocation, useNavigate } = await import('react-router-dom');
const { act, cleanup, fireEvent, render } = await import('@testing-library/react');
const { default: boardSwitcher } = await import('../../boardSwitcher.slice');
const { default: BoardSwitcherBody } = await import('../BoardSwitcherBody');
const { clearAuth } = await import('../../../Auth/duck/authDuck');

function makeStore() {
  const posts: string[] = [];
  const settle: Array<() => void> = [];
  const actions: string[] = [];
  // Boards the fake server has created, served back by the board-list GET.
  const created: Array<{ id: string; title: string; state: string; workspace_id: string }> = [];
  const api = {
    get: (url: string) => Promise.resolve({ data: url === '/workspaces' ? [{ id: 'w1', name: 'Phoenix' }] : [...created] }),
    // Held until the test calls settle[i]().
    post: (url: string) => {
      posts.push(url);
      return new Promise((resolve) => {
        settle.push(() => {
          created.push({ id: 'new1', title: 'Dup check', state: 'ACTIVE', workspace_id: 'w1' });
          resolve({ data: { id: 'new1', title: 'Dup check' } });
        });
      });
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
let nav: (to: string) => void = () => {};
const PathProbe = () => {
  path = useLocation().pathname;
  const navigate = useNavigate();
  nav = (to) => { navigate(to); };
  return null;
};

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
    // The board created by the closed switcher still shows up in the reopened one.
    expect(store.getState().boardSwitcher.boards.map((b) => b.id)).toContain('new1');
  });

  it('does not navigate when the session changed before the create finished', async () => {
    const { store, settle, actions } = makeStore();
    const screen = mount(store);
    const { create } = await openCreate(screen);
    act(() => { fireEvent.click(create); });
    act(() => { store.dispatch(clearAuth()); });
    const fetchesBefore = actions.filter((t) => t === 'boardSwitcher/fetchBoards/pending').length;
    settle[0]?.();
    await flush();
    expect(path).toBe('/b/b1');
    expect(actions).not.toContain('workspaceShell/setActiveWorkspace');
    // No refresh on behalf of the previous account.
    expect(actions.filter((t) => t === 'boardSwitcher/fetchBoards/pending').length).toBe(fetchesBefore);
  });

  it('does not navigate after the create modal was cancelled, but still lists the board', async () => {
    const { store, settle, actions } = makeStore();
    const screen = mount(store);
    const { create } = await openCreate(screen);
    act(() => { fireEvent.click(create); });
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
    settle[0]?.();
    await flush();
    expect(path).toBe('/b/b1');
    expect(actions).not.toContain('workspaceShell/setActiveWorkspace');
    expect(store.getState().boardSwitcher.boards.map((b) => b.id)).toContain('new1');
  });

  it('does not override a navigation made while the create was in flight', async () => {
    const { store, settle, actions } = makeStore();
    const screen = mount(store);
    const { create } = await openCreate(screen);
    act(() => { fireEvent.click(create); });
    act(() => { nav('/workspaces'); });
    expect(screen.queryByPlaceholderText('Board title')).toBeNull(); // abandoned: modal closed
    settle[0]?.();
    await flush();
    expect(path).toBe('/workspaces');
    expect(actions).not.toContain('workspaceShell/setActiveWorkspace');
  });

  it('refetches on window focus, once while a fetch is in flight', async () => {
    const { store, actions } = makeStore();
    mount(store);
    await flush();
    const fetches = () => actions.filter((t) => t === 'boardSwitcher/fetchBoards/pending').length;
    const before = fetches();
    act(() => {
      window.dispatchEvent(new window.Event('focus'));
      window.dispatchEvent(new window.Event('focus'));
    });
    expect(fetches()).toBe(before + 1);
    await flush();
    act(() => { window.dispatchEvent(new window.Event('focus')); });
    expect(fetches()).toBe(before + 2);
  });

  it('refetches once per in-app navigation, not twice on mount', async () => {
    const { store, actions } = makeStore();
    mount(store);
    const fetches = () => actions.filter((t) => t === 'boardSwitcher/fetchBoards/pending').length;
    expect(fetches()).toBe(1); // the mount fetch only
    await flush();
    // e.g. BoardPage's header delete: a plain API call, then navigation to the boards page
    act(() => { nav('/workspaces/w1/boards'); });
    expect(fetches()).toBe(2);
  });
});
