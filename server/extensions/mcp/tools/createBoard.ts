import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sanitizeRichText, sanitizeText } from '../../../common/sanitize';
import { apiPath, dataOf, request, rowWithId, runTool } from './toolSupport';
import { acknowledgedCreate, fields, type Row } from './results';
export function registerCreateBoard(server: McpServer, token: string): void {
  server.registerTool(
    'create_board',
    {
      description:
        'Create a board and verify acknowledged identity and stored fields. Returns one selected board, with no automatic retries.',
      inputSchema: {
        workspaceId: z.string().min(1).describe('Workspace ID containing the new board'),
        title: z.string().min(1).describe('Board title'),
        visibility: z
          .enum(['PRIVATE', 'WORKSPACE', 'PUBLIC'])
          .optional()
          .describe('Board visibility; defaults to PRIVATE'),
        description: z.string().optional().describe('Board description; stored text is sanitized'),
        background: z.string().optional().describe('Board background value'),
      },
    },
    ({ workspaceId, title, visibility, description, background }) =>
      runTool(token, () =>
        acknowledgedCreate(
          () =>
            request({
              method: 'POST',
              path: apiPath`/api/v1/workspaces/${workspaceId}/boards`,
              body: { title, visibility, description, background },
              token,
              schema: z.unknown(),
            }),
          async (ack) => {
            const { data } = await request({
              path: apiPath`/api/v1/boards/${String(ack.id)}`,
              token,
              schema: dataOf(rowWithId),
            });
            return {
              row: data,
              selected: true,
              extra: {
                board: fields(
                  data,
                  new Set(
                    'id short_id workspace_id title description visibility background state created_at updated_at'.split(
                      ' '
                    )
                  )
                ) as Row,
              },
            };
          },
          {
            workspace_id: workspaceId,
            title: sanitizeText(title.trim()),
            visibility: visibility ?? 'PRIVATE',
            ...(description === undefined
              ? {}
              : { description: description ? sanitizeRichText(description.trim()) : null }),
            ...(background === undefined ? {} : { background: background.trim() }),
          }
        )
      )
  );
}
