import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { apiCall } from '../apiClient';
import { config } from '../config';

// Shared plumbing for the tool domain files (boardLookups.ts and siblings).
// A tool body throws ToolError; runTool turns it into `Error: <code>`.

export class ToolError extends Error {
  constructor(readonly code: string) { super(code); }
}

// [why] Server error names are kebab-case slugs ("board-not-found"). Anything
// else could echo request data, so it collapses to a fixed code.
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const safeCode = (name: unknown) => (typeof name === 'string' && SAFE_NAME.test(name) ? name : 'api-error');

export const rowWithId = z.looseObject({ id: z.string().min(1) });
export const dataOf = <T extends z.ZodType>(data: T) => z.looseObject({ data });
export const rowsOf = <T extends z.ZodType>(row: T) => dataOf(z.array(row));

// Tagged template that URL-encodes every interpolated ID: apiPath`/api/v1/boards/${id}`.
export function apiPath(strings: TemplateStringsArray, ...ids: string[]): string {
  return strings.reduce((path, part, i) => path + encodeURIComponent(ids[i - 1] ?? '') + part);
}

// One JSON API call, validated. A null body, the SPA's HTML-200 page or a
// changed shape all fail the schema and become `invalid-response`, never success.
export async function request<S extends z.ZodType>({ method = 'GET', path, body, token, schema }: {
  method?: string; path: string; body?: unknown; token: string; schema: S;
}): Promise<z.infer<S>> {
  let response: Awaited<ReturnType<typeof apiCall<unknown>>>;
  try {
    response = await apiCall<unknown>({ method, path, body, token });
  } catch {
    // [why] Transport exceptions can contain URLs/credentials; expose no raw messages.
    throw new ToolError('network');
  }
  if ('error' in response) throw new ToolError(safeCode(response.error.name));
  const parsed = schema.safeParse(response.data);
  if (!parsed.success) throw new ToolError('invalid-response');
  return parsed.data;
}

// Raw fetch with apiClient's base URL and auth, for callers that need the
// status or a binary body (assertGone, attachment downloads).
export async function apiFetch(path: string, token?: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token ?? config.token}`);
  try {
    return await fetch(`${config.apiUrl}${path}`, { ...init, headers });
  } catch {
    throw new ToolError('network');
  }
}

// DELETE on a 204 route. Only 204 is success: the SPA's HTML-200 page or any
// other 2xx body is `invalid-response`. JSON-200 delete routes (attachments,
// comments) use request() with their real schema instead.
export async function deleteNoContent(path: string, token: string): Promise<void> {
  const res = await apiFetch(path, token, { method: 'DELETE' });
  if (res.ok) {
    await res.body?.cancel();
    if (res.status !== 204) throw new ToolError('invalid-response');
    return;
  }
  const payload = await res.json().catch(() => null) as { name?: unknown; error?: { code?: unknown } } | null;
  throw new ToolError(safeCode(payload?.name ?? payload?.error?.code ?? `http-${String(res.status)}`));
}

// Parent-scope guard: the target must be one of the parent's rows, by UUID or
// short ID. Returns the row (its `id` is canonical); a miss is `not-in-<parent>`
// and the caller must not have sent any write yet.
export function inParent<T extends { id: string }>(rows: T[], id: string, parent: string): T {
  const found = rows.find((row) => row.id === id || (row as Record<string, unknown>).short_id === id);
  if (!found) throw new ToolError(`not-in-${parent}`);
  return found;
}

// Read-back check: every requested field must hold the expected value.
export function expectFields(row: Record<string, unknown>, expected: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(expected)) {
    if (value !== undefined && row[key] !== value) throw new ToolError('readback-failed');
  }
}

// Fresh `{data, includes}` read of a card, for card-scoped write read-backs.
export const readCard = (cardId: string, token: string) => request({
  path: apiPath`/api/v1/cards/${cardId}`,
  token,
  schema: z.looseObject({ data: rowWithId, includes: z.looseObject({}).optional() }),
});

// Find the written object in a list read; a miss means the write did not stick.
export function findRow<T extends Record<string, unknown>>(rows: T[], key: string, id: string): T {
  const found = rows.find((row) => row[key] === id);
  if (!found) throw new ToolError('readback-failed');
  return found;
}

// Delete read-back: the object's GET must now 404.
export async function assertGone(path: string, token: string): Promise<void> {
  const res = await apiFetch(path, token);
  await res.body?.cancel();
  if (res.status === 404) return;
  throw new ToolError(res.ok ? 'delete-failed' : `http-${String(res.status)}`);
}

const redact = (text: string, token: string) => (token ? text.replaceAll(token, '<redacted>') : text);

// Runs a tool body: JSON text on success, `Error: <code>` on failure, token redacted either way.
export async function runTool(token: string, body: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return { content: [{ type: 'text', text: redact(JSON.stringify(await body()), token) }] };
  } catch (error) {
    const code = error instanceof ToolError ? error.code : 'internal';
    return { content: [{ type: 'text', text: `Error: ${redact(code, token)}` }], isError: true };
  }
}
