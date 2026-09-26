import { describe, expect, it } from 'bun:test';
import type { Board } from '../../Board/api';
import reducer, { fetchSwitcherBoardsThunk, toggleSwitcherStarThunk } from '../boardSwitcher.slice';

// [why] Frozen like RTK's real payloads, so a reducer that mutates it throws.
const board = Object.freeze({ id: 'b1', title: 'Framework', workspaceId: 'w1', state: 'ACTIVE', isStarred: false }) as Board;
const star = { boardId: 'b1', starred: true };
const unstar = { boardId: 'b1', starred: false };
const loaded = () => reducer(undefined, fetchSwitcherBoardsThunk.fulfilled([board], 'f0'));

describe('boardSwitcher slice', () => {
  it('keeps a toggle that settles before a stale fetch lands', () => {
    let state = reducer(loaded(), fetchSwitcherBoardsThunk.pending('f1'));
    state = reducer(state, toggleSwitcherStarThunk.pending('t1', star));
    state = reducer(state, toggleSwitcherStarThunk.fulfilled(undefined, 't1', star));
    state = reducer(state, fetchSwitcherBoardsThunk.fulfilled([board], 'f1'));
    expect(state.boards[0]?.isStarred).toBe(true);
    expect(state.fetchStartedAt).toEqual({});
  });

  it('keeps a toggle that settles after a stale fetch lands, then trusts a fresh fetch', () => {
    let state = reducer(loaded(), fetchSwitcherBoardsThunk.pending('f1'));
    state = reducer(state, toggleSwitcherStarThunk.pending('t1', star));
    state = reducer(state, fetchSwitcherBoardsThunk.fulfilled([board], 'f1'));
    expect(state.boards[0]?.isStarred).toBe(true);
    state = reducer(state, toggleSwitcherStarThunk.fulfilled(undefined, 't1', star));

    state = reducer(state, fetchSwitcherBoardsThunk.pending('f2'));
    state = reducer(state, fetchSwitcherBoardsThunk.fulfilled([board], 'f2'));
    expect(state.boards[0]?.isStarred).toBe(false);
  });

  it('keeps the latest of two in-flight toggles on one board over a stale fetch', () => {
    let state = reducer(loaded(), fetchSwitcherBoardsThunk.pending('f1'));
    state = reducer(state, toggleSwitcherStarThunk.pending('t1', star));
    state = reducer(state, toggleSwitcherStarThunk.pending('t2', unstar));
    state = reducer(state, toggleSwitcherStarThunk.pending('t3', star));
    state = reducer(state, toggleSwitcherStarThunk.fulfilled(undefined, 't1', star));
    state = reducer(state, fetchSwitcherBoardsThunk.fulfilled([board], 'f1'));
    expect(state.boards[0]?.isStarred).toBe(true);
  });

  it('rolls back a failed toggle', () => {
    let state = reducer(loaded(), toggleSwitcherStarThunk.pending('t1', star));
    state = reducer(state, toggleSwitcherStarThunk.rejected(new Error('x'), 't1', star));
    expect(state.boards[0]?.isStarred).toBe(false);
  });
});
