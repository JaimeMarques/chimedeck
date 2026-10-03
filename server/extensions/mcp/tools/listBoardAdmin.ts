import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sanitizeRichText, sanitizeText } from '../../../common/sanitize';
import {
  ToolError, apiPath, dataOf, deleteNoContent, expectFields, findRow, inParent, request, rowWithId, rowsOf, runTool,
} from './toolSupport';

// List and board administration writes. Names, arguments and return shapes
// mirror the local Python server (chimedeck_mcp/tools.py).

const boardId = z.string().min(1).describe('ID of the board the list is on');
const listId = z.string().min(1).describe('ID of the list');
const archivedRow = rowWithId.extend({ archived: z.boolean() });
const listRow = rowWithId.extend({ short_id: z.string().nullable().optional() });

export function registerListBoardAdmin(server: McpServer, token: string): void {
  const openLists = async (board: string) =>
    (await request({ path: apiPath`/api/v1/boards/${board}/lists`, token, schema: rowsOf(listRow) })).data;
  const archivedLists = async (board: string) =>
    (await request({ path: apiPath`/api/v1/boards/${board}/archived-lists`, token, schema: rowsOf(listRow) })).data;
  // Open and archived lists: the board's whole roster, so a list is found
  // whatever its state, by UUID or short ID.
  const boardLists = async (board: string) => {
    const open = await openLists(board);
    const archived = await archivedLists(board);
    return { archived, all: [...open, ...archived] };
  };

  server.registerTool('rename_list', {
    description: 'Rename a list. The list must be on boardId (not-in-board otherwise).',
    inputSchema: { boardId, listId, title: z.string().min(1).describe('New title') },
  }, (args) => runTool(token, async () => {
    const target = inParent((await boardLists(args.boardId)).all, args.listId, 'board');
    await request({ method: 'PATCH', path: apiPath`/api/v1/lists/${target.id}`, body: { title: args.title }, token, schema: dataOf(rowWithId) });
    const row = findRow((await boardLists(args.boardId)).all, 'id', target.id);
    // The server stores sanitizeText(title.trim()) (list/api/update.ts).
    expectFields(row, { title: sanitizeText(args.title.trim()) });
    return row;
  }));

  // [why] PATCH /lists/:id/archive toggles, so archiving an archived list
  // would restore it. The list is resolved to its UUID and current state
  // first; an already-archived list is returned unchanged with no PATCH.
  server.registerTool('archive_list', {
    description: 'Archive a list. Returns the archived list, read back from the board\'s archived lists; '
      + 'a list that is already archived is returned unchanged. The server route toggles, so a concurrent '
      + 'archive by someone else between the read and the write can leave the list open: that is reported as '
      + 'archive-state-conflict, never success.',
    inputSchema: { boardId, listId },
    annotations: { destructiveHint: true },
  }, (args) => runTool(token, async () => {
    const lists = await boardLists(args.boardId);
    const target = inParent(lists.all, args.listId, 'board');
    const already = lists.archived.find((row) => row.id === target.id);
    if (already) return already;
    const { data } = await request({
      method: 'PATCH', path: apiPath`/api/v1/lists/${target.id}/archive`, body: {}, token, schema: dataOf(archivedRow),
    });
    const after = (await archivedLists(args.boardId)).find((row) => row.id === target.id);
    if (!data.archived || !after) throw new ToolError('archive-state-conflict');
    return after;
  }));

  // No GET /lists/:id route exists, so the delete is verified on the board's
  // open and archived lists.
  server.registerTool('delete_list', {
    // [why] No confirm:true is sent (as in Python), so the server refuses a list that still has cards.
    description: 'Permanently delete an empty list on boardId (open or archived). A list that still has cards is '
      + 'refused (delete-requires-confirmation). Prefer archive_list unless deletion is intended.',
    inputSchema: { boardId, listId },
    annotations: { destructiveHint: true },
  }, (args) => runTool(token, async () => {
    const target = inParent((await boardLists(args.boardId)).all, args.listId, 'board');
    await deleteNoContent(apiPath`/api/v1/lists/${target.id}`, token);
    if ((await boardLists(args.boardId)).all.some((row) => row.id === target.id)) throw new ToolError('delete-failed');
    return { deleted: true, id: target.id };
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
    const { data } = await request({ path: apiPath`/api/v1/boards/${board}`, token, schema: dataOf(rowWithId) });
    // Compared as board/api/patch.ts stores them: sanitized and trimmed; an empty description is null.
    expectFields(data, {
      title: title === undefined ? undefined : sanitizeText(title.trim()),
      description: description === undefined ? undefined : (description ? sanitizeRichText(description.trim()) : null),
      visibility,
    });
    return data;
  }));
}
