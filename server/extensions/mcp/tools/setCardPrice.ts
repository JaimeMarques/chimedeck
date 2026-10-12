import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiPath, dataOf, readCard, request, rowWithId, runTool } from './toolSupport';
import { verified } from './results';
export function registerSetCardPrice(server: McpServer, token: string): void {
  server.registerTool(
    'set_card_price',
    {
      description:
        'Set or clear card price and verify the exact finite JavaScript number transmitted. Unsafe integer inputs are rejected.',
      inputSchema: {
        cardId: z.string().min(1),
        amount: z
          .number()
          .refine((value) => !Number.isInteger(value) || Number.isSafeInteger(value))
          .nullable(),
        currency: z.string().optional(),
        label: z.string().optional(),
      },
    },
    ({ cardId, amount, currency, label }) =>
      runTool(token, async () => {
        await request({
          method: 'PATCH',
          path: apiPath`/api/v1/cards/${cardId}/money`,
          body: { amount, currency, label },
          token,
          schema: dataOf(rowWithId),
        });
        return verified((await readCard(cardId, token)).data, {
          amount,
          ...(amount === null ? { currency: null } : currency === undefined ? {} : { currency }),
          ...(label === undefined ? {} : { money_label: label.trim() }),
        });
      })
  );
}
