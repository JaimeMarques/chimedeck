// Pure helpers for the board switcher — kept store-free so they are trivially testable.
import type { Board } from '../Board/api';

// 'all' or a workspace id
export type WorkspaceFilter = string;

export function filterBoards(
  boards: Board[],
  { workspaceFilter, query }: { workspaceFilter: WorkspaceFilter; query: string },
): Board[] {
  const q = query.trim().toLowerCase();
  return boards
    .filter((b) => workspaceFilter === 'all' || b.workspaceId === workspaceFilter)
    .filter((b) => !q || b.title.toLowerCase().includes(q))
    .sort((a, b) => a.title.localeCompare(b.title));
}

// Match a /b/:routeId path segment against a board's short id or uuid.
export function boardRouteIdFromPath(pathname: string): string | null {
  return /^\/b\/([^/]+)/.exec(pathname)?.[1] ?? null;
}
