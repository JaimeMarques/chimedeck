import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';

const apiCallMock = mock();

void mock.module('../apiClient', () => ({
  apiCall: apiCallMock,
}));

type MoveCardArgs = {
  cardId: string;
  targetListId: string;
  afterCardId?: string | null;
  position?: number;
};

type ToolHandler = (args: MoveCardArgs) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

let toolName = '';
let toolDescription = '';
let handler: ToolHandler | undefined;

const server = {
  tool: (
    name: string,
    description: string,
    inputSchema: unknown,
    registeredHandler: ToolHandler
  ) => {
    toolName = name;
    toolDescription = description;
    handler = registeredHandler;
    void inputSchema;
  },
  registerTool: (
    name: string,
    config: { description: string; inputSchema: unknown },
    registeredHandler: ToolHandler
  ) => {
    toolName = name;
    toolDescription = config.description;
    handler = registeredHandler;
  },
};

const { registerMoveCard } = await import('./moveCard');

function registeredHandler(): ToolHandler {
  if (!handler) throw new Error('move_card handler was not registered');
  return handler;
}

describe('registerMoveCard', () => {
  beforeEach(() => {
    toolName = '';
    toolDescription = '';
    handler = undefined;
    apiCallMock.mockReset();
  });

  test('registers move_card and sends the destination and insertion card', async () => {
    apiCallMock.mockImplementation(({ path }: { path: string }) =>
      Promise.resolve({
        data: path.includes('/lists/')
          ? { data: [{ id: 'card-0' }, { id: 'card-1' }] }
          : { data: { id: path.includes('card-0') ? 'card-0' : 'card-1', list_id: 'list-2' } },
      })
    );
    registerMoveCard(server as never, 'token-1');

    expect(toolName).toBe('move_card');
    expect(toolDescription).toContain('Move a card');

    const result = await registeredHandler()({
      cardId: 'card-1',
      targetListId: 'list-2',
      afterCardId: 'card-0',
    });

    expect(apiCallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'PATCH',
        path: '/api/v1/cards/card-1/move',
        body: { targetListId: 'list-2', afterCardId: 'card-0' },
        token: 'token-1',
      })
    );
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            id: 'card-1',
            observed: { list_id: 'list-2', after_card_id: 'card-0' },
            verified: true,
            verified_fields: ['list_id', 'ordering'],
          }),
        },
      ],
    });
  });

  test('maps the supported legacy top position to a null insertion card', async () => {
    apiCallMock.mockResolvedValue({ data: { data: { id: 'card-1' } } });
    registerMoveCard(server as never, 'token-1');

    await registeredHandler()({ cardId: 'card-1', targetListId: 'list-2', position: 0 });

    expect(apiCallMock).toHaveBeenCalledWith({
      method: 'PATCH',
      path: '/api/v1/cards/card-1/move',
      body: { targetListId: 'list-2', afterCardId: null },
      token: 'token-1',
    });
  });

  test('omits insertion for the native bottom default and verifies final order', async () => {
    apiCallMock.mockImplementation(({ path }: { path: string }) =>
      Promise.resolve({
        data: path.includes('/lists/')
          ? { data: [{ id: 'other' }, { id: 'card-1' }] }
          : { data: { id: 'card-1', list_id: 'list-2' } },
      })
    );
    registerMoveCard(server as never, 'token-1');
    const result = await registeredHandler()({ cardId: 'card-1', targetListId: 'list-2' });
    const patch: unknown = apiCallMock.mock.calls.find(
      ([args]: unknown[]) =>
        z.object({ method: z.string().optional() }).parse(args).method === 'PATCH'
    )?.[0];
    const body = z.object({ body: z.record(z.string(), z.unknown()) }).parse(patch).body;
    expect(JSON.parse(JSON.stringify(body))).toEqual({ targetListId: 'list-2' });
    expect(JSON.parse(result.content[0]?.text ?? 'null') as unknown).toMatchObject({
      verified: true,
      observed: { after_card_id: 'other' },
    });
  });

  test('explicit null places at top while a misplaced bottom default fails verification', async () => {
    apiCallMock.mockImplementation(({ path }: { path: string }) =>
      Promise.resolve({
        data: path.includes('/lists/')
          ? { data: [{ id: 'card-1' }, { id: 'other' }] }
          : { data: { id: 'card-1', list_id: 'list-2' } },
      })
    );
    registerMoveCard(server as never, 'token-1');
    const top = await registeredHandler()({
      cardId: 'card-1',
      targetListId: 'list-2',
      afterCardId: null,
    });
    expect(
      z.object({ verified: z.boolean() }).parse(JSON.parse(top.content[0]?.text ?? 'null')).verified
    ).toBe(true);
    const bottom = await registeredHandler()({ cardId: 'card-1', targetListId: 'list-2' });
    expect(JSON.parse(bottom.content[0]?.text ?? 'null') as unknown).toMatchObject({
      verified: false,
      verification_error: { code: 'readback-mismatch' },
    });
  });

  test('rejects unsupported legacy positions without calling the API', async () => {
    registerMoveCard(server as never, 'token-1');

    const result = await registeredHandler()({
      cardId: 'card-1',
      targetListId: 'list-2',
      position: 2,
    });

    expect(apiCallMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      content: [{ type: 'text', text: 'Error: bad-request' }],
      isError: true,
    });
  });
});
