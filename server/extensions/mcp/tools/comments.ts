import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sanitizeRichText } from '../../../common/sanitize';
import { ToolError, apiPath, dataOf, expectFields, findRow, request, rowWithId, rowsOf, runTool } from './toolSupport';

// Top-level card comments. Names, arguments and read-backs mirror the local
// Python server (chimedeck_mcp/tools.py). Replies: get_card_discussion.

const commentCardId = z.string().min(1).describe('ID of the card the comment is on');
const commentId = z.string().min(1).describe('ID of the comment');
// PATCH and DELETE /comments/:id both return the comment row, replies included.
const writtenComment = dataOf(rowWithId.extend({ parent_id: z.string().nullable().optional() }));
// reply_count says which threads to walk; a row without it is walked anyway.
const topLevelRow = rowWithId.extend({ reply_count: z.number().optional() });

export function registerCommentTools(server: McpServer, token: string): void {
  // GET /cards/:id/comments returns top-level comments only, deleted placeholders included.
  const cardComments = async (cardId: string) =>
    (await request({ path: apiPath`/api/v1/cards/${cardId}/comments`, token, schema: rowsOf(topLevelRow) })).data;
  // GET /comments/:id/replies returns non-deleted replies only.
  const replies = async (parentId: string) =>
    (await request({ path: apiPath`/api/v1/comments/${parentId}/replies`, token, schema: rowsOf(rowWithId) })).data;
  // Thread rows the comment is read back from: its parent's replies, or the card's top level.
  const thread = (cardId: string, parentId: string | null) => (parentId ? replies(parentId) : cardComments(cardId));

  // [why] PATCH/DELETE /comments/:id act on any card. Find the comment on
  // cardId first (top level, then each thread with replies, as
  // get_card_discussion walks it); a miss is not-in-card with no write sent.
  const locate = async (cardId: string, commentId: string) => {
    const top = await cardComments(cardId);
    const own = top.find((row) => row.id === commentId);
    if (own) return { comment: own, parentId: null };
    for (const parent of top.filter((row) => (row.reply_count ?? 1) > 0)) {
      const reply = (await replies(parent.id)).find((row) => row.id === commentId);
      if (reply) return { comment: reply, parentId: parent.id };
    }
    throw new ToolError('not-in-card');
  };

  server.registerTool('get_comments', {
    description: 'List the top-level comments on a card, oldest first. Use get_card_discussion for replies.',
    inputSchema: { cardId: z.string().min(1).describe('ID of the card') },
    annotations: { readOnlyHint: true },
  }, (args) => runTool(token, () => cardComments(args.cardId)));

  server.registerTool('edit_comment', {
    description: 'Edit the text of an existing comment or reply. It must be on cardId (not-in-card otherwise; '
      + 'pass the comment UUID).',
    inputSchema: { cardId: commentCardId, commentId, content: z.string().min(1).describe('New comment text') },
  }, (args) => runTool(token, async () => {
    const { comment, parentId } = await locate(args.cardId, args.commentId);
    await request({
      method: 'PATCH', path: apiPath`/api/v1/comments/${comment.id}`,
      body: { content: args.content }, token, schema: writtenComment,
    });
    const row = findRow(await thread(args.cardId, parentId), 'id', comment.id);
    // Stored as sanitizeRichText(content.trim()) (comment/api/update.ts).
    expectFields(row, { content: sanitizeRichText(args.content.trim()) });
    return row;
  }));

  // [why] The server soft-deletes: a top-level row stays in the list as a
  // '[deleted]' placeholder and there is no GET /comments/:id to 404, so the
  // read-back is that placeholder. Deleted replies drop out of their parent's
  // replies, so a reply is verified absent there.
  server.registerTool('delete_comment', {
    description: "Delete a comment. A top-level comment leaves a '[deleted]' placeholder, which is returned; "
      + 'a deleted reply is verified gone from its thread. It must be on cardId (not-in-card otherwise; '
      + 'pass the comment UUID).',
    inputSchema: { cardId: commentCardId, commentId },
    annotations: { destructiveHint: true },
  }, (args) => runTool(token, async () => {
    const { comment, parentId } = await locate(args.cardId, args.commentId);
    // The route answers 200 {data: row}; HTML-200 or null is invalid-response.
    const { data } = await request({
      method: 'DELETE', path: apiPath`/api/v1/comments/${comment.id}`, token, schema: writtenComment,
    });
    if (data.id !== comment.id) throw new ToolError('invalid-response');
    const rows = await thread(args.cardId, parentId);
    if (parentId) {
      if (rows.some((row) => row.id === comment.id)) throw new ToolError('delete-failed');
      return { deleted: true, id: comment.id };
    }
    const row = findRow(rows, 'id', comment.id);
    if (row.deleted !== true) throw new ToolError('delete-failed');
    return row;
  }));
}
