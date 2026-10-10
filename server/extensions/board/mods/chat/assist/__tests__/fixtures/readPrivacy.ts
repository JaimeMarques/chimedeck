// Isolated DB/S3 boundary fixtures exercise the real handler and access policy.
import assert from 'node:assert/strict';
import { mock } from 'bun:test';

const root = new URL('../../../../../../../..', import.meta.url).pathname;
const localCard = '11111111-1111-4111-8111-111111111111';
const sameWorkspaceCard = '22222222-2222-4222-8222-222222222222';
const otherWorkspaceCard = '33333333-3333-4333-8333-333333333333';
type Row = Record<string, unknown>;
type TableName =
  | 'boards'
  | 'lists'
  | 'cards'
  | 'memberships'
  | 'board_members'
  | 'board_guest_access'
  | 'attachments';
const tables: Record<TableName, Row[]> = {
  boards: [
    { id: 'board-A', workspace_id: 'workspace-A', visibility: 'PRIVATE' },
    { id: 'board-B', workspace_id: 'workspace-A', visibility: 'PRIVATE' },
    { id: 'board-C', workspace_id: 'workspace-B', visibility: 'PRIVATE' },
  ],
  lists: ['A', 'B', 'C'].map((suffix) => ({ id: `list-${suffix}`, board_id: `board-${suffix}` })),
  cards: [localCard, sameWorkspaceCard, otherWorkspaceCard].map((id, index) => ({
    id,
    short_id: `card-${String(index)}`,
    list_id: `list-${String(['A', 'B', 'C'][index])}`,
  })),
  memberships: [{ user_id: 'actor', workspace_id: 'workspace-A', role: 'OWNER' }],
  board_members: [],
  board_guest_access: [],
  attachments: [localCard, sameWorkspaceCard, otherWorkspaceCard].flatMap((card_id) => [
    {
      id: `${card_id}-file`,
      card_id,
      name: 'fixture.txt',
      alias: 'display.txt',
      mime_type: 'text/plain',
      content_type: 'text/plain',
      s3_key: `${card_id}/file`,
      size_bytes: 20,
      type: 'FILE',
      status: 'READY',
      upload_context: 'card',
      url: null,
      created_at: '2026-10-10',
    },
    {
      id: `${card_id}-draft`,
      card_id,
      name: 'secret-draft.txt',
      mime_type: 'text/plain',
      s3_key: `${card_id}/draft`,
      size_bytes: 10,
      type: 'FILE',
      status: 'READY',
      upload_context: 'comment',
      created_at: '2026-10-10',
    },
  ]),
};
const queries: string[] = [];
const s3Reads: string[] = [];
function db(table: TableName) {
  assert.ok(table in tables, `Unexpected table: ${table}`);
  queries.push(table);
  const predicates: Array<(row: Row) => boolean> = [];
  function predicate(key: string | Row, value?: unknown) {
    return (row: Row) =>
      typeof key === 'string'
        ? row[key] === value
        : Object.entries(key).every(([column, expected]) => row[column] === expected);
  }
  const result = () => tables[table].filter((row) => predicates.every((p) => p(row)));
  const query = {
    where(key: string | Row, value?: unknown) {
      predicates.push(predicate(key, value));
      return query;
    },
    orWhere(key: string | Row, value?: unknown) {
      const previous = predicates.pop() ?? (() => false);
      const next = predicate(key, value);
      predicates.push((row) => previous(row) || next(row));
      return query;
    },
    whereNotNull(key: string) {
      predicates.push((row) => row[key] != null);
      return query;
    },
    select(..._columns: string[]) {
      return query;
    },
    first() {
      return Promise.resolve(result()[0]);
    },
    then(resolve: (rows: Row[]) => unknown, reject: (error: unknown) => unknown) {
      return Promise.resolve(result()).then(resolve, reject);
    },
  };
  return query;
}
await mock.module(`${root}/server/common/db.ts`, () => ({ db }));
await mock.module(`${root}/server/extensions/attachment/common/config/s3.ts`, () => ({
  s3Config: { bucket: 'fixture-bucket' },
  s3Client: {
    send() {
      throw new Error('Public S3 client must never be used');
    },
  },
  s3ServerClient: {
    send(command: { input: { Key: string; Bucket: string } }) {
      assert.equal(command.input.Bucket, 'fixture-bucket');
      const key = command.input.Key;
      s3Reads.push(key);
      return Promise.resolve({
        Body: {
          transformToByteArray() {
            return Promise.resolve(
              new TextEncoder().encode(
                key.startsWith(localCard) ? 'ALLOWED_CONTENT' : 'PRIVATE_SECRET'
              )
            );
          },
        },
      });
    },
  },
}));
const { readAttachments } = await import('../../readAttachments');
const toolCall = (cardId: string, fileNames?: string[]) => ({
  id: 'read-call',
  type: 'function' as const,
  function: {
    name: 'read_attachments',
    arguments: JSON.stringify({
      card_id: cardId,
      ...(fileNames ? { file_names: fileNames } : {}),
    }),
  },
});
function resetReads() {
  queries.length = 0;
  s3Reads.length = 0;
}
async function read(cardId = localCard, fileNames?: string[]) {
  return readAttachments({
    boardId: 'board-A',
    actorId: 'actor',
    model: 'fixture-model',
    toolCall: toolCall(cardId, fileNames),
  });
}
function assertDenied(result: Awaited<ReturnType<typeof readAttachments>>, status: number) {
  assert.equal(result.status, status, JSON.stringify(result));
  assert.equal(result.data, undefined);
  assert.ok(!JSON.stringify(result).includes('display.txt'));
  assert.ok(!JSON.stringify(result).includes('PRIVATE_SECRET'));
  assert.ok(
    !queries.includes('attachments'),
    `Denied call queried attachment metadata: ${queries.join(', ')}`
  );
  assert.deepEqual(s3Reads, []);
}

const mode = process.argv[2];
if (mode === 'scope') {
  for (const cardId of [sameWorkspaceCard, otherWorkspaceCard, 'card-1', 'card-2']) {
    for (const fileNames of [undefined, ['missing-name']]) {
      resetReads();
      assertDenied(await read(cardId, fileNames), 404);
    }
  }
  console.info('verified foreign UUID/short-ID scope and metadata/content denial');
} else if (mode === 'access') {
  tables.memberships = [];
  resetReads();
  assertDenied(await read(), 403);
  console.info('verified fresh actor access before attachment metadata/S3');
} else if (mode === 'policy') {
  const board = tables.boards[0];
  assert.ok(board);
  for (const [role, visibility, grant, allowed] of [
    ['OWNER', 'PRIVATE', '', true],
    ['ADMIN', 'PRIVATE', '', true],
    ['MEMBER', 'WORKSPACE', '', true],
    ['VIEWER', 'WORKSPACE', '', true],
    ['MEMBER', 'PRIVATE', 'member', true],
    ['VIEWER', 'PRIVATE', 'member', true],
    ['GUEST', 'PRIVATE', 'guest', true],
    ['GUEST', 'WORKSPACE', 'guest', true],
    ['', 'PUBLIC', '', true],
    ['MEMBER', 'PRIVATE', '', false],
    ['VIEWER', 'PRIVATE', '', false],
    ['GUEST', 'WORKSPACE', '', false],
    ['', 'WORKSPACE', '', false],
  ] as const) {
    board.visibility = visibility;
    tables.memberships = role ? [{ user_id: 'actor', workspace_id: 'workspace-A', role }] : [];
    tables.board_members = grant === 'member' ? [{ board_id: 'board-A', user_id: 'actor' }] : [];
    tables.board_guest_access =
      grant === 'guest' ? [{ board_id: 'board-A', user_id: 'actor' }] : [];
    resetReads();
    const result = await read('card-0');
    if (allowed) {
      assert.equal(result.status, 200, `${role}/${visibility}/${grant}: ${JSON.stringify(result)}`);
      assert.ok(JSON.stringify(result).includes('ALLOWED_CONTENT'));
      assert.deepEqual(s3Reads, [`${localCard}/file`]);
      assert.ok(!JSON.stringify(result).includes('secret-draft'));
      assert.ok(queries.indexOf('memberships') < queries.indexOf('attachments'));
    } else {
      assertDenied(result, 403);
    }
  }
  // A prior successful tool call must not cache a now-revoked private-board grant.
  board.visibility = 'PRIVATE';
  tables.memberships = [{ user_id: 'actor', workspace_id: 'workspace-A', role: 'MEMBER' }];
  tables.board_members = [{ board_id: 'board-A', user_id: 'actor' }];
  assert.equal((await read()).status, 200);
  tables.board_members = [];
  resetReads();
  assertDenied(await read(localCard, ['missing-name']), 403);
  tables.memberships = [{ user_id: 'actor', workspace_id: 'workspace-A', role: 'GUEST' }];
  tables.board_guest_access = [{ board_id: 'board-A', user_id: 'actor' }];
  assert.equal((await read()).status, 200);
  tables.board_guest_access = [];
  resetReads();
  assertDenied(await read(), 403);
  // PUBLIC -> PRIVATE changes must also be observed at tool execution time.
  board.visibility = 'PUBLIC';
  tables.memberships = [];
  assert.equal((await read()).status, 200);
  board.visibility = 'PRIVATE';
  resetReads();
  assertDenied(await read(), 403);
  board.visibility = 'PUBLIC';
  resetReads();
  assertDenied(
    await readAttachments({
      boardId: 'board-A',
      actorId: '',
      model: 'fixture-model',
      toolCall: toolCall(localCard),
    }),
    403
  );
  tables.boards = [];
  resetReads();
  assertDenied(await read(), 404);
  console.info(
    'verified owner/admin/member/viewer/guest/public policy, fresh revocation, drafts and server S3'
  );
} else if (mode === 'caller') {
  const assistPath = `${root}/server/extensions/board/mods/chat/assist`;
  for (const [file, definition, handler] of [
    ['createBoardCard', 'CREATE_BOARD_CARD_TOOL', 'createBoardCard'],
    ['searchCards', 'SEARCH_CARDS_TOOL', 'searchCards'],
    ['proposeGithubDocument', 'PROPOSE_GITHUB_DOCUMENT_TOOL', 'buildDocumentActionCard'],
    ['readSpecsFile', 'READ_SPECS_FILE_TOOL', 'readSpecsFileTool'],
    ['listSpecsFiles', 'LIST_SPECS_FILES_TOOL', 'listSpecsFilesTool'],
    ['deleteSpecsFile', 'DELETE_SPECS_FILE_TOOL', 'deleteSpecsFileTool'],
  ] as const) {
    await mock.module(`${assistPath}/${file}.ts`, () => ({
      [definition]: { type: 'function', function: { name: file } },
      [handler]: () => {
        throw new Error(`Unexpected tool: ${file}`);
      },
    }));
  }
  await mock.module(`${root}/server/mods/events/dispatch.ts`, () => ({
    dispatchEvent: () => Promise.resolve({}),
  }));
  await mock.module(`${root}/server/extensions/board/mods/chat/messages/write.ts`, () => ({
    writeBoardChatMessage: () => Promise.resolve({}),
  }));
  await mock.module(`${root}/server/extensions/realtime/mods/rooms/broadcast.ts`, () => ({
    broadcast: () => {},
  }));
  await mock.module(`${root}/server/config/env.ts`, () => ({
    env: { MULTI_INSTANCE_HANDLING_ENABLED: false },
  }));
  await mock.module(`${assistPath}/multiInstanceSessionTracker.ts`, () => ({
    recordSessionInstance: () => {},
  }));
  const completions = [
    { status: 200, data: { model: 'fixture-model', toolCalls: [toolCall(localCard)] } },
    { status: 200, data: { model: 'fixture-model', message: 'Read complete.' } },
  ];
  await mock.module(`${assistPath}/provider.ts`, () => ({
    requestBoardChatAssistCompletion: () => Promise.resolve(completions.shift()),
  }));
  const { assistBoardChat, boardChatAssistDeps } = await import('../../index');
  boardChatAssistDeps.fetchRecentBoardMessages = () => Promise.resolve([]);
  const inputs: Array<Parameters<typeof readAttachments>[0]> = [];
  boardChatAssistDeps.readAttachments = async (input) => {
    inputs.push(input);
    return readAttachments(input);
  };
  const result = await assistBoardChat({
    boardId: 'board-A',
    actorId: 'actor',
    sessionId: 'session',
    prompt: 'Read the attachment',
    request: new Request('http://fixture.invalid'),
    board: { id: 'board-A', workspace_id: 'workspace-A', title: 'Board', state: 'ACTIVE' },
  });
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0]?.actorId, 'actor', 'Dispatcher must propagate authenticated actor');
  assert.equal(inputs[0].boardId, 'board-A');
  assert.equal(result.status, 200);
  assert.deepEqual(s3Reads, [`${localCard}/file`]);
  console.info('verified real tool dispatcher propagates actor to authorized attachment read');
} else {
  throw new Error(`Unknown fixture mode: ${String(mode)}`);
}
