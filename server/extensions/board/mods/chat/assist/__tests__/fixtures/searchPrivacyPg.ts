// Disposable PostgreSQL proves actual dispatcher/search and canonical lock races.
// CHIMEDECK_TEST_SANDBOX=1 DATABASE_URL=postgres://.../chimedeck_search_test bun run <this file>
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mock } from 'bun:test';
import type { Knex } from 'knex';
import type { BoardChatAssistOutput } from '../../../../../types';

assert.equal(Bun.env['CHIMEDECK_TEST_SANDBOX'], '1', 'Disposable sandbox opt-in required');
const url = new URL(Bun.env['DATABASE_URL'] ?? '');
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
assert.match(url.pathname, /(?:^|[_-])(test|sandbox|scratch)(?:$|[_-])/i);
const root = new URL('../../../../../../../..', import.meta.url).pathname;
const assistPath = `${root}/server/extensions/board/mods/chat/assist`;
const s3Reads: string[] = [];
let s3Gate: { entered: () => void; wait: Promise<void> } | undefined;
await mock.module(`${root}/server/extensions/attachment/common/config/s3.ts`, () => ({
  s3Config: { bucket: 'fixture' },
  s3Client: {
    send() {
      throw new Error('Public S3 client forbidden');
    },
  },
  s3ServerClient: {
    async send(command: { input: { Key: string } }) {
      s3Reads.push(command.input.Key);
      if (s3Gate) {
        s3Gate.entered();
        await s3Gate.wait;
      }
      return {
        Body: {
          transformToByteArray: () => Promise.resolve(new TextEncoder().encode('PRIVATE_BYTES')),
        },
      };
    },
  },
}));
for (const [file, definition, handler] of [
  ['createBoardCard', 'CREATE_BOARD_CARD_TOOL', 'createBoardCard'],
  ['proposeGithubDocument', 'PROPOSE_GITHUB_DOCUMENT_TOOL', 'buildDocumentActionCard'],
  ['readSpecsFile', 'READ_SPECS_FILE_TOOL', 'readSpecsFileTool'],
  ['listSpecsFiles', 'LIST_SPECS_FILES_TOOL', 'listSpecsFilesTool'],
  ['deleteSpecsFile', 'DELETE_SPECS_FILE_TOOL', 'deleteSpecsFileTool'],
] as const)
  await mock.module(`${assistPath}/${file}.ts`, () => ({
    [definition]: { type: 'function', function: { name: file } },
    [handler]: () => {
      throw new Error(`Unexpected tool: ${file}`);
    },
  }));
await mock.module(`${root}/server/mods/events/dispatch.ts`, () => ({
  dispatchEvent: () => Promise.resolve({}),
}));
await mock.module(`${root}/server/extensions/board/mods/chat/messages/write.ts`, () => ({
  writeBoardChatMessage: () => Promise.resolve({}),
}));
await mock.module(`${root}/server/extensions/realtime/mods/rooms/broadcast.ts`, () => ({
  broadcast: () => {},
}));
await mock.module(`${assistPath}/multiInstanceSessionTracker.ts`, () => ({
  recordSessionInstance: () => {},
}));
const { db } = await import('../../../../../../../common/db');
const { searchCards } = await import('../../searchCards');
const { assistBoardChat, boardChatAssistDeps } = await import('../../index');
const { lockWorkspaceMembershipMutations } =
  await import('../../../../../../workspace/api/members/lock');
const { lockBoardMemberMutations } = await import('../../../../../api/members/lock');
const owner = randomUUID();
const actor = randomUUID();
const workspace = randomUUID();
const boardId = randomUUID();
const listId = randomUUID();
const cardId = randomUUID();
const board = { id: boardId, workspace_id: workspace, title: 'Search test', state: 'ACTIVE' };
const reads: string[] = [];
db.on('query', (query: { sql: string }) => {
  if (
    /^select\b/i.test(query.sql) &&
    /\b(?:cards|attachments|checklists|card_custom_field_values|card_labels)\b/.test(query.sql)
  )
    reads.push(query.sql);
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const toolCall = (query: string) => ({
  id: randomUUID(),
  type: 'function' as const,
  function: { name: 'search_cards', arguments: JSON.stringify({ query, actorId: owner }) },
});
const search = (query: string) =>
  searchCards({ boardId, actorId: actor, model: 'fixture', toolCall: toolCall(query) });
function resetReads() {
  reads.length = 0;
  s3Reads.length = 0;
}
function denied(result: BoardChatAssistOutput) {
  assert.equal(result.status, 403, JSON.stringify(result));
  assert.equal(result.data, undefined);
  assert.deepEqual(reads, [], 'Denied search must not query card/private attachment data');
  assert.deepEqual(s3Reads, []);
}
type Change = 'membership' | 'board-grant' | 'guest' | 'public' | 'workspace';
async function reset(change: Change = 'board-grant') {
  await db('board_members').where({ board_id: boardId, user_id: actor }).delete();
  await db('board_guest_access').where({ board_id: boardId, user_id: actor }).delete();
  await db('memberships').where({ workspace_id: workspace, user_id: actor }).delete();
  const role = change === 'guest' ? 'GUEST' : 'MEMBER';
  if (change !== 'public')
    await db('memberships').insert({ workspace_id: workspace, user_id: actor, role });
  if (change === 'guest')
    await db('board_guest_access').insert({
      id: randomUUID(),
      board_id: boardId,
      user_id: actor,
      guest_type: 'VIEWER',
      granted_by: owner,
    });
  else if (change !== 'public' && change !== 'workspace')
    await db('board_members').insert({
      id: randomUUID(),
      board_id: boardId,
      user_id: actor,
      role: 'MEMBER',
    });
  await db('boards')
    .where({ id: boardId })
    .update({
      visibility: change === 'public' ? 'PUBLIC' : change === 'workspace' ? 'WORKSPACE' : 'PRIVATE',
    });
  resetReads();
}
async function mutate(trx: Knex.Transaction, change: Change) {
  if (change === 'membership')
    await trx('memberships').where({ workspace_id: workspace, user_id: actor }).delete();
  else if (change === 'board-grant')
    await trx('board_members').where({ board_id: boardId, user_id: actor }).delete();
  else if (change === 'guest')
    await trx('board_guest_access').where({ board_id: boardId, user_id: actor }).delete();
  else await trx('boards').where({ id: boardId }).update({ visibility: 'PRIVATE' });
}
async function revoke(change: Change) {
  await db.transaction(async (trx) => {
    await lockWorkspaceMembershipMutations(trx, workspace);
    await lockBoardMemberMutations(trx, boardId);
    await mutate(trx, change);
  });
}
async function waitForLock(pending: Promise<unknown>) {
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  const key = `workspace-memberships:${workspace}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await db.raw<{ rows: { waiting: string }[] }>(
      `SELECT count(*) AS waiting FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted
      AND classid::bigint = ((hashtext(?)::bigint >> 32) & 4294967295)
      AND objid::bigint = (hashtext(?)::bigint & 4294967295)
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      [key, key]
    );
    if (Number(result.rows[0]?.waiting) > 0) return;
    assert.equal(settled, false, 'Search completed while canonical revocation lock was held');
    await Bun.sleep(10);
  }
  assert.fail('Search did not wait on the canonical workspace lock');
}
let passed = 0;
async function run(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.info(`PASS ${name}`);
}
try {
  const identity = await db.raw<{ rows: { name: string }[] }>('SELECT current_database() AS name');
  assert.equal(identity.rows[0]?.name, decodeURIComponent(url.pathname.slice(1)));
  await db('users').insert(
    [owner, actor].map((id) => ({
      id,
      email: `${id}@example.test`,
      name: 'Search test',
      email_verified: true,
    }))
  );
  await db('workspaces').insert({ id: workspace, owner_id: owner, name: 'Disposable search test' });
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
  await db('cards').insert({
    id: cardId,
    list_id: listId,
    title: 'PRIVATE_TITLE',
    description: 'PRIVATE_DESCRIPTION',
    position: 'a0',
    short_id: 'local001',
    archived: false,
  });
  for (const context of ['card', 'comment'])
    await db('attachments').insert({
      id: randomUUID(),
      card_id: cardId,
      uploaded_by: owner,
      name: context === 'card' ? 'PRIVATE_FILENAME.txt' : 'COMMENT_DRAFT.txt',
      type: 'FILE',
      status: 'READY',
      upload_context: context,
      mime_type: 'text/plain',
      content_type: 'text/plain',
      s3_key: `${context}/${cardId}`,
      size_bytes: 20,
    });
  for (const change of ['membership', 'board-grant', 'guest', 'public', 'workspace'] as const) {
    for (const query of ['*', cardId]) {
      await run(`provider-paused-${change}-${query === '*' ? 'broad' : 'direct'}`, async () => {
        await reset(change);
        const entered = deferred();
        const release = deferred();
        let calls = 0;
        const providerMessages: string[] = [];
        boardChatAssistDeps.fetchRecentBoardMessages = () => Promise.resolve([]);
        boardChatAssistDeps.requestBoardChatAssistCompletion = async (input) => {
          providerMessages.push(JSON.stringify(input.messages));
          if (calls++ > 0) return { status: 200, data: { model: 'fixture', message: 'Done' } };
          entered.resolve();
          await release.promise;
          return { status: 200, data: { model: 'fixture', toolCalls: [toolCall(query)] } };
        };
        const pending = assistBoardChat({
          boardId,
          actorId: actor,
          sessionId: randomUUID(),
          prompt: 'Find the card',
          request: new Request('http://fixture.invalid'),
          board,
        });
        await entered.promise;
        try {
          await revoke(change);
        } finally {
          release.resolve();
        }
        resetReads();
        denied(await pending);
        assert.equal(calls, 1);
        assert.ok(!providerMessages.join('').includes('PRIVATE_'));
      });
    }
    await run(`revoke-wins-canonical-lock-${change}`, async () => {
      await reset(change);
      const trx = await db.transaction();
      let pending: Promise<BoardChatAssistOutput> | undefined;
      try {
        await lockWorkspaceMembershipMutations(trx, workspace);
        await lockBoardMemberMutations(trx, boardId);
        await mutate(trx, change);
        resetReads();
        pending = search(cardId);
        await waitForLock(pending);
        await trx.commit();
      } catch (error) {
        await trx.rollback();
        if (pending) await pending;
        throw error;
      }
      denied(await pending);
    });
  }
  await run('authorized-results-and-card-upload-context', async () => {
    await reset();
    for (const query of ['*', 'PRIVATE', cardId, 'local001']) {
      resetReads();
      const result = await search(query);
      assert.equal(result.status, 200, JSON.stringify(result));
      assert.ok(JSON.stringify(result).includes('PRIVATE_DESCRIPTION'));
      assert.ok(JSON.stringify(result).includes('PRIVATE_FILENAME.txt'));
      assert.ok(!JSON.stringify(result).includes('COMMENT_DRAFT'));
      assert.deepEqual(s3Reads, query === cardId || query === 'local001' ? [`card/${cardId}`] : []);
    }
  });
  await run(
    'read-wins-before-overlapping-revocation-releases-auth-connection-before-S3',
    async () => {
      await reset();
      const entered = deferred();
      const release = deferred();
      s3Gate = { entered: entered.resolve, wait: release.promise };
      const pending = search(cardId);
      await entered.promise;
      try {
        await Promise.race([
          revoke('board-grant'),
          Bun.sleep(10_000).then(() => {
            throw new Error('Authorization locks retained across S3 wait');
          }),
        ]);
      } finally {
        release.resolve();
        s3Gate = undefined;
      }
      const result = await pending;
      assert.equal(result.status, 200, JSON.stringify(result));
      assert.ok(JSON.stringify(result).includes('PRIVATE_BYTES'));
      resetReads();
      denied(await search(cardId));
    }
  );
  console.info(
    `verified PostgreSQL search privacy: ${String(passed)} scenarios; real locks/queries, no provider/S3 network`
  );
} finally {
  await db('workspaces').where({ id: workspace }).delete();
  await db('users').whereIn('id', [owner, actor]).delete();
  await db.destroy();
}
