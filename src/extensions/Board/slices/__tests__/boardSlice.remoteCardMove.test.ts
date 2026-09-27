import { describe, expect, test } from 'bun:test';
import type { Card } from '../../../Card/api';
import type { List } from '../../../List/api';
import reducer, { boardSliceActions } from '../boardSlice';

const list = (id: string) => ({ id, title: id, archived: false }) as List;
const card = (id: string, listId: string, position: string) =>
  ({ id, title: id, list_id: listId, position }) as Card;

describe('remoteCardMove', () => {
  test('removes a departed cross-board card without creating a foreign destination list', () => {
    let state = reducer(undefined, boardSliceActions.addList({ list: list('source') }));
    state = reducer(state, boardSliceActions.addCard({ card: card('departing', 'source', 'a') }));
    state = reducer(state, boardSliceActions.addCard({ card: card('staying', 'source', 'b') }));

    state = reducer(state, boardSliceActions.remoteCardMove({
      card: card('departing', 'foreign-list', 'c'), fromListId: 'source',
    }));
    expect(state.cardsByList.source).toEqual(['staying']);
    expect(state.cardsByList['foreign-list']).toBeUndefined();
    expect(state.cards.departing).toBeUndefined();
    expect(state.cards.staying?.list_id).toBe('source');
  });

  test('places same-board incoming cards in sorted order and updates known cards', () => {
    let state = reducer(undefined, boardSliceActions.addList({ list: list('source') }));
    state = reducer(state, boardSliceActions.addList({ list: list('target') }));
    state = reducer(state, boardSliceActions.addCard({ card: card('later', 'target', 'z') }));
    state = reducer(state, boardSliceActions.addCard({ card: card('moving', 'source', 'a') }));

    state = reducer(state, boardSliceActions.remoteCardMove({
      card: card('moving', 'target', 'b'), fromListId: 'source',
    }));
    expect(state.cardsByList.source).toEqual([]);
    expect(state.cardsByList.target).toEqual(['moving', 'later']);
    expect(state.cards.moving?.list_id).toBe('target');

    state = reducer(state, boardSliceActions.remoteCardMove({
      card: card('incoming', 'target', 'c'), fromListId: 'foreign-list',
    }));
    expect(state.cardsByList.target).toEqual(['moving', 'incoming', 'later']);
    expect(state.cards.incoming?.list_id).toBe('target');
    expect(state.cardsByList['foreign-list']).toBeUndefined();
  });
});
