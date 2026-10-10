import { strict as assert } from 'node:assert';
import { mock } from 'bun:test';

// Standalone, subprocess-isolated real-handler regression probe. This models
// lock-time revocation and atomic invite claims; it is NOT a PostgreSQL test.
const server = new URL('../../../../../../', import.meta.url).pathname;
type Row = Record<string, unknown>;
let memberships: Row[] = [];
let invites: Row[] = [];
let updates = 0;
let onLock: (() => void) | undefined;
const evicted: string[] = [];
function database(table: string) {
  const filter: Row = {};
  let acceptedNull = false;
  let expiresAfter: Date | undefined;
  let counting = false;
  const rows = () => (table === 'memberships' ? memberships : table === 'invites' ? invites : [])
    .filter(row => Object.entries(filter).every(([key, value]) => row[key] === value))
    .filter(row => !acceptedNull || row.accepted_at === null)
    .filter(row => !expiresAfter || new Date(row.expires_at as Date) > expiresAfter);
  const query = {
    where(key: Row | string, op?: unknown, value?: unknown) {
      if (typeof key === 'object') Object.assign(filter, key);
      else if (key === 'expires_at' && op === '>') expiresAfter = value as Date;
      else filter[key] = op;
      return query;
    },
    whereNull() { acceptedNull = true; return query; },
    select() { return Promise.resolve(rows()); },
    count() { counting = true; return query; },
    first() { return Promise.resolve(counting ? { count: rows().length } : rows()[0]); },
    update(patch: Row) {
      const selected = rows();
      for (const row of selected) Object.assign(row, patch);
      updates += selected.length;
      return Promise.resolve(selected);
    },
    insert(row: Row) { memberships.push(row); return Promise.resolve(); },
  };
  return query;
}
const db = Object.assign(database, {
  transaction: async (callback: (trx: typeof database) => unknown) => callback(db),
  raw: async () => { onLock?.(); onLock = undefined; },
});
mock.module(`${server}common/db.ts`, () => ({ db }));
mock.module(`${server}extensions/auth/middlewares/authentication.ts`, () => ({ authenticate: async () => null }));
mock.module(`${server}mods/cache/index.ts`, () => ({ memCache: { del: (key: string) => evicted.push(key) } }));
mock.module(`${server}extensions/workspace/common/config/invite.ts`, () => ({ inviteConfig: { cacheKeyPrefix: 'invite:' } }));
mock.module(`${server}mods/events/index.ts`, () => ({ writeEvent: async () => {} }));
const { handleUpdateMemberRole } = await import('../../updateRole');
const { consumeInvite } = await import('../../../../mods/invite/consume');
const { handleAcceptInvite } = await import('../../../invite/accept');
const { normalizeBoardMemberRole } = await import('../../../../../board/api/members/role');

function reset(actorRole = 'ADMIN', targetRole = 'MEMBER') {
  memberships = [
    { workspace_id: 'ws', user_id: 'actor', role: actorRole },
    { workspace_id: 'ws', user_id: 'target', role: targetRole },
  ];
  updates = 0;
  onLock = undefined;
  evicted.length = 0;
  invites = [{ id: 'invite-id', token: 'invite-token', workspace_id: 'ws', invited_email: 'target@example.test', role: 'MEMBER', accepted_at: null, expires_at: new Date(Date.now() + 60_000) }];
}
function request(role: unknown) {
  return Object.assign(new Request('https://example.test/api/v1/workspaces/ws/members/target', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role }),
  }), { currentUser: { id: 'actor', email: 'actor@example.test' } });
}
reset('ADMIN', 'OWNER');
assert.equal((await handleUpdateMemberRole(request('MEMBER'), 'ws', 'target')).status, 403);
assert.equal(updates, 0);
reset();
assert.equal((await handleUpdateMemberRole(request('OWNER'), 'ws', 'target')).status, 403);
assert.equal(updates, 0);
reset('OWNER', 'MEMBER');
assert.equal((await handleUpdateMemberRole(request('MEMBER'), 'ws', 'actor')).status, 422);
assert.equal(updates, 0);
reset('ADMIN', 'GUEST');
assert.equal((await handleUpdateMemberRole(request('MEMBER'), 'ws', 'target')).status, 409);
assert.equal(updates, 0);
reset();
assert.equal((await handleUpdateMemberRole(request('observer'), 'ws', 'target')).status, 400);
reset();
onLock = () => { memberships[0]!.role = 'MEMBER'; };
assert.equal((await handleUpdateMemberRole(request('ADMIN'), 'ws', 'target')).status, 403);
assert.equal(updates, 0, 'lock-time revocation must invalidate earlier authorization');
reset();
const invite = invites[0]! as never;
memberships = [];
assert.equal(await consumeInvite({ invite, userId: 'target' }), true);
assert.equal(await consumeInvite({ invite, userId: 'target' }), false);
assert.equal(memberships.length, 1);
assert.deepEqual(evicted, ['invite:invite-token', 'invite:invite-token']);
reset('ADMIN', 'GUEST');
assert.equal(await consumeInvite({ invite: invites[0]! as never, userId: 'target' }), false);
assert.equal(invites[0]!.accepted_at, null, 'guest promotion must not consume the token');
reset();
invites[0]!.expires_at = new Date(0);
assert.equal(await consumeInvite({ invite: invites[0]! as never, userId: 'new-user' }), false);
reset();
const acceptRequest = Object.assign(new Request('https://example.test/api/v1/invites/invite-token/accept', { method: 'POST' }), { currentUser: { id: 'attacker', email: 'attacker@example.test' } });
assert.equal((await handleAcceptInvite(acceptRequest, 'invite-token')).status, 403);
assert.equal(invites[0]!.accepted_at, null);
assert.equal(normalizeBoardMemberRole(undefined, 'MEMBER'), 'MEMBER');
assert.equal(normalizeBoardMemberRole('admin'), 'ADMIN');
assert.equal(normalizeBoardMemberRole(null), null);
assert.equal(normalizeBoardMemberRole('observer'), null);
console.info('workspace role ceilings, last-owner invariant, lock-time reauthorization, invite atomicity/email binding and board role validation verified');
