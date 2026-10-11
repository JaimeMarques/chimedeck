// Actual AI tool handlers + disposable PostgreSQL; only provider/network delivery are doubled.
// CHIMEDECK_TEST_SANDBOX=1 DATABASE_URL=postgres://.../chimedeck_ai_test bun run tests/db/boardAiAuthorization.ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mock } from 'bun:test';
import type { BoardChatAssistToolCall } from '../../server/extensions/board/types';
import type { WorkspaceScopedRequest } from '../../server/middlewares/permissionManager';

assert.equal(Bun.env['CHIMEDECK_TEST_SANDBOX'], '1', 'Explicit disposable sandbox opt-in required');
const url = new URL(Bun.env['DATABASE_URL'] ?? '');
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Local host only');
assert.match(url.pathname, /(?:^|[_-])(test|sandbox|scratch|preflight)(?:$|[_-])/i);
const selected = Bun.env['AI_AUTH_TEST_CASE'];
const events: unknown[] = [];
const s3Reads: string[] = [];
void mock.module('../../server/extensions/attachment/common/config/s3', () => ({
  s3Config: { bucket: 'disposable-ai-fixture' },
  s3ServerClient: {
    send: (command: { input: { Key?: string } }) => {
      const key = command.input.Key ?? '';
      s3Reads.push(key);
      return Promise.resolve({
        Body: {
          transformToByteArray: () => Promise.resolve(new TextEncoder().encode(`content:${key}`)),
        },
      });
    },
  },
}));
void mock.module('../../server/mods/events/dispatch', () => ({
  dispatchEvent: (event: unknown) => {
    events.push(event);
    return Promise.resolve({});
  },
}));
void mock.module('../../server/extensions/activity/mods/createActivityEvent', () => ({
  emitCardCreated: (event: unknown) => {
    events.push(event);
    return Promise.resolve({});
  },
}));
const { db } = await import('../../server/common/db');
const { assistBoardChat, boardChatAssistDeps } =
  await import('../../server/extensions/board/mods/chat/assist');
const { createBoardCard } =
  await import('../../server/extensions/board/mods/chat/assist/createBoardCard');
const { readAttachments } =
  await import('../../server/extensions/board/mods/chat/assist/readAttachments');
const { lockWorkspaceMembershipMutations } =
  await import('../../server/extensions/workspace/api/members/lock');
const { lockBoardMemberMutations } = await import('../../server/extensions/board/api/members/lock');
const owner = randomUUID();
const actor = randomUUID();
const workspace = randomUUID();
const boardId = randomUUID();
const listId = randomUUID();
const board = {
  id: boardId,
  workspace_id: workspace,
  title: 'Private AI fixture',
  state: 'ACTIVE',
};
const request = new Request('http://localhost/ai') as WorkspaceScopedRequest;
request.currentUser = { id: actor, email: `${actor}@example.test` };
let failures = 0;
let scenarios = 0;
function tool(title: string): BoardChatAssistToolCall {
  return {
    id: randomUUID(),
    type: 'function',
    function: { name: 'create_board_card', arguments: JSON.stringify({ title, listId }) },
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function reset(role = 'MEMBER', member = true, guestType: string | null = null) {
  await db('board_members').where({ board_id: boardId, user_id: actor }).delete();
  await db('board_guest_access').where({ board_id: boardId, user_id: actor }).delete();
  await db('memberships').where({ workspace_id: workspace, user_id: actor }).delete();
  await db('memberships').insert({ workspace_id: workspace, user_id: actor, role });
  if (member)
    await db('board_members').insert({
      id: randomUUID(),
      board_id: boardId,
      user_id: actor,
      role: 'MEMBER',
    });
  if (guestType)
    await db('board_guest_access').insert({
      id: randomUUID(),
      board_id: boardId,
      user_id: actor,
      guest_type: guestType,
      granted_by: owner,
    });
  await db('boards').where({ id: boardId }).update({ visibility: 'PRIVATE', state: 'ACTIVE' });
  delete request.guestType;
  events.length = 0;
}
async function countCards() {
  const row = await db('cards')
    .where({ list_id: listId })
    .count<{ count: string }>('id as count')
    .first();
  return Number(row?.count ?? 0);
}
async function run(name: string, fn: () => Promise<void>) {
  if (selected && selected !== name) return;
  scenarios++;
  try {
    await fn();
    console.info(`PASS ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}`, error);
  }
}
async function providerPausedCreate(title: string) {
  const entered = deferred();
  const release = deferred();
  let iteration = 0;
  boardChatAssistDeps.fetchRecentBoardMessages = () => Promise.resolve([]);
  boardChatAssistDeps.requestBoardChatAssistCompletion = async () => {
    if (iteration++ > 0) return { status: 200, data: { model: 'fixture', message: '' } };
    entered.resolve();
    await release.promise;
    return { status: 200, data: { model: 'fixture', message: '', toolCalls: [tool(title)] } };
  };
  const pending = assistBoardChat({
    boardId,
    sessionId: randomUUID(),
    prompt: title,
    request,
    actorId: actor,
    board,
  });
  await entered.promise;
  return { pending, release: release.resolve };
}
async function revoke(change: 'member' | 'guest' | 'workspace') {
  await db.transaction(async (trx) => {
    await lockWorkspaceMembershipMutations(trx, workspace);
    await lockBoardMemberMutations(trx, boardId);
    if (change === 'member')
      await trx('board_members').where({ board_id: boardId, user_id: actor }).delete();
    if (change === 'guest')
      await trx('board_guest_access')
        .where({ board_id: boardId, user_id: actor })
        .update({ guest_type: 'VIEWER' });
    if (change === 'workspace')
      await trx('memberships').where({ workspace_id: workspace, user_id: actor }).delete();
  });
}
async function waitForWorkspaceLock(
  pending: Promise<unknown>,
  key = `workspace-memberships:${workspace}`
) {
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await db.raw<{ rows: { waiting: string }[] }>(
      `
      SELECT count(*) AS waiting FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted
        AND classid::bigint = ((hashtext(?)::bigint >> 32) & 4294967295)
        AND objid::bigint = (hashtext(?)::bigint & 4294967295)
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      [key, key]
    );
    if (Number(result.rows[0]?.waiting) > 0) return;
    assert.equal(settled, false, 'AI create completed while canonical authorization lock was held');
    await Bun.sleep(10);
  }
  assert.fail('AI create never waited for the canonical workspace membership lock');
}
try {
  const identity = await db.raw<{ rows: { name: string }[] }>('SELECT current_database() AS name');
  assert.equal(identity.rows[0]?.name, decodeURIComponent(url.pathname.slice(1)));
  await db('users').insert([
    { id: owner, email: `${owner}@example.test`, name: 'AI owner', email_verified: true },
    { id: actor, email: `${actor}@example.test`, name: 'AI actor', email_verified: true },
  ]);
  await db('workspaces').insert({
    id: workspace,
    owner_id: owner,
    name: 'AI authorization disposable fixture',
  });
  await db('memberships').insert({ workspace_id: workspace, user_id: owner, role: 'OWNER' });
  await db('boards').insert({
    ...board,
    visibility: 'PRIVATE',
    short_id: randomUUID().slice(0, 8),
  });
  await db('lists').insert({
    id: listId,
    board_id: boardId,
    title: 'Backlog',
    position: 'a0',
    short_id: randomUUID().slice(0, 8),
  });

  await run('revoke-wins-transaction-race', async () => {
    await reset();
    const before = await countCards();
    const paused = await providerPausedCreate(
      'must not insert while revocation transaction owns lock'
    );
    const revocation = await db.transaction();
    try {
      await lockWorkspaceMembershipMutations(revocation, workspace);
      await lockBoardMemberMutations(revocation, boardId);
      await revocation('board_members').where({ board_id: boardId, user_id: actor }).delete();
      paused.release();
      await waitForWorkspaceLock(paused.pending);
      await revocation.commit();
    } catch (error) {
      await revocation.rollback();
      paused.release();
      await paused.pending;
      throw error;
    }
    assert.equal((await paused.pending).status, 403);
    assert.equal(await countCards(), before);
    assert.equal(events.length, 0);
  });

  await run('create-wins-and-retains-locks-through-insert', async () => {
    await reset();
    const before = await countCards();
    const gateKey = `ai-insert:${listId}`;
    const functionName = `ai_insert_${randomUUID().replaceAll('-', '')}`;
    const triggerName = `${functionName}_trigger`;
    // Unique, fixture-only trigger: pause the real INSERT, not a mocked service.
    await db.raw(
      `CREATE FUNCTION ??() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.list_id = '${listId}' THEN
          PERFORM pg_advisory_xact_lock(hashtext('${gateKey}'));
        END IF;
        RETURN NEW;
      END $$`,
      [functionName]
    );
    await db.raw('CREATE TRIGGER ?? BEFORE INSERT ON cards FOR EACH ROW EXECUTE FUNCTION ??()', [
      triggerName,
      functionName,
    ]);
    const gate = await db.transaction();
    let paused: Awaited<ReturnType<typeof providerPausedCreate>> | undefined;
    let revocation: Promise<void> | undefined;
    try {
      await gate.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [gateKey]);
      paused = await providerPausedCreate('insert owns current authorization transaction');
      paused.release();
      await waitForWorkspaceLock(paused.pending, gateKey);
      // Both canonical locks must be held by the very backend blocked IN INSERT.
      const held = await db.raw<{ rows: { key: string; held: boolean }[] }>(
        `
        SELECT key, EXISTS (
          SELECT 1 FROM pg_locks granted WHERE granted.pid = waiting.pid
            AND granted.locktype = 'advisory' AND granted.granted
            AND granted.classid::bigint = ((hashtext(key)::bigint >> 32) & 4294967295)
            AND granted.objid::bigint = (hashtext(key)::bigint & 4294967295)
        ) AS held
        FROM pg_locks waiting CROSS JOIN unnest(?::text[]) AS key
        WHERE waiting.locktype = 'advisory' AND NOT waiting.granted
          AND waiting.classid::bigint = ((hashtext(?)::bigint >> 32) & 4294967295)
          AND waiting.objid::bigint = (hashtext(?)::bigint & 4294967295)
          AND waiting.database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
        [[`workspace-memberships:${workspace}`, `board-members:${boardId}`], gateKey, gateKey]
      );
      assert.equal(held.rows.length, 2);
      assert.ok(
        held.rows.every((row) => row.held),
        'actual INSERT backend must own both canonical locks'
      );
      assert.equal(await countCards(), before, 'insert is uncommitted while trigger waits');
      assert.equal(events.length, 0, 'no delivery before commit');
      revocation = revoke('member');
      await waitForWorkspaceLock(revocation);
      await gate.commit();
      const output = await paused.pending;
      assert.equal(output.status, 200);
      await revocation;
      assert.equal(await countCards(), before + 1);
      assert.equal(events.length, 2);
      assert.equal(
        await db('board_members').where({ board_id: boardId, user_id: actor }).first(),
        undefined
      );
    } finally {
      if (!gate.isCompleted()) await gate.rollback();
      paused?.release();
      if (paused) await paused.pending.catch(() => {});
      if (revocation) await revocation.catch(() => {});
      await db.raw('DROP TRIGGER IF EXISTS ?? ON cards', [triggerName]);
      await db.raw('DROP FUNCTION IF EXISTS ??()', [functionName]);
    }
  });

  await run('demotion-wins-transaction-race', async () => {
    await reset('GUEST', false, 'MEMBER');
    request.guestType = 'MEMBER';
    const before = await countCards();
    const paused = await providerPausedCreate('must see demotion committed while waiting for lock');
    const demotion = await db.transaction();
    try {
      await lockWorkspaceMembershipMutations(demotion, workspace);
      await lockBoardMemberMutations(demotion, boardId);
      await demotion('board_guest_access')
        .where({ board_id: boardId, user_id: actor })
        .update({ guest_type: 'VIEWER' });
      paused.release();
      await waitForWorkspaceLock(paused.pending);
      await demotion.commit();
    } catch (error) {
      await demotion.rollback();
      paused.release();
      await paused.pending;
      throw error;
    }
    assert.equal((await paused.pending).status, 403);
    assert.equal(await countCards(), before);
    assert.equal(events.length, 0);
  });

  await run('workspace-removed-during-provider', async () => {
    await reset();
    const before = await countCards();
    const paused = await providerPausedCreate('workspace membership removed');
    await revoke('workspace');
    paused.release();
    assert.equal((await paused.pending).status, 403);
    assert.equal(await countCards(), before);
    assert.equal(events.length, 0);
  });

  await run('guest-demoted-during-provider', async () => {
    await reset('GUEST', false, 'MEMBER');
    request.guestType = 'MEMBER';
    const before = await countCards();
    const paused = await providerPausedCreate('must not insert after guest demotion');
    await revoke('guest');
    paused.release();
    const output = await paused.pending;
    assert.equal(
      output.status,
      403,
      'stale request guestType must not override current VIEWER grant'
    );
    assert.equal(await countCards(), before);
    assert.equal(events.length, 0);
  });

  await run('private-member-revoked-during-provider', async () => {
    await reset();
    const before = await countCards();
    const paused = await providerPausedCreate('must not insert after private grant revoked');
    await revoke('member');
    paused.release();
    const output = await paused.pending;
    assert.equal(output.status, 403, 'private member removed while provider waited must not write');
    assert.equal(await countCards(), before);
    assert.equal(events.length, 0);
  });
  const authorizationCases = [
    {
      name: 'private-owner',
      role: 'OWNER',
      member: false,
      guest: null,
      visibility: 'PRIVATE',
      status: 200,
    },
    {
      name: 'private-admin',
      role: 'ADMIN',
      member: false,
      guest: null,
      visibility: 'PRIVATE',
      status: 200,
    },
    {
      name: 'private-member',
      role: 'MEMBER',
      member: true,
      guest: null,
      visibility: 'PRIVATE',
      status: 200,
    },
    {
      name: 'private-member-unlisted',
      role: 'MEMBER',
      member: false,
      guest: null,
      visibility: 'PRIVATE',
      status: 403,
    },
    {
      name: 'workspace-member',
      role: 'MEMBER',
      member: false,
      guest: null,
      visibility: 'WORKSPACE',
      status: 200,
    },
    {
      name: 'public-member',
      role: 'MEMBER',
      member: false,
      guest: null,
      visibility: 'PUBLIC',
      status: 200,
    },
    {
      name: 'private-viewer',
      role: 'VIEWER',
      member: true,
      guest: null,
      visibility: 'PRIVATE',
      status: 403,
    },
    {
      name: 'public-viewer',
      role: 'VIEWER',
      member: false,
      guest: null,
      visibility: 'PUBLIC',
      status: 403,
    },
    {
      name: 'member-guest',
      role: 'GUEST',
      member: false,
      guest: 'MEMBER',
      visibility: 'PRIVATE',
      status: 200,
    },
    {
      name: 'viewer-guest',
      role: 'GUEST',
      member: false,
      guest: 'VIEWER',
      visibility: 'PRIVATE',
      status: 403,
    },
    {
      name: 'public-guest-without-grant',
      role: 'GUEST',
      member: false,
      guest: null,
      visibility: 'PUBLIC',
      status: 403,
    },
  ];
  for (const example of authorizationCases) {
    await run(example.name, async () => {
      await reset(example.role, example.member, example.guest);
      await db('boards').where({ id: boardId }).update({ visibility: example.visibility });
      // Stale permissive middleware fields must never influence these cases.
      request.callerRole = 'OWNER';
      request.guestType = 'MEMBER';
      const before = await countCards();
      const output = await createBoardCard({
        request,
        board,
        actorId: actor,
        toolCall: tool(example.name),
        model: 'fixture',
      });
      assert.equal(output.status, example.status);
      assert.equal(await countCards(), before + (example.status === 200 ? 1 : 0));
      assert.equal(events.length, example.status === 200 ? 2 : 0);
      if (example.status === 200) {
        const cardId = output.data?.actionCard?.cardId;
        assert.ok(cardId);
        const created = await db('cards')
          .where({ id: cardId })
          .first<{ created_by: string; short_id: string } | undefined>();
        assert.ok(created);
        assert.equal(created.created_by, actor);
        assert.equal(created.short_id.length, 8);
      }
    });
  }

  await run('visibility-narrowed-during-provider', async () => {
    await reset('MEMBER', false);
    await db('boards').where({ id: boardId }).update({ visibility: 'WORKSPACE' });
    const before = await countCards();
    const paused = await providerPausedCreate('board became private');
    await db('boards').where({ id: boardId }).update({ visibility: 'PRIVATE' });
    paused.release();
    assert.equal((await paused.pending).status, 403);
    assert.equal(await countCards(), before);
    assert.equal(events.length, 0);
  });
  await run('archived-during-provider', async () => {
    await reset();
    const before = await countCards();
    const paused = await providerPausedCreate('board became archived');
    await db('boards').where({ id: boardId }).update({ state: 'ARCHIVED' });
    paused.release();
    assert.equal((await paused.pending).status, 403);
    assert.equal(await countCards(), before);
    assert.equal(events.length, 0);
  });
  await run('backlog-sanitization-description-date-attribution-preserved', async () => {
    await reset();
    const before = await countCards();
    const call: BoardChatAssistToolCall = {
      id: randomUUID(),
      type: 'function',
      function: {
        name: 'create_board_card',
        arguments: JSON.stringify({
          title: '  <b>AI & card</b>  ',
          description: '<b onclick="alert(1)">Description</b>',
          startDate: '2026-10-12T12:00:00.000Z',
        }),
      },
    };
    const output = await createBoardCard({
      request,
      board,
      actorId: actor,
      toolCall: call,
      model: 'fixture',
    });
    assert.equal(output.status, 200);
    assert.equal(await countCards(), before + 1);
    const created = await db('cards').where({ id: output.data?.actionCard?.cardId }).first<
      | {
          title: string;
          description: string;
          list_id: string;
          created_by: string;
          start_date: Date;
          archived: boolean;
        }
      | undefined
    >();
    assert.ok(created);
    assert.equal(created.title, 'AI & card');
    assert.equal(created.description, '<b>Description</b>');
    assert.equal(created.list_id, listId);
    assert.equal(created.created_by, actor);
    assert.equal(new Date(created.start_date).toISOString(), '2026-10-12T12:00:00.000Z');
    assert.equal(created.archived, false);
    assert.equal(output.data?.actionCard?.state, 'confirmed');
    assert.equal(events.length, 2);
  });

  await run('real-db-attachment-boundaries-and-comment-exclusion', async () => {
    await reset();
    const foreignWorkspace = randomUUID();
    const foreignBoards = [randomUUID(), randomUUID()];
    const foreignLists = [randomUUID(), randomUUID()];
    const cards = [randomUUID(), randomUUID(), randomUUID()];
    const cardIds = cards;
    const queries: string[] = [];
    const observe = (query: { sql: string }) => {
      queries.push(query.sql);
    };
    try {
      await db('workspaces').insert({
        id: foreignWorkspace,
        name: 'foreign private AI fixture',
        owner_id: owner,
      });
      for (let i = 0; i < 2; i++) {
        await db('boards').insert({
          id: foreignBoards[i],
          workspace_id: i === 0 ? workspace : foreignWorkspace,
          title: 'foreign private',
          visibility: 'PRIVATE',
          short_id: randomUUID().slice(0, 8),
        });
        await db('lists').insert({
          id: foreignLists[i],
          board_id: foreignBoards[i],
          title: 'foreign list',
          position: 'a0',
          short_id: randomUUID().slice(0, 8),
        });
      }
      for (let i = 0; i < 3; i++) {
        const id = cards[i];
        assert.ok(id);
        await db('cards').insert({
          id,
          list_id: i === 0 ? listId : foreignLists[i - 1],
          title: 'read fixture',
          position: 'a0',
          archived: false,
          short_id: randomUUID().slice(0, 8),
        });
        for (const context of ['card', 'comment']) {
          await db('attachments').insert({
            id: randomUUID(),
            card_id: id,
            uploaded_by: owner,
            name: `${context}-${id}.txt`,
            type: 'FILE',
            status: 'READY',
            upload_context: context,
            mime_type: 'text/plain',
            content_type: 'text/plain',
            s3_key: `${context}/${id}`,
            size_bytes: 20,
          });
        }
      }
      const read = (id: string, fileNames?: string[]) =>
        readAttachments({
          boardId,
          actorId: actor,
          model: 'fixture',
          toolCall: {
            id: randomUUID(),
            type: 'function',
            function: {
              name: 'read_attachments',
              arguments: JSON.stringify({
                card_id: id,
                ...(fileNames ? { file_names: fileNames } : {}),
              }),
            },
          },
        });
      db.on('query', observe);
      const allowedCard = cards[0];
      assert.ok(allowedCard);
      s3Reads.length = 0;
      const allowed = await read(allowedCard);
      assert.equal(allowed.status, 200);
      assert.deepEqual(s3Reads, [`card/${allowedCard}`]);
      assert.ok(!JSON.stringify(allowed).includes(`comment-${allowedCard}`));
      for (const foreignCard of cards.slice(1)) {
        for (const fileNames of [undefined, ['missing-file.txt']]) {
          queries.length = 0;
          s3Reads.length = 0;
          const denied = await read(foreignCard, fileNames);
          assert.equal(denied.status, 404);
          assert.deepEqual(s3Reads, []);
          assert.ok(
            queries.every((sql) => !sql.includes('from "attachments"')),
            'no metadata lookup on foreign card'
          );
          assert.ok(!JSON.stringify(denied).includes('Available files:'));
        }
      }
      await revoke('member');
      queries.length = 0;
      s3Reads.length = 0;
      assert.equal((await read(allowedCard)).status, 403);
      assert.deepEqual(s3Reads, []);
      assert.ok(queries.every((sql) => !sql.includes('from "attachments"')));
    } finally {
      db.off('query', observe);
      await db('attachments').whereIn('card_id', cardIds).delete();
      await db('cards').whereIn('id', cardIds).delete();
      await db('lists').whereIn('id', foreignLists).delete();
      await db('boards').whereIn('id', foreignBoards).delete();
      await db('workspaces').where({ id: foreignWorkspace }).delete();
    }
  });
} finally {
  await db('cards').where({ list_id: listId }).delete();
  await db('board_guest_access').where({ board_id: boardId }).delete();
  await db('board_members').where({ board_id: boardId }).delete();
  await db('lists').where({ id: listId }).delete();
  await db('boards').where({ id: boardId }).delete();
  await db('memberships').where({ workspace_id: workspace }).delete();
  await db('workspaces').where({ id: workspace }).delete();
  await db('users').whereIn('id', [actor, owner]).delete();
  await db.destroy();
}
assert.equal(failures, 0, `${String(failures)} AI authorization scenarios failed`);
assert.ok(scenarios > 0, 'The requested scenario selector must match a real test');
console.info(JSON.stringify({ scenarios, failures }));
