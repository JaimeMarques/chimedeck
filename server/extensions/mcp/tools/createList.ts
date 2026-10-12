import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sanitizeText } from '../../../common/sanitize';
import { apiPath, dataOf, findRow, request, rowWithId, rowsOf, runTool } from './toolSupport';
import { acknowledgedCreate, fields, type Row } from './results';
export function registerCreateList(server: McpServer, token: string): void {
  server.registerTool(
    'create_list',
    {
      description:
        'Create a list and verify its acknowledged identity and title on the requested board. Relative ordering remains explicitly unverified.',
      inputSchema: {
        boardId: z.string().min(1).describe('Parent board ID'),
        title: z.string().min(1).describe('List title'),
        afterId: z
          .string()
          .nullable()
          .optional()
          .describe('Insert after this list; null selects top, omission appends'),
      },
    },
    ({ boardId, title, afterId }) =>
      runTool(token, async () => {
        const canonical = z.uuid().safeParse(boardId).success
          ? boardId
          : (
              await request({
                path: apiPath`/api/v1/boards/${boardId}`,
                token,
                schema: dataOf(rowWithId.extend({ id: z.uuid() })),
              })
            ).data.id;
        return acknowledgedCreate(
          () =>
            request({
              method: 'POST',
              path: apiPath`/api/v1/boards/${canonical}/lists`,
              body: { title, afterId },
              token,
              schema: z.unknown(),
            }),
          async (ack) => {
            const { data } = await request({
              path: apiPath`/api/v1/boards/${canonical}/lists`,
              token,
              schema: rowsOf(rowWithId),
            });
            const row = findRow(data, 'id', String(ack.id));
            return {
              row,
              selected: true,
              extra: {
                list: fields(
                  row,
                  new Set('id board_id title position archived created_at updated_at'.split(' '))
                ) as Row,
              },
            };
          },
          { board_id: canonical, title: sanitizeText(title.trim()) },
          afterId === undefined ? [] : ['ordering']
        );
      })
  );
}
