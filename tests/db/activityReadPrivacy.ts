// Real PostgreSQL regression: activity reads never return the audit-only
// ip_address / user_agent columns to clients.
// Run only against a disposable, fully migrated sandbox DB:
//   CHIMEDECK_TEST_SANDBOX=1 DATABASE_URL=postgres://.../chimedeck_test \
//     bun run tests/db/activityReadPrivacy.ts
// Never import the app's shared DB before validating the target: this script writes fixtures.
import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';

const databaseUrl = Bun.env.DATABASE_URL;
assert.equal(Bun.env.CHIMEDECK_TEST_SANDBOX, '1', 'Explicit CHIMEDECK_TEST_SANDBOX=1 opt-in required');
assert.ok(databaseUrl, 'DATABASE_URL must point to a disposable PostgreSQL database');
const url = new URL(databaseUrl);
const databaseName = decodeURIComponent(url.pathname.slice(1));
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'PostgreSQL URL required');
assert.match(databaseName, /(?:^|[_-])(test|preflight|scratch|sandbox)(?:$|[_-])/i, 'Refusing to write to a database without a test/preflight/scratch/sandbox name');
assert.ok(['localhost', '127.0.0.1', 'postgres', 'db'].includes(url.hostname), 'Refusing non-local PostgreSQL host');

const { db } = await import('../../server/common/db');
const { handleGetCard } = await import('../../server/extensions/card/api/get');
const { handleGetBoard } = await import('../../server/extensions/board/api/get');
const { handleCardActivity } = await import('../../server/extensions/activity/api/cardActivity');
const { handleBoardActivity } = await import('../../server/extensions/activity/api/boardActivity');

const workspaceId = randomUUID();
const ownerId = randomUUID();
const boardId = randomUUID();
const listId = randomUUID();
const cardId = randomUUID();
const activityId = randomUUID();
const tokenId = randomUUID();
const token = `hf_${randomUUID()}`;
const shortId = () => randomUUID().slice(0, 8);

function get(path: string, authenticated: boolean): Request {
  return new Request(`http://localhost${path}`, {
    headers: authenticated ? { authorization: `Bearer ${token}` } : {},
  });
}

// Non-vacuous: the handler must succeed and return the fixture row with its
// public fields before the absence of the audit columns means anything.
async function assertActivitiesHideAudit(
  label: string,
  response: Response,
  pick: (body: unknown) => unknown,
): Promise<void> {
  assert.equal(response.status, 200, `${label}: expected 200`);
  const rows = pick(await response.json()) as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(rows), `${label}: activities array missing`);
  const row = rows.find((r) => r.id === activityId);
  assert.ok(row, `${label}: fixture activity missing`);
  assert.equal(row.action, 'card_created');
  assert.equal(row.entity_id, cardId);
  assert.ok(!('ip_address' in row), `${label}: ip_address exposed`);
  assert.ok(!('user_agent' in row), `${label}: user_agent exposed`);
  console.info(`PASS ${label} hides ip_address and user_agent`);
}

async function cleanup(): Promise<void> {
  await db('activities').where({ id: activityId }).delete();
  await db('api_tokens').where({ id: tokenId }).delete();
  await db('cards').where({ id: cardId }).delete();
  await db('lists').where({ id: listId }).delete();
  await db('boards').where({ id: boardId }).delete();
  await db('memberships').where({ workspace_id: workspaceId }).delete();
  await db('workspaces').where({ id: workspaceId }).delete();
  await db('users').where({ id: ownerId }).delete();
}

try {
  const identity = await db.raw<{ rows: Array<{ name: string }> }>('SELECT current_database() AS name');
  assert.equal(identity.rows[0]?.name, databaseName);

  await db('users').insert({ id: ownerId, email: `${ownerId}@example.test`, name: 'Fixture owner', email_verified: true });
  await db('workspaces').insert({ id: workspaceId, name: `activity-privacy-${shortId()}`, owner_id: ownerId });
  await db('memberships').insert({ workspace_id: workspaceId, user_id: ownerId, role: 'OWNER' });
  // PUBLIC: the board feeds are readable without authentication.
  await db('boards').insert({ id: boardId, workspace_id: workspaceId, title: 'Public', visibility: 'PUBLIC', short_id: shortId() });
  await db('lists').insert({ id: listId, board_id: boardId, title: 'List', short_id: shortId(), position: 'a0' });
  await db('cards').insert({ id: cardId, list_id: listId, title: 'Fixture', short_id: shortId(), position: 'a0', archived: false });
  await db('activities').insert({
    id: activityId,
    entity_type: 'card',
    entity_id: cardId,
    board_id: boardId,
    action: 'card_created',
    actor_id: ownerId,
    payload: JSON.stringify({ cardId, cardTitle: 'Fixture' }),
    ip_address: '203.0.113.7',
    user_agent: 'Fixture-Agent/1.0',
  });
  await db('api_tokens').insert({
    id: tokenId, user_id: ownerId, name: 'Disposable activity privacy token',
    token_hash: createHash('sha256').update(token).digest('hex'), token_prefix: token.slice(0, 10),
  });

  await assertActivitiesHideAudit(
    'GET /boards/:id/activity (anonymous, PUBLIC board)',
    await handleBoardActivity(get(`/api/v1/boards/${boardId}/activity`, false), boardId),
    (body) => (body as { data: unknown }).data,
  );
  await assertActivitiesHideAudit(
    'GET /boards/:id?include=activities (anonymous, PUBLIC board)',
    await handleGetBoard(get(`/api/v1/boards/${boardId}?include=activities`, false), boardId),
    (body) => (body as { includes: { activities: unknown } }).includes.activities,
  );
  await assertActivitiesHideAudit(
    'GET /cards/:id/activity',
    await handleCardActivity(get(`/api/v1/cards/${cardId}/activity`, true), cardId),
    (body) => (body as { data: unknown }).data,
  );
  await assertActivitiesHideAudit(
    'GET /cards/:id?include=activities',
    await handleGetCard(get(`/api/v1/cards/${cardId}?include=activities`, true), cardId),
    (body) => (body as { includes: { activities: unknown } }).includes.activities,
  );

  // Writers keep storing the audit columns; only reads drop them.
  const stored = await db('activities').where({ id: activityId }).first<{ ip_address: string; user_agent: string }>();
  assert.equal(stored?.ip_address, '203.0.113.7');
  assert.equal(stored?.user_agent, 'Fixture-Agent/1.0');
} finally {
  try { await cleanup(); } finally { await db.destroy(); }
}
