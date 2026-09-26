import { describe, expect, it } from 'bun:test';
import type { Board } from '../../Board/api';
import reducer, { fetchSwitcherBoardsThunk, toggleSwitcherStarThunk } from '../boardSwitcher.slice';

const board = { id: 'b1', title: 'Framework', workspaceId: 'w1', state: 'ACTIVE', isStarred: false } as Board;

describe('boardSwitcher slice', () => {
  it('keeps an in-flight star toggle over a fetch that resolves with the old value', () => {
    const arg = { boardId: 'b1', starred: true };
    let state = reducer(undefined, fetchSwitcherBoardsThunk.fulfilled([board], 'f0'));
    state = reducer(state, toggleSwitcherStarThunk.pending('t1', arg));
    state = reducer(state, fetchSwitcherBoardsThunk.fulfilled([board], 'f1'));
    expect(state.boards[0]?.isStarred).toBe(true);

    state = reducer(state, toggleSwitcherStarThunk.fulfilled(undefined, 't1', arg));
    expect(state.pendingStars).toEqual({});
    state = reducer(state, fetchSwitcherBoardsThunk.fulfilled([board], 'f2'));
    expect(state.boards[0]?.isStarred).toBe(false);
  });

  it('rolls back and forgets a failed toggle', () => {
    const arg = { boardId: 'b1', starred: true };
    let state = reducer(undefined, fetchSwitcherBoardsThunk.fulfilled([board], 'f0'));
    state = reducer(state, toggleSwitcherStarThunk.pending('t1', arg));
    state = reducer(state, toggleSwitcherStarThunk.rejected(new Error('x'), 't1', arg));
    expect(state.boards[0]?.isStarred).toBe(false);
    expect(state.pendingStars).toEqual({});
  });
});
