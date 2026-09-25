// server/extensions/realtime/mods/rooms/broadcast.ts
// Broadcasts serialised events in board sequence order, reauthorizing every socket.
import { db } from '../../../../common/db';
import { canUserAccessBoard, type BoardAccessRow } from '../../../board/access';
import { lockWorkspaceMembershipMutations } from '../../../workspace/api/members/lock';
import { rooms } from './index';

const boardQueues = new Map<string, Promise<void>>();

async function performBroadcast(boardId: string, message: string): Promise<void> {
  const room = rooms.get(boardId);
  if (!room) return;

  let board: BoardAccessRow | undefined;
  try {
    board = (await db('boards').where({ id: boardId }).first()) as BoardAccessRow | undefined;
  } catch {
    return;
  }
  if (!board) return;
  await db.transaction(async (trx) => {
    await lockWorkspaceMembershipMutations(trx, board.workspace_id);
    for (const ws of [...room]) {
      try {
        if (!(await canUserAccessBoard(ws.data.userId, board, trx))) {
          room.delete(ws);
          ws.data.subscribedBoards.delete(boardId);
          ws.send(JSON.stringify({ type: 'access_revoked', board_id: boardId }));
          continue;
        }
        ws.send(message);
      } catch {
        // Dead socket — will be cleaned up by heartbeat.
      }
    }
  });
}

export function broadcast({
  boardId,
  message,
}: {
  boardId: string;
  message: string;
}): Promise<void> {
  const previous = boardQueues.get(boardId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => performBroadcast(boardId, message));
  boardQueues.set(boardId, next);
  void next.finally(() => {
    if (boardQueues.get(boardId) === next) boardQueues.delete(boardId);
  });
  return next;
}
