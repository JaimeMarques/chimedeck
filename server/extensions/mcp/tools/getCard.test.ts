import { beforeEach, describe, expect, mock, test } from 'bun:test';

const apiCallMock = mock();

void mock.module('../apiClient', () => ({
  apiCall: apiCallMock,
}));

type ToolHandler = (args: { cardId: string; include_activities?: boolean }) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

let toolName = '';
let toolDescription = '';
let handler: ToolHandler | undefined;

const server = {
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

const { registerGetCard } = await import('./getCard');

describe('registerGetCard', () => {
  beforeEach(() => {
    toolName = '';
    toolDescription = '';
    handler = undefined;
    apiCallMock.mockReset();
  });

  test('registers get_card and reads the requested card endpoint', async () => {
    apiCallMock.mockResolvedValue({ data: { data: { id: 'card-1', title: 'Demo card' } } });

    registerGetCard(server as never, 'token-1');

    expect(toolName).toBe('get_card');
    expect(toolDescription).toContain('card');

    const registeredHandler = handler;
    if (!registeredHandler) throw new Error('get_card handler was not registered');

    const result = await registeredHandler({ cardId: 'card-1' });

    expect(apiCallMock).toHaveBeenCalledWith({
      method: 'GET',
      path: '/api/v1/cards/card-1',
      token: 'token-1',
    });
    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ data: { id: 'card-1', title: 'Demo card' } }) }],
    });
  });

  test('requests activities only when include_activities is true', async () => {
    apiCallMock.mockResolvedValue({ data: { data: { id: 'card-1' }, includes: { activities: [] } } });
    registerGetCard(server as never, 'token-1');

    const registeredHandler = handler;
    if (!registeredHandler) throw new Error('get_card handler was not registered');

    await registeredHandler({ cardId: 'card-1', include_activities: true });
    await registeredHandler({ cardId: 'card-1', include_activities: false });

    expect(apiCallMock.mock.calls.map(([call]) => (call as { path: string }).path)).toEqual([
      '/api/v1/cards/card-1?include=activities',
      '/api/v1/cards/card-1',
    ]);
  });

  test('encodes the card ID so it cannot inject query parameters', async () => {
    apiCallMock.mockResolvedValue({ data: { data: { id: 'card-1' } } });
    registerGetCard(server as never, 'token-1');

    const registeredHandler = handler;
    if (!registeredHandler) throw new Error('get_card handler was not registered');

    await registeredHandler({ cardId: 'card-1?include=activities' });
    await registeredHandler({ cardId: '../boards/x', include_activities: true });

    expect(apiCallMock.mock.calls.map(([call]) => (call as { path: string }).path)).toEqual([
      '/api/v1/cards/card-1%3Finclude%3Dactivities',
      '/api/v1/cards/..%2Fboards%2Fx?include=activities',
    ]);
  });

  test('returns a structured MCP error when the card cannot be read', async () => {
    apiCallMock.mockResolvedValue({ error: { name: 'not_found' } });
    registerGetCard(server as never, 'token-1');

    const registeredHandler = handler;
    if (!registeredHandler) throw new Error('get_card handler was not registered');

    const result = await registeredHandler({ cardId: 'card-1' });

    expect(result).toEqual({
      content: [{ type: 'text', text: 'Error: not_found' }],
      isError: true,
    });
  });
});
