// server/extensions/mcp/tools/importValidate.ts
// MCP wrapper — POST /api/v1/admin/historical-import/validate.
// [why] The plan manifest travels to the server; payloads never do —
// payload_ref is resolved server-side from the operator-staged root.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiCall } from '../apiClient';

export function registerImportValidate(server: McpServer, token: string): void {
  server.tool(
    'historical_import_validate',
    'Validate a historical-import plan manifest (contract + shape) and compute its plan hash. Read-only.',
    { plan: z.unknown().describe('The full import plan manifest JSON (operations, provenance, evidence_refs, dependencies).') },
    async ({ plan }) => {
      const result = await apiCall<{ data: unknown }>({
        method: 'POST',
        path: '/api/v1/admin/historical-import/validate',
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
