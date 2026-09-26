import { describe, expect, it } from 'bun:test';
import type { Board } from '../../Board/api';
import { boardRouteIdFromPath, filterBoards } from '../helpers';

const board = (id: string, title: string, workspaceId: string) =>
  ({ id, title, workspaceId, state: 'ACTIVE', visibility: 'PRIVATE', createdAt: '' }) as Board;

const boards = [board('1', 'rotations', 'w1'), board('2', 'Framework', 'w1'), board('3', 'Personal ROTA', 'w2')];

describe('BoardSwitcher helpers', () => {
  it('filters by workspace, searches case-insensitively and sorts by title', () => {
    expect(filterBoards(boards, { workspaceFilter: 'all', query: '' }).map((b) => b.id)).toEqual(['2', '3', '1']);
    expect(filterBoards(boards, { workspaceFilter: 'w1', query: '' }).map((b) => b.id)).toEqual(['2', '1']);
    expect(filterBoards(boards, { workspaceFilter: 'all', query: ' ROT' }).map((b) => b.id)).toEqual(['3', '1']);
  });

  it('extracts the board route id from a path', () => {
    expect(boardRouteIdFromPath('/b/abc123/framework')).toBe('abc123');
    expect(boardRouteIdFromPath('/c/xyz')).toBeNull();
  });
});
