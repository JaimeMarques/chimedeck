// Workspace creation's board-limit response contracts track canonical pricing.
import { describe, expect, test } from 'bun:test';
import { buildLimitResponse, resolveQuota } from '../../../../middlewares/limitGuard';

describe('workspace creation limit enforcement', () => {
  test('resolves personal, hobby, and enterprise board quotas', () => {
    expect(resolveQuota('tier_1', 'maxBoardsPerWorkspace')).toBe(1);
    expect(resolveQuota('tier_2', 'maxBoardsPerWorkspace')).toBe(10);
    expect(resolveQuota('unlimited', 'maxBoardsPerWorkspace')).toBe('unlimited');
  });
  test('personal allows zero and rejects one board', () => {
    expect(buildLimitResponse('tier_1', 'maxBoardsPerWorkspace', 0, 'ws_1')).toBeNull();
    expect(buildLimitResponse('tier_1', 'maxBoardsPerWorkspace', 1, 'ws_1')?.status).toBe(402);
  });
  test('hobby allows nine and rejects ten boards', () => {
    expect(buildLimitResponse('tier_2', 'maxBoardsPerWorkspace', 9, 'ws_1')).toBeNull();
    expect(buildLimitResponse('tier_2', 'maxBoardsPerWorkspace', 10, 'ws_1')?.status).toBe(402);
  });
  test('enterprise is unbounded', () => {
    expect(buildLimitResponse('unlimited', 'maxBoardsPerWorkspace', 10_000, 'ws_1')).toBeNull();
  });
  test('blocked response uses the workspace billing URL', async () => {
    const response = buildLimitResponse('tier_1', 'maxBoardsPerWorkspace', 1, 'ws_1')!;
    const body = await response.json();
    expect(body.error.code).toBe('limit-reached');
    expect(body.error.data).toEqual({
      limit: 'maxBoardsPerWorkspace', currentUsage: 1, quota: 1,
      upgradeUrl: '/workspace/ws_1/billing',
    });
  });
});
