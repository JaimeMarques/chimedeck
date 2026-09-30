import { describe, expect, test } from 'bun:test';
import type { Board } from '../../api';
import type { List } from '../../../List/api';
import type { Card } from '../../../Card/api';
import reducer, { boardSliceActions, fetchBoardDataThunk, fetchListCardsBatchThunk } from '../boardSlice';

const lists = ['l1', 'l2'].map((id, index) => ({ id, title: id, position: String(index), archived: false }) as List);
const cards = lists.map((list, index) => ({ id: `c${String(index + 1)}`, title: 'Card', list_id: list.id, position: 'a', archived: false }) as Card);
const snapshot = (id = 'b1') => ({ data: { id } as Board, includes: { lists, cards } });
const arg = { boardId: 'b1', background: true };
function hydrated() {
  let state = reducer(undefined, fetchBoardDataThunk.pending('initial', arg));
  state = reducer(state, fetchBoardDataThunk.fulfilled(snapshot(), 'initial', arg));
  return state;
}

describe('board reconnect snapshots', () => {
  test('replaying every list creation retains all visible card memberships', () => {
    let state = hydrated();
    for (const list of lists) state = reducer(state, boardSliceActions.addList({ list }));
    expect(state.cardsByList).toEqual({ l1: ['c1'], l2: ['c2'] });
    expect(state.listOrder).toEqual(['l1', 'l2']);
    expect(Object.keys(state.cards)).toEqual(['c1', 'c2']);
  });

  test('background failure keeps the last successful board visible', () => {
    let state = hydrated();
    state = reducer(state, fetchBoardDataThunk.pending('refresh', arg));
    expect(state.status).toBe('idle');
    state = reducer(state, fetchBoardDataThunk.rejected(new Error('offline'), 'refresh', arg));
    expect(state.status).toBe('idle');
    expect(state.cardsByList).toEqual({ l1: ['c1'], l2: ['c2'] });
  });

  test('reconnection restores authoritative membership and ignores late hydration', () => {
    let state = hydrated();
    const batchArg = { listId: 'l1', offset: 50 };
    state = reducer(state, fetchListCardsBatchThunk.pending('batch', batchArg));
    state = reducer(state, boardSliceActions.removeCard({ cardId: 'c1', listId: 'l1' }));
    state = reducer(state, fetchBoardDataThunk.pending('refresh', arg));
    state = reducer(state, fetchBoardDataThunk.fulfilled(snapshot(), 'refresh', arg));
    state = reducer(state, fetchListCardsBatchThunk.fulfilled({
      listId: 'l1', data: [{ id: 'stale', title: 'Stale', list_id: 'l1', position: 'z' } as Card],
      metadata: { total: 3, limit: 50, offset: 50, hasMore: false, nextOffset: null },
    }, 'batch', batchArg));
    expect(state.cardsByList).toEqual({ l1: ['c1'], l2: ['c2'] });
    expect(state.cards.stale).toBeUndefined();
  });

  test('navigation supersedes the old board request before either response completes', () => {
    let state = hydrated();
    state = reducer(state, fetchBoardDataThunk.pending('old', arg));
    const nextArg = { boardId: 'b2' };
    state = reducer(state, fetchBoardDataThunk.pending('next', nextArg));
    state = reducer(state, fetchBoardDataThunk.fulfilled(snapshot('b1'), 'old', arg));
    expect(state.status).toBe('loading');
    state = reducer(state, fetchBoardDataThunk.fulfilled(snapshot('b2'), 'next', nextArg));
    expect(state.board?.id).toBe('b2');
    state = reducer(state, fetchBoardDataThunk.fulfilled(snapshot('b1'), 'old', arg));
    expect(state.board?.id).toBe('b2');
  });
});
