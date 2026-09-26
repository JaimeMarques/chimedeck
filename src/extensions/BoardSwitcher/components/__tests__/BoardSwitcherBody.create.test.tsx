// Double-submit guard for "Create new board" in the switcher, mounted under jsdom
// (same bootstrap as Comment/components/__tests__/commentItemRender.test.ts).
import { afterEach, describe, expect, it } from 'bun:test';
import { JSDOM } from 'jsdom';

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
const { MemoryRouter } = await import('react-router-dom');
const { act, cleanup, fireEvent, render } = await import('@testing-library/react');
const { default: boardSwitcher } = await import('../../boardSwitcher.slice');
const { default: BoardSwitcherBody } = await import('../BoardSwitcherBody');

function mount() {
  const posts: string[] = [];
  const api = {
    get: (url: string) => Promise.resolve({ data: url === '/workspaces' ? [{ id: 'w1', name: 'Phoenix' }] : [] }),
    // Never settles: the create stays in flight for the whole test.
    post: (url: string) => { posts.push(url); return new Promise(() => {}); },
  };
  const store = configureStore({
    reducer: {
      boardSwitcher,
      workspaceShell: () => ({ workspaces: [{ id: 'w1', name: 'Phoenix' }], activeWorkspaceId: 'w1' }),
      board: () => ({ board: null }),
    },
    middleware: (gDM) => gDM({ thunk: { extraArgument: { api } }, serializableCheck: false }),
  });
  const view = render(
    <Provider store={store}>
      <MemoryRouter>
        <BoardSwitcherBody variant="pinned" />
      </MemoryRouter>
    </Provider>,
  );
  return { posts, view };
}

afterEach(() => { cleanup(); });

describe('BoardSwitcherBody create', () => {
  it('sends one create for two rapid submits and disables Create while in flight', async () => {
    // [why] Queries from render(), not `screen`: screen binds document.body at import time,
    // which breaks when another test file loaded testing-library before jsdom globals.
    const { posts, view: screen } = mount();
    fireEvent.click(await screen.findByText('Create new board', { exact: false }));
    const input = screen.getByPlaceholderText('Board title');
    // [why] In the full `bun test src` run react-dom may already be loaded by a file without a
    // DOM, so it uses its old-IE input polyfill (attachEvent + focusin/keyup). Stubbing
    // attachEvent and sending focusin/keyup makes onChange fire under either mode.
    Object.assign(input, { attachEvent: () => {}, detachEvent: () => {} });
    fireEvent.focusIn(input);
    fireEvent.change(input, { target: { value: 'Dup check' } });
    fireEvent.keyUp(input);
    const create = screen.getByRole('button', { name: 'Create' });
    // [why] One outer act: both clicks land before React re-renders, so this exercises
    // the synchronous ref guard, not just the disabled button.
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
});
