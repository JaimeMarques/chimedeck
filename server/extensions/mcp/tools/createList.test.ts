import { beforeEach, describe, expect, mock, test } from 'bun:test';

const apiCallMock = mock();

void mock.module('../apiClient', () => ({
  apiCall: apiCallMock,
}));

type ToolHandler = (args: { boardId: string; title: string; afterId?: string | null }) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

let toolName = '';
let toolDescription = '';
let handler: ToolHandler | undefined;

const server = {
  registerTool: (name: string, config: { description: string }, registeredHandler: ToolHandler) => {
    toolName = name;
    toolDescription = config.description;
    handler = registeredHandler;
  },
};

function registered() {
  if (!handler) throw new Error('Missing handler');
  return handler;
}

const { registerCreateList } = await import('./createList');

describe('registerCreateList', () => {
  beforeEach(() => {
    toolName = '';
    toolDescription = '';
    handler = undefined;
    apiCallMock.mockReset();
  });

  test('registers create_list and posts a list title to its board endpoint', async () => {
    apiCallMock.mockImplementation(({ method }: { method: string }) =>
      Promise.resolve({
        data: {
          data:
            method === 'GET'
              ? [
                  {
                    id: 'list-1',
                    board_id: '11111111-1111-4111-8111-111111111111',
                    title: 'Backlog',
                  },
                ]
              : { id: 'list-1' },
        },
      })
    );

    registerCreateList(server as never, 'token-1');

    expect(toolName).toBe('create_list');
    expect(toolDescription).toContain('list');
    expect(handler).toBeDefined();

    const result = await registered()({
      boardId: '11111111-1111-4111-8111-111111111111',
      title: 'Backlog',
    });

    expect(apiCallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        path: '/api/v1/boards/11111111-1111-4111-8111-111111111111/lists',
        body: { title: 'Backlog', afterId: undefined },
        token: 'token-1',
      })
    );
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            id: 'list-1',
            observed: {},
            verified: true,
            verified_fields: ['board_id', 'title'],
            list: {
              id: 'list-1',
              board_id: '11111111-1111-4111-8111-111111111111',
              title: 'Backlog',
            },
            request_outcome: 'succeeded',
          }),
        },
      ],
    });
  });

  test('returns a structured MCP error when list creation is rejected', async () => {
    apiCallMock.mockResolvedValue({ error: { name: 'forbidden' } });
    registerCreateList(server as never, 'token-1');

    const result = await registered()({
      boardId: '11111111-1111-4111-8111-111111111111',
      title: 'Backlog',
    });

    expect(result).toEqual({
      content: [{ type: 'text', text: 'Error: forbidden' }],
      isError: true,
    });
  });
});
