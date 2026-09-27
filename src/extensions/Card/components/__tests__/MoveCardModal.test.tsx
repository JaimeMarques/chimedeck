import { afterEach, describe, expect, mock, test } from 'bun:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://chimedeck.test/workspaces/ws-1/boards/board-source',
});
const jsdomWindow = dom.window;
const GLOBAL_KEYS = [
  'window',
  'document',
  'location',
  'navigator',
  'Node',
  'NodeFilter',
  'Element',
  'HTMLElement',
  'HTMLButtonElement',
  'HTMLInputElement',
  'HTMLSelectElement',
  'HTMLTextAreaElement',
  'SVGElement',
  'DocumentFragment',
  'Text',
  'Event',
  'CustomEvent',
  'KeyboardEvent',
  'MouseEvent',
  'MutationObserver',
  'getComputedStyle',
] as const;

for (const key of GLOBAL_KEYS) {
  const value = key === 'window'
    ? jsdomWindow
    : (jsdomWindow as unknown as Record<string, unknown>)[key];
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
}
Object.defineProperty(globalThis, 'requestAnimationFrame', {
  value: (callback: FrameRequestCallback) => setTimeout(() => {
    callback(Date.now());
  }, 0),
  writable: true,
  configurable: true,
});
Object.defineProperty(globalThis, 'cancelAnimationFrame', {
  value: (id: number) => {
    clearTimeout(id);
  },
  writable: true,
  configurable: true,
});

const React = (await import('react')).default;
const { act, cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const { default: MoveCardModal } = await import('../MoveCardModal');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

afterEach(() => {
  cleanup();
});

describe('MoveCardModal', () => {
  test('invalidates the old destination immediately while a different board loads', async () => {
    const targetLists = deferred<unknown>();
    const targetBoard = deferred<unknown>();
    const patchMock = mock((_url: string, _data: unknown) => Promise.resolve({ data: {} }));
    const api = {
      get: <T,>(url: string): Promise<T> => {
        const responses: Record<string, unknown> = {
          '/workspaces/ws-1/boards': { data: [
            { id: 'board-source', title: 'Source board', state: 'ACTIVE' },
            { id: 'board-target', title: 'Target board', state: 'ACTIVE' },
          ] },
          '/boards/board-source/lists': { data: [{ id: 'list-source', title: 'Source list', archived: false }] },
          '/boards/board-source': { data: {}, includes: { cards: [] } },
          '/boards/board-target/lists': targetLists.promise,
          '/boards/board-target': targetBoard.promise,
        };
        return Promise.resolve(responses[url] as T);
      },
      patch: <T,>(url: string, data: unknown): Promise<T> => patchMock(url, data) as Promise<T>,
    };
    const view = render(React.createElement(MoveCardModal, {
      cardId: 'card-1', currentBoardId: 'board-source', currentListId: 'list-source',
      workspaceId: 'ws-1', api, onClose: () => undefined, onSuccess: () => undefined,
    }));
    const list = view.getByLabelText('List') as HTMLSelectElement;
    const move = view.getByRole('button', { name: 'Move' }) as HTMLButtonElement;
    await waitFor(() => { expect(list.value).toBe('list-source'); expect(move.disabled).toBe(false); });

    fireEvent.change(view.getByLabelText('Board'), { target: { value: 'board-target' } });
    expect(list.value).toBe('');
    expect(list.options.length).toBe(0);
    expect(move.disabled).toBe(true);
    fireEvent.click(move);
    expect(patchMock).not.toHaveBeenCalled();

    await act(async () => {
      targetLists.resolve({ data: [{ id: 'list-target', title: 'Target list', archived: false }] });
      await targetLists.promise;
    });
    expect(move.disabled).toBe(true);
    await act(async () => {
      targetBoard.resolve({ data: {}, includes: { cards: [] } });
      await targetBoard.promise;
    });
    expect(list.value).toBe('list-target');
    expect(move.disabled).toBe(false);
  });

  test('ignores a late board response after the user returns to the source board', async () => {
    const targetLists = deferred<unknown>();
    const targetBoard = deferred<unknown>();
    const api = {
      get: <T,>(url: string): Promise<T> => Promise.resolve(({
        '/workspaces/ws-1/boards': { data: [
          { id: 'board-source', title: 'Source board', state: 'ACTIVE' },
          { id: 'board-target', title: 'Target board', state: 'ACTIVE' },
        ] },
        '/boards/board-source/lists': { data: [{ id: 'list-source', title: 'Source list', archived: false }] },
        '/boards/board-source': { data: {}, includes: { cards: [] } },
        '/boards/board-target/lists': targetLists.promise,
        '/boards/board-target': targetBoard.promise,
      } as Record<string, unknown>)[url] as T),
      patch: <T,>(_url: string, _data: unknown): Promise<T> => Promise.resolve({ data: {} } as T),
    };
    const view = render(React.createElement(MoveCardModal, {
      cardId: 'card-1', currentBoardId: 'board-source', currentListId: 'list-source',
      workspaceId: 'ws-1', api, onClose: () => undefined, onSuccess: () => undefined,
    }));
    const board = view.getByLabelText('Board') as HTMLSelectElement;
    const list = view.getByLabelText('List') as HTMLSelectElement;
    const move = view.getByRole('button', { name: 'Move' }) as HTMLButtonElement;
    await waitFor(() => { expect(move.disabled).toBe(false); });
    fireEvent.change(board, { target: { value: 'board-target' } });
    fireEvent.change(board, { target: { value: 'board-source' } });
    await waitFor(() => { expect(list.value).toBe('list-source'); expect(move.disabled).toBe(false); });

    await act(async () => {
      targetLists.resolve({ data: [{ id: 'list-target', title: 'Target list', archived: false }] });
      targetBoard.resolve({ data: {}, includes: { cards: [] } });
      await Promise.all([targetLists.promise, targetBoard.promise]);
    });
    expect(board.value).toBe('board-source');
    expect(Array.from(list.options).map((option) => option.value)).toEqual(['list-source']);
    expect(list.value).toBe('list-source');
    expect(move.disabled).toBe(false);
  });

  test('keeps the latest list and its position when list card requests finish out of order', async () => {
    const firstListCards = deferred<unknown>();
    const secondListCards = deferred<unknown>();
    let boardReads = 0;
    const patchMock = mock((_url: string, _data: unknown) => Promise.resolve({ data: {} }));
    const api = {
      get: <T,>(url: string): Promise<T> => {
        if (url === '/workspaces/ws-1/boards') return Promise.resolve({ data: [
          { id: 'board-source', title: 'Source board', state: 'ACTIVE' },
        ] } as T);
        if (url === '/boards/board-source/lists') return Promise.resolve({ data: [
          { id: 'list-source', title: 'Source list', archived: false },
          { id: 'list-b', title: 'List B', archived: false },
          { id: 'list-c', title: 'List C', archived: false },
        ] } as T);
        if (url === '/boards/board-source') {
          boardReads++;
          return Promise.resolve((boardReads === 1
            ? { data: {}, includes: { cards: [] } }
            : boardReads === 2 ? firstListCards.promise : secondListCards.promise) as T);
        }
        throw new Error(`Unexpected GET ${url}`);
      },
      patch: <T,>(url: string, data: unknown): Promise<T> => patchMock(url, data) as Promise<T>,
    };
    const view = render(React.createElement(MoveCardModal, {
      cardId: 'card-1', currentBoardId: 'board-source', currentListId: 'list-source',
      workspaceId: 'ws-1', api, onClose: () => undefined, onSuccess: () => undefined,
    }));
    const list = view.getByLabelText('List') as HTMLSelectElement;
    const position = view.getByLabelText('Position') as HTMLSelectElement;
    const move = view.getByRole('button', { name: 'Move' }) as HTMLButtonElement;
    await waitFor(() => { expect(list.value).toBe('list-source'); expect(move.disabled).toBe(false); });

    fireEvent.change(list, { target: { value: 'list-b' } });
    expect(move.disabled).toBe(true);
    expect(list.disabled).toBe(false);
    fireEvent.change(list, { target: { value: 'list-c' } });
    await act(async () => {
      secondListCards.resolve({ data: {}, includes: { cards: [
        { id: 'card-c1', list_id: 'list-c', archived: false },
        { id: 'card-c2', list_id: 'list-c', archived: false },
      ] } });
      await secondListCards.promise;
    });
    await act(async () => {
      firstListCards.resolve({ data: {}, includes: { cards: [
        { id: 'card-b1', list_id: 'list-b', archived: false },
      ] } });
      await firstListCards.promise;
    });
    expect(list.value).toBe('list-c');
    expect(position.value).toBe('3');
    expect(move.disabled).toBe(false);
    fireEvent.click(move);
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('/cards/card-1/move', {
        targetListId: 'list-c', afterCardId: 'card-c2',
      });
    });
  });

  test('shows active same-workspace destinations and submits board/list/position as a move request', async () => {
    const getMock = mock((url: string): unknown => {
      switch (url) {
        case '/workspaces/ws-1/boards':
          return {
            data: [
              { id: 'board-source', title: 'Source board', state: 'ACTIVE' },
              { id: 'board-target', title: 'Target board', state: 'ACTIVE' },
              { id: 'board-archived', title: 'Archived board', state: 'ARCHIVED' },
            ],
          };
        case '/boards/board-source/lists':
          return { data: [{ id: 'list-source', title: 'Source list', archived: false }] };
        case '/boards/board-source':
          return { data: { id: 'board-source' }, includes: { cards: [] } };
        case '/boards/board-target/lists':
          return {
            data: [
              { id: 'list-target', title: 'Target list', archived: false },
              { id: 'list-archived', title: 'Archived list', archived: true },
            ],
          };
        case '/boards/board-target':
          return {
            data: { id: 'board-target' },
            includes: {
              cards: [{ id: 'card-before', list_id: 'list-target', archived: false }],
            },
          };
        default:
          throw new Error(`Unexpected GET ${url}`);
      }
    });
    const movedCard = { id: 'card-1', list_id: 'list-target', title: 'Card' };
    const patchMock = mock((_url: string, _data: unknown): unknown => ({ data: movedCard }));
    const api = {
      get: <T,>(url: string): Promise<T> => Promise.resolve(getMock(url) as T),
      patch: <T,>(url: string, data: unknown): Promise<T> => Promise.resolve(patchMock(url, data) as T),
    };
    const onSuccess = mock(() => undefined);

    const view = render(React.createElement(MoveCardModal, {
      cardId: 'card-1',
      currentBoardId: 'board-source',
      currentListId: 'list-source',
      workspaceId: 'ws-1',
      api,
      onClose: () => undefined,
      onSuccess,
    }));

    expect(view.getByText('Select destination')).toBeTruthy();
    expect(view.getByLabelText('Board')).toBeTruthy();
    expect(view.getByLabelText('List')).toBeTruthy();
    expect(view.getByLabelText('Position')).toBeTruthy();

    const boardSelect = view.getByLabelText('Board') as HTMLSelectElement;
    await waitFor(() => {
      expect(Array.from(boardSelect.options).map((option) => option.text)).toEqual([
        'Source board',
        'Target board',
      ]);
    });

    fireEvent.change(boardSelect, { target: { value: 'board-target' } });

    const listSelect = view.getByLabelText('List') as HTMLSelectElement;
    await waitFor(() => {
      expect(Array.from(listSelect.options).map((option) => option.text)).toEqual(['Target list']);
      expect(listSelect.value).toBe('list-target');
    });

    const positionSelect = view.getByLabelText('Position') as HTMLSelectElement;
    await waitFor(() => {
      expect(Array.from(positionSelect.options).map((option) => option.text)).toEqual(['1', '2']);
      expect(positionSelect.value).toBe('2');
    });

    fireEvent.click(view.getByRole('button', { name: 'Move' }));

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('/cards/card-1/move', {
        targetListId: 'list-target',
        afterCardId: 'card-before',
      });
      expect(onSuccess).toHaveBeenCalledWith(movedCard);
    });
  });
});
