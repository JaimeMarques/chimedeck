import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { z } from 'zod';

const apiCallMock = mock();

void mock.module('../apiClient', () => ({ apiCall: apiCallMock }));

type ToolHandler = (args: {
  boardId: string;
  email: string;
  role?: 'member' | 'admin';
}) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

let toolName = '';
let toolDescription = '';
let inputSchema: Record<string, z.ZodType> | undefined;
let handler: ToolHandler | undefined;

const server = {
  registerTool: (
    name: string,
    config: { description: string; inputSchema: Record<string, z.ZodType> },
    registeredHandler: ToolHandler,
  ) => {
    toolName = name;
    toolDescription = config.description;
    inputSchema = config.inputSchema;
    handler = registeredHandler;
  },
};

const { registerInviteToBoard } = await import('./inviteToBoard');

describe('registerInviteToBoard', () => {
  beforeEach(() => {
    toolName = '';
    toolDescription = '';
    inputSchema = undefined;
    handler = undefined;
    apiCallMock.mockReset();
  });

  test('registers the stable invite_to_board tool contract', () => {
    registerInviteToBoard(server as never, 'token-1');

    expect(toolName).toBe('invite_to_board');
    expect(toolDescription).toBe('Invite a user to a board by email. Requires the token holder to be a board admin.');
    expect(handler).toBeDefined();
  });

  test('uses the non-deprecated email schema', () => {
    registerInviteToBoard(server as never, 'token-1');

    const emailSchema = inputSchema?.email;
    if (!emailSchema) throw new Error('invite_to_board email schema was not registered');
    expect(emailSchema.safeParse('not-an-email').success).toBeFalse();
  });

  test('posts the email with the authenticated MCP token to the board members endpoint', async () => {
    apiCallMock.mockResolvedValue({ data: { data: { id: 'user-1', role: 'MEMBER' } } });
    registerInviteToBoard(server as never, 'token-abc');
    if (!handler) throw new Error('invite_to_board did not register a handler');

    const result = await handler({ boardId: 'board-1', email: 'person@example.com', role: 'member' });

    expect(apiCallMock).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/v1/boards/board-1/members',
      body: { email: 'person@example.com', role: 'member' },
      token: 'token-abc',
    });
    expect(result.isError).toBeUndefined();
  });

  test('advertises only roles board membership can store', () => {
    registerInviteToBoard(server as never, 'token-abc');
    const roleSchema = inputSchema?.role;
    if (!roleSchema) throw new Error('invite_to_board did not advertise role options');
    expect(roleSchema.safeParse('member').success).toBeTrue();
    expect(roleSchema.safeParse('admin').success).toBeTrue();
    expect(roleSchema.safeParse('observer').success).toBeFalse();
  });

  test('surfaces a structured API error without throwing', async () => {
    apiCallMock.mockResolvedValue({ error: { name: 'current-user-is-not-admin' } });
    registerInviteToBoard(server as never, 'token-abc');
    if (!handler) throw new Error('invite_to_board did not register a handler');

    const result = await handler({ boardId: 'board-1', email: 'person@example.com' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('current-user-is-not-admin');
  });
});
