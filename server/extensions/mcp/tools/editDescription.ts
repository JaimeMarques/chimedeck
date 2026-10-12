import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sanitizeRichText } from '../../../common/sanitize';
import { apiPath, dataOf, readCard, request, rowWithId, runTool } from './toolSupport';
import { verified } from './results';

export function registerEditDescription(server: McpServer, token: string): void {
  server.registerTool(
    'edit_card_description',
    {
      description: 'Update a card description and verify the stored sanitized value.',
      inputSchema: { cardId: z.string().min(1), description: z.string() },
    },
    ({ cardId, description }) =>
      runTool(token, async () => {
        await request({
          method: 'PATCH',
          path: apiPath`/api/v1/cards/${cardId}/description`,
          body: { description },
          token,
          schema: dataOf(rowWithId),
        });
        const desired = description ? sanitizeRichText(description.trim()) : null;
        return {
          ...verified((await readCard(cardId, token)).data, { description: desired }),
          ...(desired !== description ? { normalized_fields: ['description'] } : {}),
        };
      })
  );
}
