import { strict as assert } from 'node:assert';
import { mock } from 'bun:test';
import Knex from 'knex';

// Subprocess-isolated real middleware and SQL-builder checks; no live DB.
const server = new URL('../../../../../../', import.meta.url).pathname;
type Row = Record<string, unknown>;
let board: Row = { id: 'board', workspace_id: 'ws', visibility: 'PUBLIC' };
let memberships: Row[] = [];
let boardMember: Row | undefined;
let guest: Row | undefined;
let authenticated = false;
let authCalls = 0;
function db(table: string) {
  const query = {
    where: () => query,
    select: () => Promise.resolve(memberships),
    first: async () => table === 'boards' ? board : table === 'board_members' ? boardMember : guest,
  };
  return query;
}
mock.module(`${server}common/db.ts`, () => ({ db }));
mock.module(`${server}common/ids/resolveEntityId.ts`, () => ({
  resolveBoardId: async (id: string) => id,
  resolveCardId: async (id: string) => id,
  resolveListId: async (id: string) => id,
}));
mock.module(`${server}extensions/auth/middlewares/authentication.ts`, () => ({
  authenticate: async (req: Request) => {
    authCalls++;
    if (!authenticated) return Response.json({ error: { code: 'unauthorized' } }, { status: 401 });
    Object.assign(req, { currentUser: { id: 'user', email: 'user@example.test' } });
    return null;
  },
}));
mock.module(`${server}common/avatar/resolveAvatarUrl.ts`, () => ({ buildAvatarProxyUrl: () => null }));
const { applyBoardVisibility } = await import(`${server}middlewares/boardVisibility.ts`);
const { canUserAccessBoard, canUserReceiveBoardWebhook } = await import('../../../../access');
const { buildNotificationListQuery } = await import('../../../../../notifications/api/list');
function req(method: string, suffix = '', credentials = false) {
  return new Request(`https://example.test/api/v1/boards/board${suffix}`, {
    method, headers: credentials ? { authorization: 'Bearer invalid-test-token' } : {},
  });
}
assert.equal(await applyBoardVisibility(req('GET'), 'board'), null);
assert.equal(authCalls, 0, 'anonymous public reads need no login');
assert.equal(await applyBoardVisibility(req('HEAD'), 'board'), null);
assert.equal(await applyBoardVisibility(req('GET', '', true), 'board'), null, 'invalid credentials must not disable public reads');
assert.equal((await applyBoardVisibility(req('POST'), 'board'))?.status, 401);
authenticated = true;
assert.equal(await applyBoardVisibility(req('POST', '/star'), 'board'), null);
assert.equal(await applyBoardVisibility(req('DELETE', '/follow'), 'board'), null);
assert.equal((await applyBoardVisibility(req('POST', '/members/join'), 'board'))?.status, 403);
memberships = [{ role: 'MEMBER' }];
assert.equal(await applyBoardVisibility(req('POST'), 'board'), null);
board.visibility = 'PRIVATE';
assert.equal((await applyBoardVisibility(req('GET'), 'board'))?.status, 403);
boardMember = { user_id: 'user', board_id: 'board' };
assert.equal(await applyBoardVisibility(req('GET'), 'board'), null);
memberships = [{ role: 'GUEST' }];
assert.equal((await applyBoardVisibility(req('GET'), 'board'))?.status, 403, 'stale board membership does not grant guest access');
guest = { user_id: 'user', board_id: 'board', guest_type: 'VIEWER' };
const guestReq = req('GET');
assert.equal(await applyBoardVisibility(guestReq, 'board'), null);
assert.equal((guestReq as Request & { guestType: string }).guestType, 'VIEWER');
memberships = [];
assert.equal(await canUserAccessBoard('user', board as never, db as never), false);
assert.equal(await canUserReceiveBoardWebhook('user', board as never, db as never), false);
memberships = [{ role: 'ADMIN' }];
assert.equal(await canUserAccessBoard('user', board as never, db as never), true);
const sqlDb = Knex({ client: 'pg' });
const sql = buildNotificationListQuery(sqlDb, 'user', 20).toSQL().sql;
assert.ok(sql.includes('card_board_list.board_id = notifications.board_id'));
assert.ok(sql.includes('notifications.board_id IS NULL OR cards.id IS NOT NULL'));
assert.ok(sql.includes('"source_comment"."id" as "source_comment_id"'));
assert.ok(sql.includes("THEN notifications.list_title ELSE COALESCE(notifications.list_title, lists.title)"));
assert.ok(!sql.includes('"lists"."title" as "list_title"'), 'moved-card current list must not replace historical destination');
await sqlDb.destroy();
console.info('public-read/private-write identity, preference exceptions, private/guest visibility, webhook/socket access and historical notification SQL verified');
