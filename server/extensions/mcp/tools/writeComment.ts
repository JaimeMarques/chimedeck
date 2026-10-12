import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sanitizeRichText } from '../../../common/sanitize';
import { apiPath, dataOf, readCard, request, rowWithId, runTool, ToolError } from './toolSupport';
import { acknowledgedCreate, identity, isRow } from './results';

export function registerWriteComment(server: McpServer, token: string): void {
  server.registerTool(
    'write_comment',
    {
      description:
        'Post a parent comment and verify its acknowledged identity. Unknown creation outcomes must not be automatically retried.',
      inputSchema: {
        cardId: z.string().min(1).describe('Card UUID or short ID'),
        content: z
          .string()
          .optional()
          .describe('Parent comment body; required unless text alias is supplied'),
        text: z.string().optional().describe('Deprecated alias for content'),
      },
    },
    ({ cardId, content, text }) =>
      runTool(token, async () => {
        const body = content ?? text;
        if (!body?.trim()) throw new ToolError('bad-request');
        const id = z.uuid().safeParse(cardId).success
          ? identity(cardId)
          : (await readCard(cardId, token)).data.id;
        return acknowledgedCreate(
          () =>
            request({
              method: 'POST',
              path: apiPath`/api/v1/cards/${id}/comments`,
              body: { content: body },
              token,
              schema: z.unknown(),
            }),
          async (ack) => {
            if (
              'card_id' in ack &&
              (typeof ack.card_id !== 'string' || identity(ack.card_id) !== identity(id))
            )
              throw new ToolError('scope-mismatch');
            const response = await request({
              path: apiPath`/api/v1/cards/${id}/comments`,
              token,
              schema: dataOf(z.array(z.unknown())),
            });
            const matches = response.data.filter(
              (row) =>
                isRow(row) &&
                typeof row.id === 'string' &&
                identity(row.id) === identity(String(ack.id))
            );
            if (matches.length !== 1) throw new ToolError('readback-failed');
            const parsed = rowWithId
              .extend({ card_id: z.string(), parent_id: z.null(), content: z.string() })
              .safeParse(matches[0]);
            if (!parsed.success || identity(parsed.data.card_id) !== identity(id))
              throw new ToolError('invalid-response');
            return { row: parsed.data, extra: { card_id: id, parent_id: null } };
          },
          { content: sanitizeRichText(body.trim()) }
        );
      })
  );
}
