import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ToolError, apiPath, dataOf, deleteNoContent, findRow, readCard, request, rowWithId, rowsOf, runTool,
} from './toolSupport';

// Card assignees and board membership. Names, arguments and read-backs mirror
// the local Python server (chimedeck_mcp/tools.py, "Extensions: members").

const cardId = z.string().min(1).describe('ID of the card');
const boardId = z.string().min(1).describe('ID of the board');
const written = dataOf(z.looseObject({}));
const memberRow = z.looseObject({ user_id: z.string().min(1), role: z.string() });
// [why] The server only knows ADMIN and MEMBER (board/api/members/role.ts);
// Python's "observer" is rejected there, so it is not offered here.
const role = z.enum(['admin', 'member']);

// Card read-back that must show the user assigned (or unassigned).
async function cardWithMember(id: string, userId: string, assigned: boolean, token: string) {
  const card = await readCard(id, token);
  const members = z.array(rowWithId).safeParse(card.includes?.members);
  if (!members.success) throw new ToolError('invalid-response');
  if (members.data.some((member) => member.id === userId) !== assigned) throw new ToolError('readback-failed');
  return card;
}

export function registerMemberTools(server: McpServer, token: string): void {
  // Board roster read-back; the member must hold the expected role.
  const boardMember = async (board: string, userId: string, expected: string) => {
    const { data } = await request({ path: apiPath`/api/v1/boards/${board}/members`, token, schema: rowsOf(memberRow) });
    const member = findRow(data, 'user_id', userId);
    if (member.role.toUpperCase() !== expected) throw new ToolError('readback-failed');
    return member;
  };

  server.registerTool('add_card_member', {
    description: 'Assign a board member to a card. Returns the card with its includes.',
    inputSchema: { cardId, userId: z.string().min(1).describe('User ID (see list_board_members)') },
  }, (args) => runTool(token, async () => {
    await request({
      method: 'POST', path: apiPath`/api/v1/cards/${args.cardId}/members`,
      body: { userId: args.userId }, token, schema: written,
    });
    return cardWithMember(args.cardId, args.userId, true, token);
  }));

  server.registerTool('remove_card_member', {
    description: 'Unassign a member from a card. Returns the card with its includes.',
    inputSchema: { cardId, userId: z.string().min(1).describe('User ID') },
  }, (args) => runTool(token, async () => {
    await deleteNoContent(apiPath`/api/v1/cards/${args.cardId}/members/${args.userId}`, token);
    return cardWithMember(args.cardId, args.userId, false, token);
  }));

  // The server answers 409 for an existing member, so no roster pre-check.
  server.registerTool('add_board_member', {
    description: 'Add a workspace member to a board by user ID. Fails if they are already on the board '
      + '(use set_board_member_role). Requires board admin.',
    inputSchema: {
      boardId,
      userId: z.string().min(1).describe('User ID (see list_workspace_members)'),
      role: role.optional().describe('admin or member (default member)'),
    },
  }, (args) => runTool(token, async () => {
    const wanted = (args.role ?? 'member').toUpperCase();
    await request({
      method: 'POST', path: apiPath`/api/v1/boards/${args.boardId}/members`,
      body: { userId: args.userId, role: wanted }, token, schema: written,
    });
    return boardMember(args.boardId, args.userId, wanted);
  }));

  server.registerTool('set_board_member_role', {
    description: "Change an existing board member's role. Requires board admin.",
    inputSchema: {
      boardId,
      userId: z.string().min(1).describe('User ID (see list_board_members)'),
      role: role.describe('New role'),
    },
  }, (args) => runTool(token, async () => {
    const wanted = args.role.toUpperCase();
    await request({
      method: 'PATCH', path: apiPath`/api/v1/boards/${args.boardId}/members/${args.userId}`,
      body: { role: wanted }, token, schema: written,
    });
    return boardMember(args.boardId, args.userId, wanted);
  }));
}
