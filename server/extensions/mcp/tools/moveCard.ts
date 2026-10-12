import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  apiPath,
  dataOf,
  readCard,
  request,
  rowWithId,
  rowsOf,
  runTool,
  ToolError,
} from './toolSupport';
import { errorCode, identity, verified } from './results';
export function registerMoveCard(server: McpServer, token: string): void {
  server.registerTool(
    'move_card',
    {
      description:
        'Move a card and verify destination and ordering. Ordering stays explicitly unverified if a complete list read is unavailable.',
      inputSchema: {
        cardId: z.string().min(1),
        targetListId: z.string().min(1),
        afterCardId: z.string().nullable().optional(),
        position: z.number().optional(),
      },
    },
    ({ cardId, targetListId, afterCardId, position }) =>
      runTool(token, async () => {
        if (afterCardId === undefined && position !== undefined && position !== 0)
          throw new ToolError('bad-request');
        let after = afterCardId === undefined && position === 0 ? null : afterCardId;
        if (after) {
          const relative = (await readCard(after, token)).data;
          if (
            typeof relative.list_id !== 'string' ||
            identity(relative.list_id) !== identity(targetListId)
          )
            throw new ToolError('scope-mismatch');
          after = relative.id;
        }
        await request({
          method: 'PATCH',
          path: apiPath`/api/v1/cards/${cardId}/move`,
          body: { targetListId, afterCardId: after },
          token,
          schema: dataOf(rowWithId),
        });
        const card = (await readCard(cardId, token)).data;
        const result = verified(card, { list_id: targetListId }, ['ordering']);
        try {
          const response = await request({
            path: apiPath`/api/v1/lists/${targetListId}/cards`,
            token,
            schema: rowsOf(rowWithId),
          });
          if (Object.keys(response).some((key) => key !== 'data'))
            throw new ToolError('invalid-response');
          const ids = response.data.map((row) => identity(row.id));
          const index = ids.indexOf(identity(card.id));
          if (new Set(ids).size !== ids.length || index < 0)
            throw new ToolError('invalid-response');
          if (
            after === undefined
              ? index !== ids.length - 1
              : after === null
                ? index !== 0
                : index === 0 || ids[index - 1] !== identity(after)
          )
            throw new ToolError('readback-mismatch');
          result.verified = true;
          result.verified_fields.push('ordering');
          delete result.unverified;
          result.observed.after_card_id = index ? ids[index - 1] : null;
          return result;
        } catch (error) {
          return {
            ...result,
            verification_error: {
              code: errorCode(error),
              observation:
                error instanceof ToolError && error.code === 'readback-mismatch'
                  ? 'mismatch'
                  : 'unknown',
            },
          };
        }
      })
  );
}
