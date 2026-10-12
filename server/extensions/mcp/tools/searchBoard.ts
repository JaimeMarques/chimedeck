import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiPath, request, rowsOf, rowWithId, runTool } from './toolSupport';
import { projectRows, rowView } from './results';

export function registerSearchBoard(server: McpServer, token: string): void {
  server.registerTool(
    'search_board',
    {
      description: 'Full-text search over cards and lists scoped to a single board.',
      inputSchema: {
        boardId: z.string().describe('ID of the board to search within'),
        query: z.string().optional().describe('Full-text search query'),
        q: z.string().optional().describe('Deprecated alias for full-text search query'),
        ...rowView,
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe('Maximum number of results to return'),
      },
    },
    async ({ boardId, query, q, limit, view, includeDescription }) => {
      const resolvedQuery = query ?? q;
      if (!resolvedQuery || resolvedQuery.trim() === '') {
        return {
          content: [{ type: 'text', text: 'Error: bad-request (query is required)' }],
          isError: true,
        };
      }

      const params = new URLSearchParams({ query: resolvedQuery });
      params.set('limit', String(limit));

      return runTool(token, async () =>
        projectRows(
          await request({
            path: apiPath`/api/v1/boards/${boardId}/search` + `?${params.toString()}`,
            token,
            schema: rowsOf(rowWithId),
          }),
          { view, ...(includeDescription === undefined ? {} : { includeDescription }) }
        )
      );
    }
  );
}
