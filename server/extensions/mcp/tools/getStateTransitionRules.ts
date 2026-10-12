import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiCall } from '../apiClient';
import { runTool } from './toolSupport';

export function registerGetStateTransitionRules(server: McpServer, token: string): void {
  server.registerTool(
    'get_state_transition_rules',
    {
      description: 'Get enforceable state-transition rules for a board.',
      inputSchema: {
        boardId: z.string().describe('ID of the board'),
      },
    },
    async ({ boardId }) => {
      const result = await apiCall<{ data: unknown }>({
        method: 'GET',
        path: `/api/v1/boards/${boardId}/state-transitions/rules`,
        token,
      });

      if ('error' in result) {
        return {
          content: [{ type: 'text', text: `Error: ${result.error.name}` }],
          isError: true,
        };
      }

      return runTool(token, () => Promise.resolve(result.data));
    }
  );
}
