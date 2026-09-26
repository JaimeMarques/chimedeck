import { describe, expect, it } from 'bun:test';
import type { Board } from '../../Board/api';
import { clearAuth, loginThunk, logoutThunk } from '../../Auth/duck/authDuck';
import reducer, { fetchSwitcherBoardsThunk, setSwitcherPrefs, toggleSwitcherStarThunk } from '../boardSwitcher.slice';

const boardA = Object.freeze({ id: 'a1', title: 'A private', workspaceId: 'wA', state: 'ACTIVE', isStarred: false }) as Board;
const boardB = Object.freeze({ id: 'b1', title: 'B board', workspaceId: 'wB', state: 'ACTIVE', isStarred: false }) as Board;
const login = { email: 'b@example.com', password: 'x' };
const loginOk = loginThunk.fulfilled({ user: { id: 'uB', name: 'B', email: 'b@example.com' }, accessToken: 't' } as never, 'l1', login);

describe('boardSwitcher slice — session changes', () => {
  it('drops account A boards on logout and ignores A fetches that land late', () => {
    let state = reducer(undefined, setSwitcherPrefs({ layout: 'list' }));
    state = reducer(state, fetchSwitcherBoardsThunk.pending('fA0'));
    state = reducer(state, fetchSwitcherBoardsThunk.fulfilled({ boards: [boardA], incomplete: true }, 'fA0'));
    state = reducer(state, fetchSwitcherBoardsThunk.pending('fA1')); // still in flight at logout
    state = reducer(state, toggleSwitcherStarThunk.pending('tA', { boardId: 'a1', starred: true }));

    state = reducer(state, logoutThunk.pending('lo'));
    expect(state.boards).toEqual([]);
    expect(state.status).toBe('idle');
    expect(state.incomplete).toBe(false);
    expect(state.prefs.layout).toBe('list');

    state = reducer(state, loginOk);
    state = reducer(state, fetchSwitcherBoardsThunk.pending('fB'));
    state = reducer(state, fetchSwitcherBoardsThunk.fulfilled({ boards: [boardA], incomplete: false }, 'fA1'));
    state = reducer(state, toggleSwitcherStarThunk.fulfilled(undefined, 'tA', { boardId: 'a1', starred: true }));
    expect(state.boards).toEqual([]);
    expect(state.status).toBe('loading'); // B's fetch still pending

    state = reducer(state, fetchSwitcherBoardsThunk.rejected(new Error('down'), 'fB'));
    expect(state.boards).toEqual([]);
    expect(state.status).toBe('error');

    state = reducer(state, fetchSwitcherBoardsThunk.pending('fB2'));
    state = reducer(state, fetchSwitcherBoardsThunk.fulfilled({ boards: [boardB], incomplete: false }, 'fB2'));
    expect(state.boards.map((b) => b.id)).toEqual(['b1']);
  });

  it('resets on clearAuth (session expiry) and ignores a late rejection', () => {
    let state = reducer(undefined, fetchSwitcherBoardsThunk.pending('f0'));
    state = reducer(state, fetchSwitcherBoardsThunk.fulfilled({ boards: [boardA], incomplete: false }, 'f0'));
    state = reducer(state, fetchSwitcherBoardsThunk.pending('f1'));
    state = reducer(state, clearAuth());
    state = reducer(state, fetchSwitcherBoardsThunk.rejected(new Error('401'), 'f1'));
    expect(state.boards).toEqual([]);
    expect(state.status).toBe('idle');
    expect(state.loadFailed).toBe(false);
  });
});
