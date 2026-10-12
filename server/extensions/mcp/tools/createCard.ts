import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sanitizeRichText, sanitizeText } from '../../../common/sanitize';
import { apiPath, readCard, request, runTool } from './toolSupport';
import { acknowledgedCreate } from './results';

export function registerCreateCard(server: McpServer, token: string): void {
  server.registerTool(
    'create_card',
    {
      description:
        'Create a card and verify its acknowledged identity and stored fields. Never automatically retry an unknown creation.',
      inputSchema: {
        listId: z.string().min(1),
        title: z.string(),
        description: z.string().optional(),
      },
    },
    ({ listId, title, description }) =>
      runTool(token, () =>
        acknowledgedCreate(
          () =>
            request({
              method: 'POST',
              path: apiPath`/api/v1/lists/${listId}/cards`,
              body: { title, description },
              token,
              schema: z.unknown(),
            }),
          async (ack) => ({ row: (await readCard(String(ack.id), token)).data }),
          {
            title: sanitizeText(title.trim()),
            list_id: listId,
            ...(description === undefined
              ? {}
              : { description: description ? sanitizeRichText(description.trim()) : null }),
          }
        )
      )
  );
}
