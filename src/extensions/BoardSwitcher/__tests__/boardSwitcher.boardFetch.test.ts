// The open board's fresh load (BoardPage's fetchBoardDataThunk) is server truth for its star,
// so the header must not keep a stale switcher value from before the board was starred elsewhere.
import { describe, expect, it } from 'bun:test';
import { configureStore } from '@reduxjs/toolkit';
import type { Board } from '../../Board/api';
import { fetchBoardDataThunk } from '../../Board/slices/boardSlice';
import { logoutThunk } from '../../Auth/duck/authDuck';
import reducer, {
  fetchSwitcherBoardsThunk,
  patchSwitcherBoard,
  selectSwitcherStarred,
  toggleStarAndReconcileThunk,
  toggleSwitcherStarThunk,
} from '../boardSwitcher.slice';

const board = (isStarred: boolean) => ({ id: 'b1', title: 'B', workspaceId: 'w1', state: 'ACTIVE', isStarred }) as Board;
const loaded = (isStarred: boolean) => ({ data: board(isStarred), includes: { lists: [], cards: [] } });
const load = { boardId: 'b1' };
const starred = (state: ReturnType<typeof reducer>) => selectSwitcherStarred({ boardSwitcher: state } as never, 'b1');

function setup(server: { b1: boolean }) {
  const sent: string[] = [];
  const api = {
    get: (url: string) =>
      Promise.resolve(
        url === '/workspaces'
          ? { data: [{ id: 'w1', name: 'W' }] }
          : url.startsWith('/boards/')
            ? loaded(server.b1)
            : { data: [{ id: 'b1', title: 'B', workspace_id: 'w1', state: 'ACTIVE', isStarred: server.b1 }] },
      ),
    post: () => { sent.push('star'); server.b1 = true; return Promise.resolve(); },
    delete: () => { sent.push('unstar'); server.b1 = false; return Promise.resolve(); },
  };
  const store = configureStore({
    reducer: { boardSwitcher: reducer },
    middleware: (gDM) => gDM({ thunk: { extraArgument: { api } }, serializableCheck: false }),
  });
  // [why] The thunks are typed against the app RootState; this store has only the switcher slice.
  const dispatch = store.dispatch as unknown as (action: unknown) => Promise<unknown>;
  const header = () => selectSwitcherStarred(store.getState() as never, 'b1');
  /** What BoardPage's header does: toggle to the opposite of what it shows. */
  const clickHeader = async (boardIsStarred: boolean) => {
    const shown = header() ?? boardIsStarred;
    await dispatch(toggleStarAndReconcileThunk({ boardId: 'b1', starred: !shown, prev: shown }));
  };
  return { sent, dispatch, header, clickHeader };
}

describe('boardSwitcher — the open board fetch reconciles stars', () => {
  it('adopts a star made elsewhere over the cached unstarred value', async () => {
    const server = { b1: false };
    const { sent, dispatch, header, clickHeader } = setup(server);
    await dispatch(fetchSwitcherBoardsThunk()); // switcher opened, then closed: b1 cached unstarred
    expect(header()).toBe(false);
    server.b1 = true; // starred in another tab
    await dispatch(fetchBoardDataThunk(load)); // navigate back to the board
    expect(header()).toBe(true);
    await clickHeader(true);
    expect(sent).toEqual(['unstar']);
    expect(header()).toBe(false);
  });

  it('adopts it over a settled toggle on an uncached board', async () => {
    const server = { b1: true };
    const { sent, dispatch, header, clickHeader } = setup(server);
    await clickHeader(true); // header unstar, switcher never loaded
    expect([sent, header()]).toEqual([['unstar'], false]);
    server.b1 = true;
    await dispatch(fetchBoardDataThunk(load));
    expect(header()).toBe(true);
    await clickHeader(true);
    expect(sent).toEqual(['unstar', 'unstar']);
  });

  it('keeps a toggle that is pending or started after the board fetch', () => {
    let state = reducer(undefined, fetchSwitcherBoardsThunk.pending('f'));
    state = reducer(state, fetchSwitcherBoardsThunk.fulfilled({ boards: [board(false)], incomplete: false }, 'f'));

    // Toggle still pending when the fetch lands.
    state = reducer(state, fetchBoardDataThunk.pending('g1', load));
    state = reducer(state, toggleSwitcherStarThunk.pending('t1', { boardId: 'b1', starred: true }));
    state = reducer(state, fetchBoardDataThunk.fulfilled(loaded(false), 'g1', load));
    expect(starred(state)).toBe(true);

    // Toggle settled, but after the fetch started (the fetch may predate it).
    state = reducer(state, fetchBoardDataThunk.pending('g2', load));
    state = reducer(state, toggleSwitcherStarThunk.fulfilled(undefined, 't1', { boardId: 'b1', starred: true }));
    state = reducer(state, fetchBoardDataThunk.fulfilled(loaded(false), 'g2', load));
    expect(starred(state)).toBe(true);

    // A fetch started after everything settled wins.
    state = reducer(state, fetchBoardDataThunk.pending('g3', load));
    state = reducer(state, fetchBoardDataThunk.fulfilled(loaded(false), 'g3', load));
    expect(starred(state)).toBe(false);
  });

  it('keeps the adopted value against an older switcher fetch landing later', () => {
    let state = reducer(undefined, fetchSwitcherBoardsThunk.pending('f0'));
    state = reducer(state, fetchSwitcherBoardsThunk.fulfilled({ boards: [board(false)], incomplete: false }, 'f0'));
    state = reducer(state, fetchSwitcherBoardsThunk.pending('f1')); // reads the old value
    state = reducer(state, fetchBoardDataThunk.pending('g', load));
    state = reducer(state, fetchBoardDataThunk.fulfilled(loaded(true), 'g', load));
    state = reducer(state, fetchSwitcherBoardsThunk.fulfilled({ boards: [board(false)], incomplete: false }, 'f1'));
    expect(starred(state)).toBe(true);
  });

  it('does not let an older board fetch revert a newer switcher refresh', () => {
    let state = reducer(undefined, fetchSwitcherBoardsThunk.pending('f0'));
    state = reducer(state, fetchSwitcherBoardsThunk.fulfilled({ boards: [board(false)], incomplete: false }, 'f0'));
    state = reducer(state, fetchBoardDataThunk.pending('g', load)); // reads the old value
    // Starred in another tab; the newer switcher refresh reads it and finishes first.
    state = reducer(state, fetchSwitcherBoardsThunk.pending('f1'));
    state = reducer(state, fetchSwitcherBoardsThunk.fulfilled({ boards: [board(true)], incomplete: false }, 'f1'));
    expect(starred(state)).toBe(true);
    state = reducer(state, fetchBoardDataThunk.fulfilled(loaded(false), 'g', load));
    expect(starred(state)).toBe(true);
  });

  it('does not let a metadata edit revert fresh star reads', () => {
    let state = reducer(undefined, fetchSwitcherBoardsThunk.pending('f0'));
    state = reducer(state, fetchSwitcherBoardsThunk.fulfilled({ boards: [board(false)], incomplete: false }, 'f0'));
    state = reducer(state, fetchBoardDataThunk.pending('g', load));
    state = reducer(state, fetchSwitcherBoardsThunk.pending('f1'));
    // Renamed while both reads are out: the edit snapshot still carries isStarred=false.
    state = reducer(state, patchSwitcherBoard({ id: 'b1', title: 'Renamed', background: null, state: 'ACTIVE' }));
    state = reducer(state, fetchBoardDataThunk.fulfilled(loaded(true), 'g', load));
    state = reducer(state, fetchSwitcherBoardsThunk.fulfilled({ boards: [board(true)], incomplete: false }, 'f1'));
    expect(starred(state)).toBe(true);
    expect(state.boards[0]?.title).toBe('Renamed');
  });

  it('ignores a previous session board fetch landing after logout', () => {
    let state = reducer(undefined, fetchBoardDataThunk.pending('g', load));
    state = reducer(state, logoutThunk.pending('lo'));
    state = reducer(state, fetchBoardDataThunk.fulfilled(loaded(true), 'g', load));
    expect(starred(state)).toBeUndefined();
  });
});
