// Real PostgreSQL check of the 0125 created_by backfill: rolls that one
// migration down, seeds card_created activities, runs it up, checks each case,
// then repeats down/up. Run only against a disposable, fully migrated sandbox DB:
//   CHIMEDECK_TEST_SANDBOX=1 DATABASE_URL=postgres://.../chimedeck_test \
//     bun run tests/db/cardCreatedByBackfill.ts
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Knex from 'knex';

const databaseUrl = Bun.env.DATABASE_URL;
assert.equal(Bun.env.CHIMEDECK_TEST_SANDBOX, '1', 'Explicit CHIMEDECK_TEST_SANDBOX=1 opt-in required');
assert.ok(databaseUrl, 'DATABASE_URL must point to a disposable PostgreSQL database');
const url = new URL(databaseUrl);
const databaseName = decodeURIComponent(url.pathname.slice(1));
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'PostgreSQL URL required');
assert.match(databaseName, /(?:^|[_-])(test|preflight|scratch|sandbox)(?:$|[_-])/i, 'Refusing to write to a database without a test/preflight/scratch/sandbox name');
assert.ok(['localhost', '127.0.0.1', 'postgres', 'db'].includes(url.hostname), 'Refusing non-local PostgreSQL host');

const MIGRATION = '0125_card_created_by.ts';
const db = Knex({
  client: 'pg',
  connection: databaseUrl,
  migrations: { directory: join(import.meta.dir, '../../db/migrations'), loadExtensions: ['.ts'] },
});

const ownerId = randomUUID();
const otherId = randomUUID();
const workspaceId = randomUUID();
const boardId = randomUUID();
const listId = randomUUID();
const shortId = () => randomUUID().slice(0, 8);
// Expected creator per card; null means the backfill must leave it NULL.
const cases = {
  singleUser: { id: randomUUID(), expected: ownerId },
  trelloBeatsEarlierNative: { id: randomUUID(), expected: otherId },
  earliestNative: { id: randomUUID(), expected: ownerId },
  system: { id: randomUUID(), expected: null },
  unknownActor: { id: randomUUID(), expected: null },
  trelloUnknownBeatsNativeUser: { id: randomUUID(), expected: null },
  noActivity: { id: randomUUID(), expected: null },
} satisfies Record<string, { id: string; expected: string | null }>;
const cardIds = Object.values(cases).map((c) => c.id);

function created(cardId: string, actorId: string, at: string, payload: object = {}) {
  return {
    id: randomUUID(), entity_type: 'card', entity_id: cardId, board_id: boardId,
    action: 'card_created', actor_id: actorId, payload: JSON.stringify(payload), created_at: at,
  };
}

async function cleanup(): Promise<void> {
  await db('activities').whereIn('entity_id', cardIds).delete();
  await db('cards').whereIn('id', cardIds).delete();
  await db('lists').where({ id: listId }).delete();
  await db('boards').where({ id: boardId }).delete();
  await db('memberships').where({ workspace_id: workspaceId }).delete();
  await db('workspaces').where({ id: workspaceId }).delete();
  await db('users').whereIn('id', [ownerId, otherId]).delete();
}

async function assertBackfill(): Promise<void> {
  const rows = await db('cards').whereIn('id', cardIds).select<{ id: string; created_by: string | null }[]>('id', 'created_by');
  const byId = new Map(rows.map((row) => [row.id, row.created_by]));
  for (const [name, { id, expected }] of Object.entries(cases)) {
    assert.equal(byId.get(id), expected, `${name}: created_by`);
  }
}

try {
  const [applied] = await db('knex_migrations').where({ name: MIGRATION }).select('id');
  assert.ok(applied, `${MIGRATION} must be applied before this check`);
  await db.migrate.down({ name: MIGRATION });
  assert.equal(await db.schema.hasColumn('cards', 'created_by'), false);

  await db('users').insert([
    { id: ownerId, email: `${ownerId}@example.test`, name: 'Owner', email_verified: true },
    { id: otherId, email: `${otherId}@example.test`, name: 'Trello creator', email_verified: true },
  ]);
  await db('workspaces').insert({ id: workspaceId, name: `created-by-${shortId()}`, owner_id: ownerId });
  await db('memberships').insert({ workspace_id: workspaceId, user_id: ownerId, role: 'OWNER' });
  await db('boards').insert({ id: boardId, workspace_id: workspaceId, title: 'Backfill', visibility: 'PRIVATE', short_id: shortId() });
  await db('lists').insert({ id: listId, board_id: boardId, title: 'Todo', short_id: shortId(), position: 'a0' });
  await db('cards').insert(cardIds.map((id, i) => ({ id, list_id: listId, short_id: shortId(), title: `Card ${i}`, position: `a${i}`, archived: false })));
  const trello = { trello_action_id: 'trello-action-1' };
  await db('activities').insert([
    created(cases.singleUser.id, ownerId, '2026-01-01T00:00:00Z'),
    created(cases.trelloBeatsEarlierNative.id, ownerId, '2026-01-01T00:00:00Z'),
    created(cases.trelloBeatsEarlierNative.id, otherId, '2026-02-01T00:00:00Z', trello),
    created(cases.earliestNative.id, otherId, '2026-02-01T00:00:00Z'),
    created(cases.earliestNative.id, ownerId, '2026-01-01T00:00:00Z'),
    created(cases.system.id, 'system', '2026-01-01T00:00:00Z'),
    created(cases.unknownActor.id, randomUUID(), '2026-01-01T00:00:00Z'),
    created(cases.trelloUnknownBeatsNativeUser.id, ownerId, '2026-01-01T00:00:00Z'),
    created(cases.trelloUnknownBeatsNativeUser.id, 'trello-member-unmapped', '2026-02-01T00:00:00Z', trello),
    // Other actions never count as the creator.
    { ...created(cases.noActivity.id, ownerId, '2026-01-01T00:00:00Z'), action: 'card_moved' },
  ]);

  await db.migrate.up({ name: MIGRATION });
  await assertBackfill();

  await db.migrate.down({ name: MIGRATION });
  assert.equal(await db.schema.hasColumn('cards', 'created_by'), false);
  await db.migrate.up({ name: MIGRATION });
  await assertBackfill();

  // The FK keeps created_by honest when a creator account is deleted.
  await db('users').where({ id: otherId }).delete();
  const [orphaned] = await db('cards').where({ id: cases.trelloBeatsEarlierNative.id }).select<{ created_by: string | null }[]>('created_by');
  assert.equal(orphaned?.created_by, null);
  console.info('PASS 0125 backfills created_by from card_created activity and survives down/up');
} finally {
  await cleanup();
  // Leave the sandbox migrated even when an assertion failed between down and up.
  if (!(await db.schema.hasColumn('cards', 'created_by'))) await db.migrate.up({ name: MIGRATION });
  await db.destroy();
}
