// Guard contracts use the current canonical tier configuration, not old pricing.
import { describe, expect, test } from 'bun:test';
import { buildLimitResponse, resolveQuota } from '../../../../middlewares/limitGuard';

describe('board creation limits', () => {
  test('resolves personal, hobby, and enterprise board quotas', () => {
    expect(resolveQuota('tier_1', 'maxBoardsPerWorkspace')).toBe(1);
    expect(resolveQuota('tier_2', 'maxBoardsPerWorkspace')).toBe(10);
    expect(resolveQuota('unlimited', 'maxBoardsPerWorkspace')).toBe('unlimited');
    expect(resolveQuota('tier_1', 'maxBoardsTotal')).toBe(1);
    expect(resolveQuota('tier_2', 'maxBoardsTotal')).toBe(10);
    expect(resolveQuota('unlimited', 'maxBoardsTotal')).toBe('unlimited');
  });
  for (const limitKey of ['maxBoardsPerWorkspace', 'maxBoardsTotal'] as const) {
    test(`${limitKey}: personal allows zero and rejects one board`, () => {
      expect(buildLimitResponse('tier_1', limitKey, 0)).toBeNull();
      expect(buildLimitResponse('tier_1', limitKey, 1)?.status).toBe(402);
    });
    test(`${limitKey}: hobby allows nine and rejects ten boards`, () => {
      expect(buildLimitResponse('tier_2', limitKey, 9)).toBeNull();
      expect(buildLimitResponse('tier_2', limitKey, 10)?.status).toBe(402);
    });
    test(`${limitKey}: enterprise is unbounded`, () => {
      expect(buildLimitResponse('unlimited', limitKey, 10_000)).toBeNull();
    });
  }
  test('402 retains the upstream response and workspace billing link', async () => {
    const response = buildLimitResponse('tier_1', 'maxBoardsPerWorkspace', 1, 'ws_1')!;
    const body = await response.json();
    expect(body.error.code).toBe('limit-reached');
    expect(body.error.data).toEqual({
      limit: 'maxBoardsPerWorkspace', currentUsage: 1, quota: 1,
      upgradeUrl: '/workspace/ws_1/billing',
    });
  });
});
