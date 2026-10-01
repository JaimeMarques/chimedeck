import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolError, apiPath, dataOf, findRow, request, rowWithId, rowsOf, runTool } from './toolSupport';

// List and board administration writes. Names, arguments and return shapes
// mirror the local Python server (chimedeck_mcp/tools.py).

const boardId = z.string().min(1).describe('ID of the board the list is on');
const listId = z.string().min(1).describe('ID of the list');
const archivedRow = rowWithId.extend({ archived: z.boolean() });

export function registerListBoardAdmin(server: McpServer, token: string): void {
  const openLists = async (board: string) =>
    (await request({ path: apiPath`/api/v1/boards/${board}/lists`, token, schema: rowsOf(rowWithId) })).data;
  const archivedLists = async (board: string) =>
    (await request({ path: apiPath`/api/v1/boards/${board}/archived-lists`, token, schema: rowsOf(rowWithId) })).data;

  server.registerTool('rename_list', {
    description: 'Rename a list.',
    inputSchema: { boardId, listId, title: z.string().min(1).describe('New title') },
  }, (args) => runTool(token, async () => {
    await request({ method: 'PATCH', path: apiPath`/api/v1/lists/${args.listId}`, body: { title: args.title }, token, schema: dataOf(rowWithId) });
    return findRow(await openLists(args.boardId), 'id', args.listId);
  }));

  // [why] PATCH /lists/:id/archive toggles, so archiving an archived list
  // would restore it. An already-archived list is returned unchanged.
  server.registerTool('archive_list', {
    description: 'Archive a list. Returns the archived list, read back from the board\'s archived lists; '
      + 'a list that is already archived is returned unchanged.',
    inputSchema: { boardId, listId },
    annotations: { destructiveHint: true },
  }, (args) => runTool(token, async () => {
    const already = (await archivedLists(args.boardId)).find((row) => row.id === args.listId);
    if (already) return already;
    const { data } = await request({
      method: 'PATCH', path: apiPath`/api/v1/lists/${args.listId}/archive`, body: {}, token, schema: dataOf(archivedRow),
    });
    if (!data.archived) throw new ToolError('archive-failed');
    return findRow(await archivedLists(args.boardId), 'id', args.listId);
  }));

  // No GET /lists/:id route exists, so the delete is verified on the board, as Python does.
  server.registerTool('delete_list', {
    description: 'Permanently delete a list and every card in it. Prefer archive_list unless deletion is intended.',
    inputSchema: { boardId, listId },
    annotations: { destructiveHint: true },
  }, (args) => runTool(token, async () => {
    await request({ method: 'DELETE', path: apiPath`/api/v1/lists/${args.listId}`, token, schema: z.unknown() });
    if ((await openLists(args.boardId)).some((row) => row.id === args.listId)) throw new ToolError('delete-failed');
    return { deleted: true, id: args.listId };
  }));

  server.registerTool('update_board', {
    description: 'Update a board\'s title, description or visibility. Give at least one.',
    inputSchema: {
      boardId: z.string().min(1).describe('ID of the board'),
      title: z.string().min(1).optional().describe('New title'),
      description: z.string().optional().describe('New description'),
      visibility: z.enum(['PRIVATE', 'WORKSPACE', 'PUBLIC']).optional().describe('PRIVATE, WORKSPACE or PUBLIC'),
    },
  }, ({ boardId: board, title, description, visibility }) => runTool(token, async () => {
    // [why] Python's schema anyOf(title, description, visibility); a zod raw shape cannot express it.
    if (title === undefined && description === undefined && visibility === undefined) {
      throw new ToolError('nothing-to-update');
    }
    await request({
      method: 'PATCH', path: apiPath`/api/v1/boards/${board}`, body: { title, description, visibility }, token, schema: dataOf(rowWithId),
    });
    const { data } = await request({
      path: apiPath`/api/v1/boards/${board}`, token, schema: dataOf(rowWithId.extend({ visibility: z.string().optional() })),
    });
    if (visibility !== undefined && data.visibility !== visibility) throw new ToolError('readback-failed');
    return data;
  }));
}
