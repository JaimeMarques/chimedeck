// server/extensions/mcp/tools/importRun.ts
// MCP wrappers for historical-import dry-run and reset. Apply is deliberately
// NOT exposed as a one-call MCP tool: it requires the
// HISTORICAL_IMPORT_APPLY_ENABLED env gate on the server plus an explicit
// confirmed_plan_hash, and the REST endpoint remains the auditable path.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiCall } from '../apiClient';

export function registerImportDryRun(server: McpServer, token: string): void {
  server.tool(
    'historical_import_dry_run',
    'Dry-run a historical-import plan: full validation + outcome simulation with ZERO writes. Default and safe.',
    { plan: z.unknown().describe('The full import plan manifest JSON.') },
    async ({ plan }) => {
      const result = await apiCall<{ data: unknown }>({
        method: 'POST',
        path: '/api/v1/admin/historical-import/dry-run',
        body: { plan },
        token,
      });
      if ('error' in result) {
        return { content: [{ type: 'text', text: `Error: ${result.error.name}` }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result.data) }] };
    },
  );
}

export function registerImportReset(server: McpServer, token: string): void {
  server.tool(
    'historical_import_reset',
    'Reset provenance rows recorded by a plan hash (entity rows are never deleted). Requires OWNER.',
    { planHash: z.string().regex(/^[0-9a-f]{64}$/).describe('The 64-hex plan hash to reset.') },
    async ({ planHash }) => {
      const result = await apiCall<{ data: unknown }>({
        method: 'POST',
        path: '/api/v1/admin/historical-import/reset',
        body: { plan_hash: planHash },
        token,
      });
      if ('error' in result) {
        return { content: [{ type: 'text', text: `Error: ${result.error.name}` }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result.data) }] };
    },
  );
}
