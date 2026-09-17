import { beforeEach, describe, expect, mock, test } from 'bun:test';

const callMock = mock(async () => ({ data: { id: 'card-1', list_id: 'list-on-another-board' } }));
const printMock = mock(() => undefined);

void mock.module('../apiClient', () => ({ call: callMock }));
void mock.module('../output', () => ({ print: printMock }));

const { runMoveCard } = await import('./moveCard');

beforeEach(() => {
  callMock.mockClear();
  printMock.mockClear();
});

describe('chimedeck move-card', () => {
  test('passes an arbitrary accessible destination list to the cross-board move API', async () => {
    await runMoveCard({
      argv: {
        card: 'card-1',
        list: 'list-on-another-board',
        after: 'card-before',
      },
      config: {
        apiUrl: 'https://chimedeck.test',
        token: 'token-1',
      },
      jsonMode: true,
    });

    expect(callMock).toHaveBeenCalledWith({
      config: {
        apiUrl: 'https://chimedeck.test',
        token: 'token-1',
      },
      method: 'PATCH',
      path: '/api/v1/cards/card-1/move',
      body: {
        targetListId: 'list-on-another-board',
        afterCardId: 'card-before',
      },
    });
    expect(printMock).toHaveBeenCalledTimes(1);
  });
});
