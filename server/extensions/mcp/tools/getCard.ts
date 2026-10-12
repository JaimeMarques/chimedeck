import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiPath, dataOf, request, rowWithId, runTool } from './toolSupport';
import { projectCard, viewSchema } from './results';

export function registerGetCard(server: McpServer, token: string): void {
  server.registerTool(
    'get_card',
    {
      description:
        'Retrieve a card by ID, compact by default with its complete description; view:full includes all fields. Read comments with get_card_discussion.',
      inputSchema: {
        cardId: z.string().describe('ID of the card to retrieve'),
        view: viewSchema,
        include_activities: z
          .boolean()
          .optional()
          .describe(
            "Also return the card's activity feed in includes.activities (default false). Rows are oldest first; when present, the 'card_created' row's actor_id is the card's creator (some cards, e.g. duplicated or copied ones, have none)."
          ),
      },
    },
    async ({ cardId, include_activities, view }) => {
      const query = include_activities ? '?include=activities' : '';
      return runTool(token, async () =>
        projectCard(
          await request({
            method: 'GET',
            path: apiPath`/api/v1/cards/${cardId}` + query,
            token,
            schema: dataOf(rowWithId),
          }),
          view
        )
      );
    }
  );
}
