import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { apiCall } from '../apiClient';

const commentSchema = z.looseObject({
  id: z.string().min(1),
  card_id: z.string().min(1),
  parent_id: z.string().nullable(),
  content: z.string(),
  created_at: z.string(),
  deleted: z.boolean(),
  reply_count: z.number().int().nonnegative().optional(),
});
const envelopeSchema = z.looseObject({ data: z.array(commentSchema) });
type Comment = z.infer<typeof commentSchema>;
interface Issue {
  code: string;
  parent_id: string | null;
  expected_reply_count?: number;
  actual_reply_count?: number;
}
interface Discussion {
  data: Comment[];
  complete: boolean;
  issues: Issue[];
}

class ReadFailure extends Error {
  constructor(readonly code: string) { super(code); }
}

async function readRows({ path, parentId, token }: {
  path: string; parentId: string | null; token: string;
}): Promise<Discussion> {
  let response: Awaited<ReturnType<typeof apiCall<unknown>>>;
  try {
    response = await apiCall<unknown>({ method: 'GET', path, token });
  } catch {
    // [why] Transport exceptions can contain URLs/credentials; expose no raw messages.
    throw new ReadFailure('network');
  }
  if ('error' in response) {
    const name = response.error.name;
    throw new ReadFailure(/^[a-z][a-z0-9-]{0,63}$/.test(name) ? name : 'api-error');
  }
  const parsed = envelopeSchema.safeParse(response.data);
  if (!parsed.success) throw new ReadFailure('bad-response');
  const { data } = parsed.data;
  const issues: Issue[] = [];
  // [why] Neither verified route is paginated. A changed envelope may hide a
  // cursor or truncation; do not discard it and claim an exhaustive read.
  if (Object.keys(parsed.data).some((key) => key !== 'data')) {
    issues.push({ code: 'unrecognized-envelope', parent_id: parentId });
  }
  const seen = new Set<string>();
  const cardId = data[0]?.card_id;
  for (const row of data) {
    if (row.parent_id !== parentId || row.id === parentId || seen.has(row.id)
      || row.card_id !== cardId || (parentId === null && row.reply_count === undefined)) {
      throw new ReadFailure('bad-response');
    }
    seen.add(row.id);
    if (parentId !== null && (row.deleted || (row.reply_count ?? 0) > 0)) {
      issues.push({ code: 'unexpected-reply', parent_id: parentId });
    }
  }
  return { data, complete: issues.length === 0, issues };
}

async function readReplies({ commentId, token }: { commentId: string; token: string }): Promise<Discussion> {
  // [why] UUIDs from PostgreSQL are lowercase even when the input is uppercase.
  const parentId = commentId.toLowerCase();
  return readRows({ path: `/api/v1/comments/${encodeURIComponent(parentId)}/replies`, parentId, token });
}

async function readDiscussion({ cardId, token }: { cardId: string; token: string }): Promise<Discussion> {
  const parents = await readRows({ path: `/api/v1/cards/${encodeURIComponent(cardId)}/comments`, parentId: null, token });
  const data: Comment[] = [];
  const issues = [...parents.issues];
  const seen = new Set(parents.data.map((row) => row.id));
  for (const parent of parents.data) {
    const expected = parent.reply_count;
    if (expected === undefined) throw new ReadFailure('bad-response');
    data.push(parent);
    if (expected === 0) continue;
    try {
      const replies = await readReplies({ commentId: parent.id, token });
      if (replies.data.some((row) => row.card_id !== parent.card_id || seen.has(row.id))) {
        throw new ReadFailure('bad-response');
      }
      // [why] Preserve server ordering, including ties, and keep replies with
      // their parent. Failed threads must not hide successful sibling threads.
      data.push(...replies.data);
      for (const row of replies.data) seen.add(row.id);
      issues.push(...replies.issues);
      if (replies.data.length !== expected) {
        issues.push({ code: 'reply-count-mismatch', parent_id: parent.id,
          expected_reply_count: expected, actual_reply_count: replies.data.length });
      }
    } catch (error) {
      issues.push({ code: error instanceof ReadFailure ? error.code : 'internal',
        parent_id: parent.id, expected_reply_count: expected });
    }
  }
  return { data, complete: issues.length === 0, issues };
}

async function resultFor({ read, token }: { read: () => Promise<Discussion>; token: string }): Promise<CallToolResult> {
  try {
    const text = JSON.stringify(await read());
    return { content: [{ type: 'text', text: token ? text.replaceAll(token, '<redacted>') : text }] };
  } catch (error) {
    const code = error instanceof ReadFailure ? error.code : 'internal';
    return { content: [{ type: 'text', text: `Error: ${token ? code.replaceAll(token, '<redacted>') : code}` }], isError: true };
  }
}

export function registerDiscussionReaders(server: McpServer, token: string): void {
  server.registerTool('get_comment_replies', {
    description: 'Read all non-deleted direct replies to a comment, oldest first. Returns {data, complete, issues}; '
      + 'check complete before treating results as exhaustive. Preserves parent_id. '
      + 'Use a parent UUID from get_card_discussion. Does not verify that the input comment is top-level. '
      + 'One reply level, no pagination.',
    inputSchema: { commentId: z.uuid().describe('Parent comment UUID') },
    annotations: { readOnlyHint: true },
  }, ({ commentId }) => resultFor({ read: () => readReplies({ commentId, token }), token }));

  server.registerTool('get_card_discussion', {
    description: 'Read a card discussion, including all non-deleted replies. Returns {data, complete, issues}; '
      + 'check complete for failed threads, count mismatches or changed API metadata. '
      + 'Flat data preserves parent_id: oldest-first parents, each followed by oldest-first replies. '
      + 'No pagination; reads are not an atomic snapshot. Deleted reply bodies are unavailable.',
    inputSchema: { cardId: z.string().min(1).describe('Card UUID or 8-character short ID') },
    annotations: { readOnlyHint: true },
  }, ({ cardId }) => resultFor({ read: () => readDiscussion({ cardId, token }), token }));
}
