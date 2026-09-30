import { describe, expect, test } from 'bun:test';
import { configureStore } from '@reduxjs/toolkit';
import type { AppDispatch } from '~/store';
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

  test('a live card update invalidates an older background snapshot', () => {
    let state = hydrated();
    state = reducer(state, fetchBoardDataThunk.pending('refresh', arg));
    state = reducer(state, boardSliceActions.updateCard({
      card: { id: 'c1', list_id: 'l1', position: 'a', title: 'Remote new title' } as Card,
    }));
    state = reducer(state, fetchBoardDataThunk.fulfilled(snapshot(), 'refresh', arg));
    expect(state.cards.c1?.title).toBe('Remote new title');
    expect(state.appliedSnapshotRequestId).not.toBe('refresh');
    expect(state.status).toBe('idle');
  });

  test('background recovery cannot supersede an in-flight foreground board load', async () => {
    let finish: ((response: ReturnType<typeof snapshot>) => void) | undefined;
    const store = configureStore({
      reducer: { board: reducer },
      preloadedState: { board: hydrated() },
      middleware: (defaults) => defaults({ thunk: { extraArgument: { api: {
        get: () => new Promise<ReturnType<typeof snapshot>>((resolve) => { finish = resolve; }),
      } } } }),
    });
    const dispatch = store.dispatch as unknown as AppDispatch;
    const foreground = dispatch(fetchBoardDataThunk({ boardId: 'b2' }));
    const background = await dispatch(fetchBoardDataThunk({ boardId: 'b2', background: true }));
    expect(fetchBoardDataThunk.rejected.match(background) && background.meta.condition).toBe(true);
    expect(store.getState().board.fetchRequestId).toBe(foreground.requestId);
    finish?.(snapshot('b2'));
    await foreground;
    expect(store.getState().board.board?.id).toBe('b2');
    expect(store.getState().board.status).toBe('idle');
  });

  test('background fetch requests complete membership and retains cards beyond the first page', async () => {
    const allCards = Array.from({ length: 75 }, (_, index) => ({
      id: `card-${String(index)}`, title: 'Card', list_id: 'l1', position: String(index), archived: false,
    }) as Card);
    let requestedUrl = '';
    const response = { data: { id: 'b1' } as Board, includes: { lists, cards: allCards } };
    const store = configureStore({
      reducer: { board: reducer },
      preloadedState: { board: hydrated() },
      middleware: (defaults) => defaults({ thunk: { extraArgument: { api: {
        get: (url: string) => { requestedUrl = url; return Promise.resolve(response); },
      } } } }),
    });
    const dispatch = store.dispatch as unknown as AppDispatch;
    await dispatch(fetchBoardDataThunk({ ...arg, initialCardsPerList: 25 }));
    expect(requestedUrl).not.toContain('initialCardsPerList');
    expect(store.getState().board.cardsByList.l1).toHaveLength(75);
    expect(store.getState().board.listHydration.l1?.hasMore).toBe(false);
    expect(store.getState().board.listHydration.l1?.nextOffset).toBeNull();
  });

  test('active drag defers recovery and a drag started during GET invalidates its snapshot', async () => {
    let state = hydrated();
    state = reducer(state, fetchBoardDataThunk.pending('refresh', arg));
    state = reducer(state, boardSliceActions.saveDragSnapshot());
    state = reducer(state, fetchBoardDataThunk.fulfilled(snapshot('wrong'), 'refresh', arg));
    expect(state.board?.id).toBe('b1');
    let calls = 0;
    const store = configureStore({
      reducer: { board: reducer }, preloadedState: { board: state },
      middleware: (defaults) => defaults({ thunk: { extraArgument: { api: {
        get: () => { calls++; return Promise.resolve(snapshot()); },
      } } } }),
    });
    const dispatch = store.dispatch as unknown as AppDispatch;
    const result = await dispatch(fetchBoardDataThunk(arg));
    expect(fetchBoardDataThunk.rejected.match(result) && result.meta.condition).toBe(true);
    expect(calls).toBe(0);
    store.dispatch(boardSliceActions.clearDragSnapshot());
    await dispatch(fetchBoardDataThunk(arg));
    expect(calls).toBe(1);
  });
});
