import { describe, it, expect, mock } from 'bun:test';
import { rooms } from './index';

let allowAccess = true;

const dbMockBase = () => ({
  where: () => ({
    first: () =>
      Promise.resolve({ id: 'test-board', workspace_id: 'ws-1', visibility: 'PRIVATE' }),
  }),
});
const dbMock = Object.assign(dbMockBase, {
  transaction: (callback: (trx: typeof dbMockBase) => unknown) =>
    Promise.resolve(callback(dbMockBase)),
});
await mock.module('../../../../common/db', () => ({ db: dbMock }));
await mock.module('../../../workspace/api/members/lock', () => ({
  lockWorkspaceMembershipMutations: () => Promise.resolve(),
}));
await mock.module('../../../board/access', () => ({
  canUserAccessBoard: async () => allowAccess,
}));

const { broadcast } = await import('./broadcast');

describe('broadcast', () => {
  it('does nothing when room does not exist', async () => {
    await broadcast({ boardId: 'nonexistent-board', message: 'test' });
  });

  it('sends message to authorized sockets in room', async () => {
    allowAccess = true;
    const sent: string[] = [];
    const fakeWs = {
      send: (msg: string) => sent.push(msg),
      data: { userId: 'u1', token: 't', subscribedBoards: new Set<string>(['test-board']) },
    } as never;

    rooms.set('test-board', new Set([fakeWs]));
    await broadcast({ boardId: 'test-board', message: 'hello' });
    rooms.delete('test-board');

    expect(sent).toEqual(['hello']);
  });

  it('revokes a stale subscription instead of leaking the event', async () => {
    allowAccess = false;
    const sent: string[] = [];
    const subscriptions = new Set<string>(['test-board']);
    const fakeWs = {
      send: (msg: string) => sent.push(msg),
      data: { userId: 'u1', token: 't', subscribedBoards: subscriptions },
    } as never;
    rooms.set('test-board', new Set([fakeWs]));

    await broadcast({ boardId: 'test-board', message: 'private-data' });

    expect(sent).toEqual([JSON.stringify({ type: 'access_revoked', board_id: 'test-board' })]);
    expect(subscriptions.has('test-board')).toBe(false);
    rooms.delete('test-board');
  });
});
