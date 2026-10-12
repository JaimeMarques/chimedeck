import { z } from 'zod';
import { apiPath, dataOf, readCard, request, rowWithId, ToolError } from './toolSupport';
import { identity, type Row } from './results';

// Explicit description reads preserve search rows; fresh hierarchy checks fail
// closed if a card moved between the non-atomic search and detail requests.
export async function describeSearch<T extends { data: Row[] }>(
  response: T,
  workspaceId: string,
  token: string,
  limit: number
): Promise<T> {
  if (response.data.length > limit || response.data.length > 100)
    throw new ToolError('invalid-response');
  const missing = new Map<string, Row>();
  const seen = new Map<string, Row>();
  for (const row of response.data) {
    if (row.type !== 'card') continue;
    for (const key of ['id', 'list_id', 'board_id']) {
      if (!z.uuid().safeParse(row[key]).success) throw new ToolError('invalid-response');
    }
    if (
      typeof row.workspace_id !== 'string' ||
      identity(row.workspace_id) !== identity(workspaceId)
    )
      throw new ToolError('invalid-response');
    const previous = seen.get(identity(String(row.id)));
    if (previous) {
      for (const key of ['list_id', 'board_id', 'workspace_id', 'description']) {
        if (
          Object.hasOwn(previous, key) &&
          Object.hasOwn(row, key) &&
          (key.endsWith('_id')
            ? identity(String(previous[key])) !== identity(String(row[key]))
            : previous[key] !== row[key])
        )
          throw new ToolError('invalid-response');
      }
    }
    if (!previous || Object.hasOwn(row, 'description')) seen.set(identity(String(row.id)), row);
    if (Object.hasOwn(row, 'description')) {
      if (row.description !== null && typeof row.description !== 'string')
        throw new ToolError('invalid-response');
      continue;
    }
    missing.set(identity(String(row.id)), row);
  }
  const boards = new Set<string>();
  const descriptions = new Map<string, string | null>();
  for (const [cardId, row] of missing) {
    const card = await readCard(cardId, token);
    const includes = z
      .object({
        list: z.looseObject({ id: z.string(), board_id: z.string() }),
        board: z.looseObject({ id: z.string() }),
      })
      .safeParse(card.includes);
    if (
      !includes.success ||
      identity(card.data.id) !== cardId ||
      typeof card.data.list_id !== 'string' ||
      identity(card.data.list_id) !== identity(String(row.list_id)) ||
      identity(includes.data.list.id) !== identity(String(row.list_id)) ||
      identity(includes.data.list.board_id) !== identity(String(row.board_id)) ||
      identity(includes.data.board.id) !== identity(String(row.board_id)) ||
      !('description' in card.data) ||
      (card.data.description !== null && typeof card.data.description !== 'string')
    )
      throw new ToolError('invalid-response');
    const boardId = identity(String(row.board_id));
    if (!boards.has(boardId)) {
      const board = await request({
        path: apiPath`/api/v1/boards/${boardId}`,
        token,
        schema: dataOf(rowWithId),
      });
      if (
        identity(board.data.id) !== boardId ||
        typeof board.data.workspace_id !== 'string' ||
        identity(board.data.workspace_id) !== identity(workspaceId)
      )
        throw new ToolError('invalid-response');
      boards.add(boardId);
    }
    descriptions.set(cardId, card.data.description);
  }
  return {
    ...response,
    data: response.data.map((row) => {
      if (row.type !== 'card') return row;
      const cardId = identity(String(row.id));
      if (Object.hasOwn(row, 'description')) {
        if (descriptions.has(cardId) && descriptions.get(cardId) !== row.description)
          throw new ToolError('invalid-response');
        return row;
      }
      return { ...row, description: descriptions.get(cardId) };
    }),
  };
}
