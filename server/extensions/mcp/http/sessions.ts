import { db } from '../../../common/db';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

export interface McpSession {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  userId: string;
  lastActiveAt: Date;
}

// [why] Transport objects contain live sockets and cannot be serialized to the DB.
// We keep a per-instance in-memory Map as a fast cache. The DB (mcp_sessions table)
// is the distributed source of truth for session metadata (userId, liveness).
// If a request arrives on an instance that doesn't have the transport cached,
// the handler returns 404 and the client re-initializes — standard MCP pattern
// for horizontal scaling without sticky sessions or cookies.
const transportCache = new Map<string, McpSession>();

const SESSION_TTL_MS = 30 * 60_000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60_000; // 5 minutes

// ── DB helpers ────────────────────────────────────────────────────────────────

async function dbInsertSession(id: string, userId: string): Promise<void> {
  await db('mcp_sessions').insert({
    id,
    user_id: userId,
    last_active_at: db.fn.now(),
  });
}

async function dbGetSession(
  id: string
): Promise<{ userId: string; lastActiveAt: Date } | undefined> {
  const row = await db('mcp_sessions')
    .where({ id })
    .select<{ user_id: string; last_active_at: Date }>('user_id', 'last_active_at')
    .first();
  if (!row) return undefined;
  return { userId: row.user_id, lastActiveAt: row.last_active_at };
}

async function dbTouchSession(id: string): Promise<void> {
  await db('mcp_sessions').where({ id }).update({ last_active_at: db.fn.now() });
}

async function dbDeleteSession(id: string): Promise<void> {
  await db('mcp_sessions').where({ id }).del();
}

async function dbEvictStale(): Promise<void> {
  const cutoff = new Date(Date.now() - SESSION_TTL_MS);
  await db('mcp_sessions').where('last_active_at', '<', cutoff).del();
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Publish the local transport synchronously, then persist metadata best-effort. */
export async function initSession(
  id: string,
  userId: string,
  server: McpSession['server'],
  transport: McpSession['transport']
): Promise<void> {
  const session = { server, transport, userId, lastActiveAt: new Date() };
  transportCache.set(id, session);
  await dbInsertSession(id, userId);
  // [why] DELETE or eviction can remove the local transport while insertion is
  // pending. Compensate after it completes so late persistence cannot retain
  // metadata for a terminated session. Never publish the transport again here.
  if (transportCache.get(id) !== session) await dbDeleteSession(id);
}

/** Look up session: local transport cache first, DB metadata as fallback. */
export async function getSession(
  id: string
): Promise<{ userId: string; transport?: WebStandardStreamableHTTPServerTransport } | null> {
  const local = transportCache.get(id);
  if (local) {
    return { userId: local.userId, transport: local.transport };
  }

  // [why] Transport not cached locally — check if the session exists on another instance.
  const dbRow = await dbGetSession(id);
  if (dbRow) {
    // Session exists elsewhere. Return userId so the handler can verify ownership
    // but no transport — the caller will return 404 so the client re-initializes.
    return { userId: dbRow.userId };
  }

  return null;
}

/** Refresh liveness only after the handler has authenticated the session owner. */
export function touchSession(id: string): void {
  const local = transportCache.get(id);
  if (!local) return;

  local.lastActiveAt = new Date();
  // [why] Persistence is best-effort; a DB failure must not reject an owner request
  // or prevent the active local transport from surviving the eviction sweep.
  void dbTouchSession(id).catch(() => {});
}

/** Remove session from DB and local cache. */
export async function deleteSession(id: string): Promise<void> {
  const local = transportCache.get(id);
  if (local) {
    local.transport.close().catch(() => {});
    transportCache.delete(id);
  }
  await dbDeleteSession(id);
}

/** Periodic sweep: evict stale sessions from both DB and local cache. */
export function startEvictionLoop(): void {
  setInterval(() => {
    dbEvictStale().catch(() => {});

    const cutoff = new Date(Date.now() - SESSION_TTL_MS);
    for (const [id, session] of transportCache) {
      if (session.lastActiveAt < cutoff) {
        session.transport.close().catch(() => {});
        transportCache.delete(id);
      }
    }
  }, CLEANUP_INTERVAL_MS);
}
