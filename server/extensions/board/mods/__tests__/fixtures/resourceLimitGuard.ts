import { strict as assert } from 'node:assert';
import { mock } from 'bun:test';

const server = new URL('../../../../../', import.meta.url).pathname;
let enabled = false;
let tier = 'tier_1';
let tierCalls = 0;
mock.module(`${server}config/env.ts`, () => ({ env: { get SUBSCRIPTIONS_ENABLED() { return enabled; } } }));
mock.module(`${server}extensions/subscription/common/subscriptionRepo.ts`, () => ({
  getCurrentTier: async () => { tierCalls++; return tier; },
}));
const { prepareBoardLimitGuard } = await import('../../resourceLimitGuard');
let guard = await prepareBoardLimitGuard('ws');
assert.equal(guard('maxBoardsPerWorkspace', 100), null);
assert.equal(tierCalls, 0);
enabled = true;
guard = await prepareBoardLimitGuard('ws');
assert.equal(tierCalls, 1);
assert.equal(guard('maxBoardsPerWorkspace', 0), null);
const response = guard('maxBoardsPerWorkspace', 1)!;
assert.equal(response.status, 402);
assert.equal((await response.json()).error.data.upgradeUrl, '/workspace/ws/billing');
assert.equal(guard('maxBoardsTotal', 1)?.status, 402);
assert.equal(tierCalls, 1, 'using the prepared guard must never acquire a pool connection');
tier = 'unlimited';
guard = await prepareBoardLimitGuard('ws');
assert.equal(guard('maxBoardsPerWorkspace', 10_000), null);
console.info('upstream subscription bypass, quota response and pool-safe prepared guard verified');
