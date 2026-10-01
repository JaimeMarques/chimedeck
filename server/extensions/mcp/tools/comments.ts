import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolError, apiPath, dataOf, findRow, request, rowWithId, rowsOf, runTool } from './toolSupport';

// Top-level card comments. Names, arguments and read-backs mirror the local
// Python server (chimedeck_mcp/tools.py). Replies: get_card_discussion.

const commentCardId = z.string().min(1).describe('ID of the card the comment is on');
const commentId = z.string().min(1).describe('ID of the comment');

export function registerCommentTools(server: McpServer, token: string): void {
  // GET /cards/:id/comments returns top-level comments only, deleted placeholders included.
  const cardComments = async (cardId: string) =>
    (await request({ path: apiPath`/api/v1/cards/${cardId}/comments`, token, schema: rowsOf(rowWithId) })).data;

  server.registerTool('get_comments', {
    description: 'List the top-level comments on a card, oldest first. Use get_card_discussion for replies.',
    inputSchema: { cardId: z.string().min(1).describe('ID of the card') },
    annotations: { readOnlyHint: true },
  }, (args) => runTool(token, () => cardComments(args.cardId)));

  server.registerTool('edit_comment', {
    description: 'Edit the text of an existing comment.',
    inputSchema: { cardId: commentCardId, commentId, content: z.string().min(1).describe('New comment text') },
  }, (args) => runTool(token, async () => {
    await request({
      method: 'PATCH', path: apiPath`/api/v1/comments/${args.commentId}`,
      body: { content: args.content }, token, schema: dataOf(rowWithId),
    });
    return findRow(await cardComments(args.cardId), 'id', args.commentId);
  }));

  // [why] The server soft-deletes: the row stays in the list as a '[deleted]'
  // placeholder and there is no GET /comments/:id to 404, so the read-back is
  // that placeholder.
  server.registerTool('delete_comment', {
    description: "Delete a comment. The server keeps a '[deleted]' placeholder in the thread; that placeholder is returned.",
    inputSchema: { cardId: commentCardId, commentId },
    annotations: { destructiveHint: true },
  }, (args) => runTool(token, async () => {
    await request({ method: 'DELETE', path: apiPath`/api/v1/comments/${args.commentId}`, token, schema: z.unknown() });
    const row = findRow(await cardComments(args.cardId), 'id', args.commentId);
    if (row.deleted !== true) throw new ToolError('delete-failed');
    return row;
  }));
}
