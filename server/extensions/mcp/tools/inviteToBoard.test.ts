import { beforeEach, describe, expect, mock, test } from 'bun:test';

const apiCallMock = mock();

void mock.module('../apiClient', () => ({
  apiCall: apiCallMock,
}));

type ToolHandler = (args: {
  boardId: string;
  email: string;
  role?: 'member' | 'admin';
}) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

type RoleSchema = { options?: unknown[]; _def?: { innerType?: { options?: unknown[] } } };

let toolName = '';
let schema: Record<string, RoleSchema> | undefined;
let handler: ToolHandler | undefined;

const server = {
  tool: (
    name: string,
    _description: string,
    registeredSchema: Record<string, RoleSchema>,
    registeredHandler: ToolHandler,
  ) => {
    toolName = name;
    schema = registeredSchema;
    handler = registeredHandler;
  },
};

const { registerInviteToBoard } = await import('./inviteToBoard');

describe('registerInviteToBoard', () => {
  beforeEach(() => {
    toolName = '';
    schema = undefined;
    handler = undefined;
    apiCallMock.mockReset();
  });

  test('registers invite_to_board and posts the email to the board members endpoint', async () => {
    apiCallMock.mockResolvedValue({ data: { data: { id: 'user-1', role: 'MEMBER' } } });

    registerInviteToBoard(server as never, 'token-abc');

    expect(toolName).toBe('invite_to_board');
    if (!handler) throw new Error('invite_to_board did not register a handler');

    const result = await handler({ boardId: 'board-1', email: 'person@example.com', role: 'member' });

    // The route identifies the target by email; sending userId-only would make
    // this tool unusable, which is the regression this test guards.
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

    const roleSchema = schema?.['role'];
    const options = (roleSchema?.options ?? roleSchema?._def?.innerType?.options) as
      | string[]
      | undefined;

    // 'observer' is not a board role — VALID_ROLES in members/create.ts holds
    // ADMIN and MEMBER only, so offering it produced a silent coercion.
    if (!options) throw new Error('invite_to_board did not advertise role options');
    expect([...options].sort()).toEqual(['admin', 'member']);
  });

  test('surfaces a structured API error without throwing', async () => {
    apiCallMock.mockResolvedValue({ error: { code: 'current-user-is-not-admin' } });

    registerInviteToBoard(server as never, 'token-abc');
    if (!handler) throw new Error('invite_to_board did not register a handler');
    const result = await handler({ boardId: 'board-1', email: 'person@example.com' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('current-user-is-not-admin');
  });
});
