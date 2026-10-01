import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiPath, dataOf, request, rowWithId, rowsOf, runTool } from './toolSupport';

// Read-only lookups for resolving IDs before writes. Names, arguments and
// return shapes mirror the local Python server (chimedeck_mcp/tools.py).

const readOnly = { readOnlyHint: true };
const boardId = z.string().min(1).describe('ID of the board');
const workspaceId = z.string().min(1).describe('ID of the workspace');

export function registerBoardLookups(server: McpServer, token: string): void {
  const readRows = async (path: string, row: z.ZodType = rowWithId) =>
    (await request({ path, token, schema: rowsOf(row) })).data;

  server.registerTool('get_me', {
    description: 'Return the user the token belongs to.',
    inputSchema: {},
    annotations: readOnly,
  }, () => runTool(token, async () => (await request({
    path: '/api/v1/users/me',
    token,
    schema: dataOf(z.looseObject({ id: z.string().min(1), email: z.string() })),
  })).data));

  server.registerTool('list_workspaces', {
    description: 'List the workspaces the token can see.',
    inputSchema: {},
    annotations: readOnly,
  }, () => runTool(token, () => readRows('/api/v1/workspaces')));

  server.registerTool('list_workspace_boards', {
    description: 'List the boards in a workspace.',
    inputSchema: { workspaceId },
    annotations: readOnly,
  }, (args) => runTool(token, () => readRows(apiPath`/api/v1/workspaces/${args.workspaceId}/boards`)));

  server.registerTool('list_workspace_members', {
    description: 'List the members of a workspace: userId, email, name, role.',
    inputSchema: { workspaceId },
    annotations: readOnly,
  }, (args) => runTool(token, () => readRows(
    apiPath`/api/v1/workspaces/${args.workspaceId}/members`,
    z.looseObject({ userId: z.string().min(1) }),
  )));

  // Whole {data, includes} body, as Python returns it: includes carries lists and cards.
  server.registerTool('get_board', {
    description: 'Retrieve a board by UUID or short ID, with its lists and cards.',
    inputSchema: { boardId: z.string().min(1).describe('Board UUID or the short ID from its URL') },
    annotations: readOnly,
  }, (args) => runTool(token, () => request({
    path: apiPath`/api/v1/boards/${args.boardId}`,
    token,
    schema: z.looseObject({ data: rowWithId, includes: z.looseObject({}) }),
  })));

  server.registerTool('list_lists', {
    description: 'List the lists on a board, in board order, with their IDs.',
    inputSchema: { boardId },
    annotations: readOnly,
  }, (args) => runTool(token, () => readRows(apiPath`/api/v1/boards/${args.boardId}/lists`)));

  server.registerTool('list_labels', {
    description: 'List the labels defined on a board (id, name, color).',
    inputSchema: { boardId },
    annotations: readOnly,
  }, (args) => runTool(token, () => readRows(apiPath`/api/v1/boards/${args.boardId}/labels`)));

  server.registerTool('list_board_members', {
    description: 'List the members of a board: user_id, email, display_name, role.',
    inputSchema: { boardId },
    annotations: readOnly,
  }, (args) => runTool(token, () => readRows(
    apiPath`/api/v1/boards/${args.boardId}/members`,
    z.looseObject({ user_id: z.string().min(1) }),
  )));

  // The server returns open cards only and adds metadata (total, nextOffset,
  // hasMore) when limit is set; metadata is passed through untouched.
  server.registerTool('list_cards', {
    description: 'List the open cards in a list, in board order. '
      + 'Archived cards are not included; use list_archived_cards.',
    inputSchema: {
      listId: z.string().min(1).describe('ID of the list'),
      limit: z.number().int().min(1).optional().describe('Maximum number of cards to return'),
      offset: z.number().int().min(0).optional().describe('Number of cards to skip'),
    },
    annotations: readOnly,
  }, ({ listId, limit, offset }) => runTool(token, async () => {
    const query = new URLSearchParams();
    if (limit !== undefined) query.set('limit', String(limit));
    if (offset !== undefined) query.set('offset', String(offset));
    const { data, metadata } = await request({
      path: apiPath`/api/v1/lists/${listId}/cards` + (query.size ? `?${query.toString()}` : ''),
      token,
      schema: rowsOf(rowWithId).extend({ metadata: z.looseObject({}).optional() }),
    });
    return metadata ? { data, metadata } : { data };
  }));

  server.registerTool('list_archived_cards', {
    description: 'List the archived cards on a board.',
    inputSchema: { boardId },
    annotations: readOnly,
  }, (args) => runTool(token, () => readRows(apiPath`/api/v1/boards/${args.boardId}/archived-cards`)));
}
