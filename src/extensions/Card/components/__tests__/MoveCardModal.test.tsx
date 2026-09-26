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
const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const { default: MoveCardModal } = await import('../MoveCardModal');

afterEach(() => {
  cleanup();
});

describe('MoveCardModal', () => {
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
