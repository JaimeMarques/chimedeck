import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { apiCall } from '../apiClient';
import { identity, projectRows, viewSchema } from './results';

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
  page_complete?: boolean;
  scope?: string;
  pagination?: Record<string, unknown>;
}

class ReadFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

async function readRows({
  path,
  parentId,
  token,
}: {
  path: string;
  parentId: string | null;
  token: string;
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
    if (
      (row.parent_id === null ? parentId !== null : identity(row.parent_id) !== parentId) ||
      identity(row.id) === parentId ||
      seen.has(identity(row.id)) ||
      identity(row.card_id) !== identity(cardId ?? '') ||
      (parentId === null && row.reply_count === undefined)
    ) {
      throw new ReadFailure('bad-response');
    }
    seen.add(identity(row.id));
    if (parentId !== null && (row.deleted || (row.reply_count ?? 0) > 0)) {
      issues.push({ code: 'unexpected-reply', parent_id: parentId });
    }
  }
  return { data, complete: issues.length === 0, issues };
}

async function readReplies({
  commentId,
  token,
}: {
  commentId: string;
  token: string;
}): Promise<Discussion> {
  // [why] UUIDs from PostgreSQL are lowercase even when the input is uppercase.
  const parentId = commentId.toLowerCase();
  return readRows({
    path: `/api/v1/comments/${encodeURIComponent(parentId)}/replies`,
    parentId,
    token,
  });
}

async function readDiscussion({
  cardId,
  token,
  limit = 20,
  offset = 0,
  all = false,
}: {
  cardId: string;
  token: string;
  limit?: number;
  offset?: number;
  all?: boolean;
}): Promise<Discussion> {
  const parents = await readRows({
    path: `/api/v1/cards/${encodeURIComponent(cardId)}/comments`,
    parentId: null,
    token,
  });
  const data: Comment[] = [];
  const issues = [...parents.issues];
  const seen = new Set(parents.data.map((row) => identity(row.id)));
  const total = parents.data.length;
  const end = Math.max(0, total - offset);
  const start = Math.max(0, end - limit);
  const selected = all ? parents.data : parents.data.slice(start, end);
  const omitted = total - selected.length;
  for (const parent of selected) {
    const expected = parent.reply_count;
    if (expected === undefined) throw new ReadFailure('bad-response');
    data.push(parent);
    if (expected === 0) continue;
    try {
      const replies = await readReplies({ commentId: parent.id, token });
      if (
        replies.data.some(
          (row) => identity(row.card_id) !== identity(parent.card_id) || seen.has(identity(row.id))
        )
      ) {
        throw new ReadFailure('bad-response');
      }
      // [why] Preserve server ordering, including ties, and keep replies with
      // their parent. Failed threads must not hide successful sibling threads.
      data.push(...replies.data);
      for (const row of replies.data) seen.add(identity(row.id));
      issues.push(...replies.issues);
      if (replies.data.length !== expected) {
        issues.push({
          code: 'reply-count-mismatch',
          parent_id: parent.id,
          expected_reply_count: expected,
          actual_reply_count: replies.data.length,
        });
      }
    } catch (error) {
      issues.push({
        code: error instanceof ReadFailure ? error.code : 'internal',
        parent_id: parent.id,
        expected_reply_count: expected,
      });
    }
  }
  return {
    data,
    complete: issues.length === 0 && omitted === 0,
    page_complete: issues.length === 0,
    issues,
    scope: all ? 'all' : 'latest-parent-threads',
    pagination: {
      total_threads: total,
      returned_threads: selected.length,
      omitted_threads: omitted,
      offset: all ? 0 : offset,
      limit: all ? null : limit,
      next_offset: !all && start > 0 ? offset + selected.length : null,
    },
  };
}

async function resultFor({
  read,
  token,
  view,
}: {
  read: () => Promise<Discussion>;
  token: string;
  view?: string;
}): Promise<CallToolResult> {
  try {
    const text = JSON.stringify(
      projectRows(await read(), { ...(view === undefined ? {} : { view }) }, true)
    );
    return {
      content: [{ type: 'text', text: token ? text.replaceAll(token, '<redacted>') : text }],
    };
  } catch (error) {
    const code = error instanceof ReadFailure ? error.code : 'internal';
    return {
      content: [
        { type: 'text', text: `Error: ${token ? code.replaceAll(token, '<redacted>') : code}` },
      ],
      isError: true,
    };
  }
}

export function registerDiscussionReaders(server: McpServer, token: string): void {
  server.registerTool(
    'get_comment_replies',
    {
      description:
        'Read all non-deleted direct replies to a comment, oldest first. Returns {data, complete, issues}; ' +
        'check complete before treating results as exhaustive. Preserves parent_id. ' +
        'Use a parent UUID from get_card_discussion. Does not verify that the input comment is top-level. ' +
        'One reply level, no pagination.',
      inputSchema: { commentId: z.uuid().describe('Parent comment UUID'), view: viewSchema },
      annotations: { readOnlyHint: true },
    },
    ({ commentId, view }) =>
      resultFor({ read: () => readReplies({ commentId, token }), token, view })
  );

  server.registerTool(
    'get_card_discussion',
    {
      description:
        'Read the latest 20 parent threads by default, with their replies; all:true selects every parent. Returns {data, complete, page_complete, issues, scope, pagination}; ' +
        'check complete for failed threads, count mismatches or changed API metadata. ' +
        'Flat data preserves parent_id: oldest-first parents, each followed by oldest-first replies. ' +
        'limit/offset page parent threads from newest toward oldest; cannot combine them with all:true. Reads are not an atomic snapshot. Deleted reply bodies are unavailable.',
      inputSchema: {
        cardId: z.string().min(1).describe('Card UUID or 8-character short ID'),
        view: viewSchema,
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
        all: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true },
    },
    ({ cardId, view, limit, offset, all }) =>
      resultFor({
        read: () => {
          if (all && (limit !== undefined || offset !== undefined))
            throw new ReadFailure('bad-request');
          return readDiscussion({ cardId, token, limit: limit ?? 20, offset: offset ?? 0, all });
        },
        token,
        view,
      })
  );
}
