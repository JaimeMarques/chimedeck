// Board mutations made outside the switcher (list page thunks, realtime, the open board)
// keep the switcher's cached list consistent, also against older in-flight fetches.
import { describe, expect, it } from 'bun:test';
import type { Board } from '../../Board/api';
import {
  archiveBoardThunk,
  boardRemovedByRealtime,
  createBoardThunk,
  deleteBoardThunk,
  duplicateBoardThunk,
  starBoardThunk,
  unstarBoardThunk,
} from '../../Board/containers/BoardListPage/BoardListPage.duck';
import { deleteBoardOptimisticThunk } from '../../Board/slices/boardsSlice';
import { logoutThunk } from '../../Auth/duck/authDuck';
import reducer, { fetchSwitcherBoardsThunk, patchSwitcherBoard, toggleSwitcherStarThunk } from '../boardSwitcher.slice';

// [why] Frozen like RTK's real payloads, so a reducer that mutates it throws.
const b1 = Object.freeze({ id: 'b1', title: 'Framework', workspaceId: 'w1', state: 'ACTIVE', isStarred: false }) as Board;
const b2 = Object.freeze({ id: 'b2', title: 'Website', workspaceId: 'w1', state: 'ACTIVE', isStarred: false }) as Board;
// A raw row as the create/duplicate endpoints return it (workspace_id, no workspaceId).
const raw = (id: string, state = 'ACTIVE') =>
  Object.freeze({ id, title: id, state, workspace_id: 'w2' }) as unknown as Board;

type State = ReturnType<typeof reducer>;
type Action = Parameters<typeof reducer>[1];
const run = (state: State | undefined, ...actions: Action[]) => actions.reduce(reducer, state as State);
const loaded = () =>
  run(undefined, fetchSwitcherBoardsThunk.pending('f0'), fetchSwitcherBoardsThunk.fulfilled({ boards: [b1, b2], incomplete: false }, 'f0'));
const ids = (s: State) => s.boards.map((b) => b.id);
const fetchStart = (id: string) => fetchSwitcherBoardsThunk.pending(id);
const fetchLand = (id: string, boards: Board[] = [b1, b2]) => fetchSwitcherBoardsThunk.fulfilled({ boards, incomplete: false }, id);
const arg = { boardId: 'b1' };

describe('boardSwitcher slice — mutations made elsewhere', () => {
  it('removes a board deleted from the list page', () => {
    const s = run(loaded(), deleteBoardThunk.pending('d1', arg), deleteBoardThunk.fulfilled('b1', 'd1', arg));
    expect(ids(s)).toEqual(['b2']);
  });

  it('removes a board on optimistic delete success, but keeps it on failure', () => {
    const del = { boardId: 'b1' };
    expect(ids(run(loaded(), deleteBoardOptimisticThunk.pending('d1', del), deleteBoardOptimisticThunk.fulfilled('b1', 'd1', del)))).toEqual(['b2']);
    expect(ids(run(loaded(), deleteBoardOptimisticThunk.pending('d1', del), deleteBoardOptimisticThunk.rejected(new Error('409'), 'd1', del)))).toEqual(['b1', 'b2']);
  });

  it('removes a board deleted via realtime', () => {
    expect(ids(run(loaded(), boardRemovedByRealtime({ boardId: 'b2' })))).toEqual(['b1']);
  });

  it('does not let a fetch that started before a delete resurrect the board', () => {
    const s = run(loaded(), fetchStart('f1'), deleteBoardThunk.pending('d1', arg), deleteBoardThunk.fulfilled('b1', 'd1', arg), fetchLand('f1'));
    expect(ids(s)).toEqual(['b2']);
    expect(s.boardEdits).toEqual({}); // nothing left in flight
    // A fetch that starts after the delete is trusted again.
    expect(ids(run(s, fetchStart('f2'), fetchLand('f2')))).toEqual(['b1', 'b2']);
  });

  it('removes an archived board and restores an unarchived one', () => {
    const archived = { ...b1, state: 'ARCHIVED' } as Board;
    let s = run(loaded(), fetchStart('f1'), archiveBoardThunk.pending('a1', arg), archiveBoardThunk.fulfilled(archived, 'a1', arg));
    expect(ids(s)).toEqual(['b2']);
    s = run(s, fetchLand('f1')); // older fetch still lists it as ACTIVE
    expect(ids(s)).toEqual(['b2']);
    s = run(s, archiveBoardThunk.pending('a2', arg), archiveBoardThunk.fulfilled(b1, 'a2', arg));
    expect(ids(s)).toEqual(['b2', 'b1']);
  });

  it('inserts a created board, stamped with the workspace it was created in', () => {
    const create = { workspaceId: 'w3', title: 'new' };
    let s = run(loaded(), fetchStart('f1'), createBoardThunk.pending('c1', create), createBoardThunk.fulfilled(raw('b3'), 'c1', create));
    expect(s.boards.find((b) => b.id === 'b3')?.workspaceId).toBe('w3');
    s = run(s, fetchLand('f1')); // older fetch does not know it yet
    expect(ids(s)).toEqual(['b1', 'b2', 'b3']);
  });

  it('inserts a duplicate into its source board’s workspace, and skips a non-ACTIVE one', () => {
    const s = run(loaded(), duplicateBoardThunk.pending('u1', arg), duplicateBoardThunk.fulfilled(raw('b3'), 'u1', arg));
    expect(s.boards.find((b) => b.id === 'b3')?.workspaceId).toBe('w1');
    const t = run(loaded(), duplicateBoardThunk.pending('u2', arg), duplicateBoardThunk.fulfilled(raw('b4', 'ARCHIVED'), 'u2', arg));
    expect(ids(t)).toEqual(['b1', 'b2']);
  });

  it('applies a list-page star/unstar, and an older fetch does not revert it', () => {
    let s = run(loaded(), fetchStart('f1'), starBoardThunk.pending('s1', arg), starBoardThunk.fulfilled('b1', 's1', arg));
    expect(s.boards[0]?.isStarred).toBe(true);
    s = run(s, fetchLand('f1')); // read before the star
    expect(s.boards[0]?.isStarred).toBe(true);
    s = run(s, unstarBoardThunk.pending('s2', arg), unstarBoardThunk.fulfilled('b1', 's2', arg));
    expect(s.boards[0]?.isStarred).toBe(false);
    // The switcher's own next toggle starts a fresh, unambiguous burst.
    s = run(s, toggleSwitcherStarThunk.pending('t1', { boardId: 'b1', starred: true }));
    expect(s.starMutations.b1?.burstSize).toBe(1);
  });

  it('leaves a list-page star to the switcher’s reconcile while its own toggle is out', () => {
    const toggle = { boardId: 'b1', starred: true };
    let s = run(loaded(), toggleSwitcherStarThunk.pending('t1', toggle), unstarBoardThunk.pending('s1', arg), unstarBoardThunk.fulfilled('b1', 's1', arg));
    expect(s.boards[0]?.isStarred).toBe(true);
    s = run(s, toggleSwitcherStarThunk.fulfilled(undefined, 't1', toggle));
    expect(s.starMutations.b1?.burstSize).toBe(2); // → starNeedsReconcile re-reads the server
  });

  it('ignores a previous account’s list-page star or create settling after logout', () => {
    const create = { workspaceId: 'w1', title: 'x' };
    const s = run(
      loaded(),
      starBoardThunk.pending('s1', arg),
      createBoardThunk.pending('c1', create),
      logoutThunk.pending('lo'),
      fetchStart('f1'),
      fetchLand('f1'),
      starBoardThunk.fulfilled('b1', 's1', arg),
      createBoardThunk.fulfilled(raw('b3'), 'c1', create),
    );
    expect(s.boards[0]?.isStarred).toBe(false);
    expect(ids(s)).toEqual(['b1', 'b2']);
  });

  it('patches the open board’s title and background, also against an older fetch', () => {
    let s = run(loaded(), fetchStart('f1'), patchSwitcherBoard({ id: 'b1', title: 'Renamed', background: '/bg.png', state: 'ACTIVE' }));
    s = run(s, fetchLand('f1'));
    expect(s.boards[0]).toMatchObject({ title: 'Renamed', background: '/bg.png' });
  });

  it('drops the open board once BoardPage archived it', () => {
    const s = run(loaded(), patchSwitcherBoard({ id: 'b1', title: 'Framework', background: null, state: 'ARCHIVED' }));
    expect(ids(s)).toEqual(['b2']);
  });

  it('keeps a board archived before the first fetch landed out of that fetch', () => {
    const s = run(
      undefined,
      fetchStart('f1'),
      patchSwitcherBoard({ id: 'b1', title: 'Framework', background: null, state: 'ARCHIVED' }),
      fetchLand('f1'),
    );
    expect(ids(s)).toEqual(['b2']);
  });
});
