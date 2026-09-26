// Stars are one value across controls: the switcher's toggles (its panel and the board
// header) drive the board list's tiles, and the list's own star thunks drive the switcher.
import { describe, expect, it } from 'bun:test';
import { configureStore } from '@reduxjs/toolkit';
import boardListPage, {
  fetchBoardsThunk,
  unstarBoardThunk,
} from '../../Board/containers/BoardListPage/BoardListPage.duck';
import type { Board } from '../../Board/api';
import reducer, { fetchSwitcherBoardsThunk, selectSwitcherStarred, toggleStarAndReconcileThunk } from '../boardSwitcher.slice';

interface Deferred { resolve: () => void; reject: (e: Error) => void }

/** b1 is in both caches; b9 only in the list page's (e.g. a workspace the switcher failed to load). */
function setup(server: Record<string, boolean>) {
  const calls: Deferred[] = [];
  const hold = (apply: () => void) =>
    new Promise<void>((resolve, reject) => {
      calls.push({ resolve: () => { apply(); resolve(); }, reject });
    });
  const idOf = (url: string) => url.split('/')[2] ?? '';
  const api = {
    get: (url: string) =>
      Promise.resolve(
        url === '/workspaces'
          ? { data: [{ id: 'w1', name: 'Phoenix' }] }
          : { data: [{ id: 'b1', title: 'Framework', workspace_id: 'w1', state: 'ACTIVE', isStarred: server.b1 }] },
      ),
    post: (url: string) => hold(() => { server[idOf(url)] = true; }),
    delete: (url: string) => hold(() => { server[idOf(url)] = false; }),
  };
  const store = configureStore({
    reducer: { boardSwitcher: reducer, boardListPage },
    middleware: (gDM) => gDM({ thunk: { extraArgument: { api } }, serializableCheck: false }),
  });
  // [why] The thunks are typed against the app RootState; this store has only the slices they touch.
  const dispatch = store.dispatch as unknown as (action: unknown) => Promise<{ payload?: unknown }>;
  const tiles = Object.entries(server).map(([id, isStarred]) => ({ id, title: id, state: 'ACTIVE', isStarred }) as Board);
  const arg = { workspaceId: 'w1' };
  store.dispatch(fetchBoardsThunk.pending('l1', arg));
  store.dispatch(fetchBoardsThunk.fulfilled(tiles, 'l1', arg));
  const tile = (id: string) => store.getState().boardListPage.boards.find((b) => b.id === id)?.isStarred;
  const switcher = (id: string) => selectSwitcherStarred(store.getState() as never, id);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { calls, dispatch, tile, switcher, flush };
}

describe('stars shared between the switcher and the board list', () => {
  it('a switcher star shows on the tile at once and stays after success', async () => {
    const { calls, dispatch, tile, switcher, flush } = setup({ b1: false });
    await dispatch(fetchSwitcherBoardsThunk());
    const done = dispatch(toggleStarAndReconcileThunk({ boardId: 'b1', starred: true }));
    await flush();
    expect(tile('b1')).toBe(true); // optimistic
    calls[0]?.resolve();
    expect((await done).payload).toBe(true);
    expect([tile('b1'), switcher('b1')]).toEqual([true, true]);
  });

  it('a failed switcher star rolls the tile back', async () => {
    const { calls, dispatch, tile, switcher, flush } = setup({ b1: false });
    await dispatch(fetchSwitcherBoardsThunk());
    const done = dispatch(toggleStarAndReconcileThunk({ boardId: 'b1', starred: true }));
    await flush();
    expect(tile('b1')).toBe(true);
    calls[0]?.reject(new Error('500'));
    expect((await done).payload).toBe(false);
    await flush();
    expect([tile('b1'), switcher('b1')]).toEqual([false, false]);
  });

  it('a failed header unstar of an uncached starred board rolls back to starred', async () => {
    const { calls, dispatch, tile, switcher, flush } = setup({ b1: false, b9: true });
    const done = dispatch(toggleStarAndReconcileThunk({ boardId: 'b9', starred: false, prev: true }));
    await flush();
    expect([tile('b9'), switcher('b9')]).toEqual([false, false]);
    calls[0]?.reject(new Error('500'));
    await done;
    expect([tile('b9'), switcher('b9')]).toEqual([true, true]);
  });

  it('switcher star, then tile unstar: both end unstarred', async () => {
    const server = { b1: false };
    const { calls, dispatch, tile, switcher, flush } = setup(server);
    await dispatch(fetchSwitcherBoardsThunk());
    const star = dispatch(toggleStarAndReconcileThunk({ boardId: 'b1', starred: true }));
    await flush();
    calls[0]?.resolve();
    await star;
    // The tile now reads starred, so its button unstars (before the fix it sent another star).
    expect(tile('b1')).toBe(true);
    const unstar = dispatch(unstarBoardThunk({ boardId: 'b1' }));
    await flush();
    calls[1]?.resolve();
    await unstar;
    expect([server.b1, tile('b1'), switcher('b1')]).toEqual([false, false, false]);
  });

  it('tile unstar settling while a switcher star is out ends on server state in both', async () => {
    const server = { b1: false };
    const { calls, dispatch, tile, switcher, flush } = setup(server);
    await dispatch(fetchSwitcherBoardsThunk());
    const star = dispatch(toggleStarAndReconcileThunk({ boardId: 'b1', starred: true }));
    const unstar = dispatch(unstarBoardThunk({ boardId: 'b1' }));
    await flush();
    calls[1]?.resolve(); // the tile's unstar lands first…
    await unstar;
    calls[0]?.resolve(); // …then the switcher's star; the overlap triggers a reconcile
    await star;
    await flush();
    expect([server.b1, tile('b1'), switcher('b1')]).toEqual([true, true, true]);
  });

  it("the header's displayed value follows a switcher toggle", async () => {
    const { calls, dispatch, switcher, flush } = setup({ b1: false });
    expect(switcher('b1')).toBeUndefined(); // unknown → BoardPage falls back to board.isStarred
    await dispatch(fetchSwitcherBoardsThunk());
    expect(switcher('b1')).toBe(false);
    const done = dispatch(toggleStarAndReconcileThunk({ boardId: 'b1', starred: true }));
    await flush();
    expect(switcher('b1')).toBe(true);
    calls[0]?.resolve();
    await done;
    expect(switcher('b1')).toBe(true);
  });
});
