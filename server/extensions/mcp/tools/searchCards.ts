import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiPath, request, rowsOf, rowWithId, runTool } from './toolSupport';
import { projectRows, rowView } from './results';
import { describeSearch } from './searchDescriptions';

export function registerSearchCards(server: McpServer, token: string): void {
  server.registerTool(
    'search_cards',
    {
      description: 'Full-text search over cards within a workspace.',
      inputSchema: {
        workspaceId: z.string().describe('ID of the workspace to search within'),
        query: z.string().optional().describe('Full-text search query'),
        q: z.string().optional().describe('Deprecated alias for full-text search query'),
        ...rowView,
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe('Maximum number of results to return (default: 20)'),
      },
    },
    async ({ workspaceId, query, q, limit, view, includeDescription }) => {
      const resolvedQuery = query ?? q;
      if (!resolvedQuery || resolvedQuery.trim() === '') {
        return {
          content: [{ type: 'text', text: 'Error: bad-request (query is required)' }],
          isError: true,
        };
      }

      const params = new URLSearchParams({ query: resolvedQuery });
      params.set('limit', String(limit));

      return runTool(token, async () => {
        const response = await request({
          path: apiPath`/api/v1/workspaces/${workspaceId}/search` + `?${params.toString()}`,
          token,
          schema: rowsOf(rowWithId),
        });
        return projectRows(
          view === 'full' || includeDescription === true
            ? await describeSearch(response, workspaceId, token, limit)
            : response,
          { view, ...(includeDescription === undefined ? {} : { includeDescription }) }
        );
      });
    }
  );
}
