import { describe, expect, it } from 'bun:test';
import type { Board } from '../../Board/api';
import reducer, { fetchSwitcherBoardsThunk, toggleSwitcherStarThunk } from '../boardSwitcher.slice';

// [why] Frozen like RTK's real payloads, so a reducer that mutates it throws.
const board = Object.freeze({ id: 'b1', title: 'Framework', workspaceId: 'w1', state: 'ACTIVE', isStarred: false }) as Board;
const starredBoard = Object.freeze({ ...board, isStarred: true }) as Board;
const star = { boardId: 'b1', starred: true };
const unstar = { boardId: 'b1', starred: false };
const payload = (b: Board, incomplete = false) => ({ boards: [b], incomplete });

type State = ReturnType<typeof reducer>;
const loaded = (): State => {
  const state = reducer(undefined, fetchSwitcherBoardsThunk.pending('f0'));
  return reducer(state, fetchSwitcherBoardsThunk.fulfilled(payload(board), 'f0'));
};
const fetchWith = (state: State, id: string, b: Board) =>
  reducer(reducer(state, fetchSwitcherBoardsThunk.pending(id)), fetchSwitcherBoardsThunk.fulfilled(payload(b), id));
const starred = (state: State) => state.boards[0]?.isStarred;

describe('boardSwitcher slice — star toggles vs fetches', () => {
  it('keeps a toggle that settles before a stale fetch lands', () => {
    let state = reducer(loaded(), fetchSwitcherBoardsThunk.pending('f1'));
    state = reducer(state, toggleSwitcherStarThunk.pending('t1', star));
    state = reducer(state, toggleSwitcherStarThunk.fulfilled(undefined, 't1', star));
    state = reducer(state, fetchSwitcherBoardsThunk.fulfilled(payload(board), 'f1'));
    expect(starred(state)).toBe(true);
    expect(state.fetchStartedAt).toEqual({});
  });

  it('keeps a toggle against a fetch that started while the toggle was in flight', () => {
    let state = reducer(loaded(), toggleSwitcherStarThunk.pending('t1', star));
    state = reducer(state, fetchSwitcherBoardsThunk.pending('f1'));
    state = reducer(state, fetchSwitcherBoardsThunk.fulfilled(payload(board), 'f1'));
    expect(starred(state)).toBe(true);
    state = reducer(state, toggleSwitcherStarThunk.fulfilled(undefined, 't1', star));
    expect(starred(state)).toBe(true);
  });

  it('trusts a fetch that starts after the toggle settled', () => {
    let state = reducer(loaded(), toggleSwitcherStarThunk.pending('t1', star));
    state = reducer(state, toggleSwitcherStarThunk.fulfilled(undefined, 't1', star));
    state = fetchWith(state, 'f2', board);
    expect(starred(state)).toBe(false);
  });

  it('keeps the latest of several in-flight toggles over a stale fetch', () => {
    let state = reducer(loaded(), fetchSwitcherBoardsThunk.pending('f1'));
    state = reducer(state, toggleSwitcherStarThunk.pending('t1', star));
    state = reducer(state, toggleSwitcherStarThunk.pending('t2', unstar));
    state = reducer(state, toggleSwitcherStarThunk.pending('t3', star));
    state = reducer(state, toggleSwitcherStarThunk.fulfilled(undefined, 't1', star));
    state = reducer(state, fetchSwitcherBoardsThunk.fulfilled(payload(board), 'f1'));
    expect(starred(state)).toBe(true);
  });

  it('ignores an older toggle failing after a newer one succeeded', () => {
    let state = reducer(loaded(), toggleSwitcherStarThunk.pending('t1', star));
    state = reducer(state, toggleSwitcherStarThunk.pending('t2', unstar));
    state = reducer(state, toggleSwitcherStarThunk.fulfilled(undefined, 't2', unstar));
    state = reducer(state, toggleSwitcherStarThunk.rejected(new Error('x'), 't1', star));
    expect(starred(state)).toBe(false);

    // Same shape, opposite direction: the older failure must not flip the newer success.
    state = fetchWith(state, 'f2', starredBoard);
    state = reducer(state, toggleSwitcherStarThunk.pending('t3', unstar));
    state = reducer(state, toggleSwitcherStarThunk.pending('t4', star));
    state = reducer(state, toggleSwitcherStarThunk.fulfilled(undefined, 't4', star));
    state = reducer(state, toggleSwitcherStarThunk.rejected(new Error('x'), 't3', unstar));
    expect(starred(state)).toBe(true);
  });

  it('rolls back a failed latest toggle to the value before it', () => {
    let state = reducer(loaded(), toggleSwitcherStarThunk.pending('t1', star));
    state = reducer(state, toggleSwitcherStarThunk.rejected(new Error('x'), 't1', star));
    expect(starred(state)).toBe(false);
  });
});

describe('boardSwitcher slice — load failures', () => {
  it('reports a rejected load as an error and keeps earlier boards', () => {
    let state = reducer(loaded(), fetchSwitcherBoardsThunk.pending('f1'));
    state = reducer(state, fetchSwitcherBoardsThunk.rejected(new Error('down'), 'f1'));
    expect(state.status).toBe('error');
    expect(state.boards).toHaveLength(1);
  });

  it('flags a partial load and clears the flag on a full one', () => {
    let state = reducer(loaded(), fetchSwitcherBoardsThunk.pending('f1'));
    state = reducer(state, fetchSwitcherBoardsThunk.fulfilled(payload(board, true), 'f1'));
    expect(state.status).toBe('idle');
    expect(state.incomplete).toBe(true);
    state = fetchWith(state, 'f2', board);
    expect(state.incomplete).toBe(false);
  });

  it('does not let an older fetch overwrite or error over a newer one', () => {
    let state = reducer(loaded(), fetchSwitcherBoardsThunk.pending('f1'));
    state = reducer(state, fetchSwitcherBoardsThunk.pending('f2'));
    expect(state.status).toBe('loading');
    state = reducer(state, fetchSwitcherBoardsThunk.fulfilled(payload(starredBoard), 'f2'));
    expect(state.status).toBe('loading'); // f1 still in flight
    state = reducer(state, fetchSwitcherBoardsThunk.rejected(new Error('late'), 'f1'));
    expect(state.status).toBe('idle');
    expect(starred(state)).toBe(true);

    state = reducer(state, fetchSwitcherBoardsThunk.pending('f3'));
    state = reducer(state, fetchSwitcherBoardsThunk.pending('f4'));
    state = reducer(state, fetchSwitcherBoardsThunk.fulfilled(payload(board), 'f4'));
    state = reducer(state, fetchSwitcherBoardsThunk.fulfilled(payload(starredBoard), 'f3'));
    expect(starred(state)).toBe(false);
  });
});
