import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiCall } from '../apiClient';

export function registerGetCard(server: McpServer, token: string): void {
  server.registerTool(
    'get_card',
    {
      description: 'Retrieve the full details of a single card by its ID.',
      inputSchema: {
        cardId: z.string().describe('ID of the card to retrieve'),
        include_activities: z
          .boolean()
          .optional()
          .describe(
            "Also return the card's activity feed in includes.activities (default false). Rows are oldest first; the 'card_created' row's actor_id is the card's creator.",
          ),
      },
    },
    async ({ cardId, include_activities }) => {
      const query = include_activities ? '?include=activities' : '';
      const result = await apiCall<{ data: unknown }>({
        method: 'GET',
        path: `/api/v1/cards/${encodeURIComponent(cardId)}${query}`,
        token,
      });

      if ('error' in result) {
        return {
          content: [{ type: 'text', text: `Error: ${result.error.name}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result.data) }],
      };
    },
  );
}
