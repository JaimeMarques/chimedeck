import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiPath, findRow, request, runTool, ToolError } from './toolSupport';
import { ambiguous, errorCode, isRow } from './results';
export function registerInviteToBoard(server: McpServer, token: string): void {
  server.registerTool(
    'invite_to_board',
    {
      description:
        'Add an eligible workspace member by email and verify board membership and role. Preserves backend duplicate and ambiguity refusals; no email invitation to outsiders.',
      inputSchema: {
        boardId: z.string().min(1).describe('Board ID'),
        email: z.email().describe('Email of an eligible existing workspace member'),
        role: z.enum(['member', 'admin']).optional().describe('Board role; defaults to member'),
      },
    },
    ({ boardId, email, role }) =>
      runTool(token, async () => {
        let response: unknown;
        try {
          response = await request({
            method: 'POST',
            path: apiPath`/api/v1/boards/${boardId}/members`,
            body: { email, role },
            token,
            schema: z.unknown(),
          });
        } catch (error) {
          if (!ambiguous(error)) throw error;
          return {
            board_id: boardId,
            request_outcome: 'unknown',
            verified: false,
            verification_error: { code: errorCode(error) },
          };
        }
        const ack = isRow(response) ? response.data : undefined;
        if (!isRow(ack) || typeof ack.id !== 'string' || !ack.id)
          return {
            board_id: boardId,
            request_outcome: 'unknown',
            verified: false,
            verification_error: { code: 'invalid-response' },
          };
        const result = { board_id: boardId, user_id: ack.id, request_outcome: 'succeeded' };
        try {
          const roster = await request({
            path: apiPath`/api/v1/boards/${boardId}/members`,
            token,
            schema: z.object({
              data: z.array(z.looseObject({ user_id: z.string().min(1), role: z.string() })),
            }),
          });
          const member = findRow(roster.data, 'user_id', ack.id);
          if (member.role.toUpperCase() !== (role ?? 'member').toUpperCase())
            throw new ToolError('readback-mismatch');
          return {
            ...result,
            verified: true,
            verified_fields: ['membership', 'role'],
            observed: { present: true, role: member.role },
          };
        } catch (error) {
          return { ...result, verified: false, verification_error: { code: errorCode(error) } };
        }
      })
  );
}
