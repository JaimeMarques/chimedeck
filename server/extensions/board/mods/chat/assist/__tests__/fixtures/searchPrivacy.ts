// The real dispatcher/search/access policy run with isolated DB/S3 boundaries.
import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import type { BoardChatAssistOutput } from '../../../../../types';

const root = new URL('../../../../../../../..', import.meta.url).pathname;
const assistPath = `${root}/server/extensions/board/mods/chat/assist`;
const mode = process.argv[2] ?? '';
const localCard = '11111111-1111-4111-8111-111111111111';
const foreignCard = '22222222-2222-4222-8222-222222222222';
const otherWorkspaceCard = '33333333-3333-4333-8333-333333333333';
type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {
  boards: [
    { id: 'board-A', workspace_id: 'workspace-A', visibility: 'PRIVATE' },
    { id: 'board-B', workspace_id: 'workspace-A', visibility: 'PRIVATE' },
    { id: 'board-C', workspace_id: 'workspace-B', visibility: 'PRIVATE' },
  ],
  lists: ['A', 'B', 'C'].map((suffix) => ({ id: `list-${suffix}`, board_id: `board-${suffix}` })),
  cards: [localCard, foreignCard, otherWorkspaceCard].map((id, index) => ({
    id,
    short_id: ['local001', 'foreign1', 'foreign2'][index],
    title: 'PRIVATE_TITLE',
    description: 'PRIVATE_DESCRIPTION',
    list_id: `list-${String(['A', 'B', 'C'][index])}`,
    due_date: null,
    start_date: null,
    created_at: '2026-10-11',
    updated_at: '2026-10-11',
    archived: false,
  })),
  memberships: [{ user_id: 'actor', workspace_id: 'workspace-A', role: 'MEMBER' }],
  board_members: [{ user_id: 'actor', board_id: 'board-A' }],
  board_guest_access: [],
  attachments: [localCard, foreignCard, otherWorkspaceCard].flatMap((card_id) =>
    ['card', 'comment'].map((upload_context) => ({
      id: `${card_id}-${upload_context}`,
      card_id,
      name: upload_context === 'card' ? 'PRIVATE_FILENAME.txt' : 'COMMENT_DRAFT.txt',
      alias: null,
      mime_type: 'text/plain',
      content_type: 'text/plain',
      s3_key: `${card_id}/${upload_context}`,
      size_bytes: 20,
      type: 'FILE',
      status: 'READY',
      upload_context,
      url: null,
      created_at: '2026-10-11',
    }))
  ),
  checklists: [],
  checklist_items: [],
  'card_custom_field_values as v': [],
  'card_labels as cl': [],
};
const reads: string[] = [];
const s3Reads: string[] = [];
const locks: string[] = [];
let transactionActive = false;
function db(table: string) {
  assert.ok(table in tables, `Unexpected table: ${table}`);
  reads.push(table);
  const predicates: Array<(row: Row) => boolean> = [];
  const valueAt = (row: Row, key: string) => row[key] ?? row[key.split('.').at(-1) ?? key];
  const predicate = (key: string | Row, value?: unknown) => (row: Row) =>
    typeof key === 'string'
      ? valueAt(row, key) === value
      : Object.entries(key).every(([column, expected]) => valueAt(row, column) === expected);
  let joined = false;
  let columns: unknown[] = [];
  const result = () => {
    const rows = tables[table] ?? [];
    const joinedRows =
      joined && table === 'cards'
        ? rows.flatMap((row) =>
            (tables.lists ?? [])
              .filter((list) => list.id === row.list_id)
              .map((list) => ({ ...row, 'lists.board_id': list.board_id }))
          )
        : rows;
    return joinedRows
      .filter((row) => predicates.every((p) => p(row)))
      .map((row) => {
        if (columns.length === 0 || columns.some((c) => typeof c !== 'string')) return row;
        const projected: Row = {};
        for (const key of columns) {
          if (typeof key === 'string') projected[key.split('.').at(-1) ?? key] = valueAt(row, key);
        }
        return projected;
      });
  };
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
    whereIn(key: string, values: unknown[]) {
      predicates.push((row) => values.includes(valueAt(row, key)));
      return query;
    },
    whereNotNull(key: string) {
      predicates.push((row) => valueAt(row, key) != null);
      return query;
    },
    whereRaw(_sql: string, bindings: string[]) {
      const terms = (bindings[0] ?? '')
        .split(' & ')
        .map((term) => term.replace(':*', '').toLowerCase());
      predicates.push((row) =>
        terms.every((term) =>
          `${String(row.title)} ${String(row.description)}`.toLowerCase().includes(term)
        )
      );
      return query;
    },
    join() {
      joined = true;
      return query;
    },
    orderBy() {
      return query;
    },
    orderByRaw() {
      return query;
    },
    limit() {
      return query;
    },
    forShare() {
      return query;
    },
    select(...selected: unknown[]) {
      columns = selected;
      return query;
    },
    first() {
      return Promise.resolve(result()[0]);
    },
    then(resolve: (rows: Row[]) => unknown, reject: (error: unknown) => unknown) {
      if (table === 'memberships' && mode === 'queued-revocation') {
        const currentBoard = tables.boards?.[0];
        assert.ok(currentBoard);
        currentBoard.visibility = 'PRIVATE';
      }
      return Promise.resolve(result()).then(resolve, reject);
    },
  };
  return query;
}
db.raw = (sql: string, bindings: unknown[]) => {
  if (sql.includes('pg_advisory_xact_lock')) {
    assert.equal(transactionActive, true);
    locks.push(String(bindings[0]));
    if (mode === 'queued-revocation') {
      const currentBoard = tables.boards?.[0];
      assert.ok(currentBoard);
      currentBoard.visibility = 'PRIVATE';
    }
  }
  return { raw: true };
};
db.transaction = async <T>(callback: (trx: typeof db) => Promise<T>) => {
  transactionActive = true;
  try {
    return await callback(db);
  } finally {
    transactionActive = false;
  }
};
await mock.module(`${root}/server/common/db.ts`, () => ({ db }));
await mock.module(`${root}/server/extensions/attachment/common/config/s3.ts`, () => ({
  s3Config: { bucket: 'fixture' },
  s3Client: {
    send() {
      throw new Error('Public S3 client forbidden');
    },
  },
  s3ServerClient: {
    send(command: { input: { Key: string; Bucket: string } }) {
      assert.equal(command.input.Bucket, 'fixture');
      s3Reads.push(command.input.Key);
      return Promise.resolve({
        Body: {
          transformToByteArray: () => Promise.resolve(new TextEncoder().encode('PRIVATE_BYTES')),
        },
      });
    },
  },
}));
for (const [file, definition, handler] of [
  ['createBoardCard', 'CREATE_BOARD_CARD_TOOL', 'createBoardCard'],
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
const { searchCards } = await import('../../searchCards');
const { canUserAccessBoard } = await import('../../../../../access');
const { assistBoardChat, boardChatAssistDeps } = await import('../../index');
boardChatAssistDeps.fetchRecentBoardMessages = () => Promise.resolve([]);
const toolCall = (query: string) => ({
  id: 'search-call',
  type: 'function' as const,
  // A provider cannot replace the authenticated actor through tool arguments.
  function: { name: 'search_cards', arguments: JSON.stringify({ query, actorId: 'intruder' }) },
});
const board = tables.boards?.[0];
assert.ok(board);
function resetReads() {
  reads.length = 0;
  s3Reads.length = 0;
}
function assertDenied(result: BoardChatAssistOutput, status = 403) {
  assert.equal(result.status, status, JSON.stringify(result));
  assert.equal(result.data, undefined);
  for (const secret of [
    'PRIVATE_TITLE',
    'PRIVATE_DESCRIPTION',
    'PRIVATE_FILENAME',
    'PRIVATE_BYTES',
  ]) {
    assert.ok(!JSON.stringify(result).includes(secret), `Denied result leaked ${secret}`);
  }
  assert.ok(!reads.includes('cards'), `Denied request read cards: ${reads.join(', ')}`);
  assert.ok(!reads.includes('attachments'), `Denied request read metadata: ${reads.join(', ')}`);
  assert.deepEqual(s3Reads, []);
}
if (mode.startsWith('paused-')) {
  const direct = mode.endsWith('-direct');
  const query = direct ? localCard : '*';
  if (mode.includes('-guest-')) {
    tables.memberships = [{ user_id: 'actor', workspace_id: 'workspace-A', role: 'GUEST' }];
    tables.board_guest_access = [{ user_id: 'actor', board_id: 'board-A' }];
  }
  if (mode.includes('-public-') || mode.includes('-workspace-')) {
    board.visibility = mode.includes('-public-') ? 'PUBLIC' : 'WORKSPACE';
    tables.board_members = [];
    if (mode.includes('-public-')) tables.memberships = [];
  }
  assert.equal(
    await canUserAccessBoard('actor', {
      id: 'board-A',
      workspace_id: 'workspace-A',
      visibility: board.visibility as 'PRIVATE' | 'PUBLIC' | 'WORKSPACE',
    }),
    true,
    'Actor must initially have real-policy access'
  );
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const providerEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  const seenMessages: string[] = [];
  boardChatAssistDeps.requestBoardChatAssistCompletion = async (input) => {
    seenMessages.push(JSON.stringify(input.messages));
    if (calls++ === 0) {
      entered();
      await gate;
      return { status: 200, data: { model: 'fixture', toolCalls: [toolCall(query)] } };
    }
    return { status: 200, data: { model: 'fixture', message: 'Done' } };
  };
  const pending = assistBoardChat({
    boardId: 'board-A',
    actorId: 'actor',
    sessionId: 'session',
    prompt: 'Find the card',
    request: new Request('http://fixture.invalid'),
    board: { id: 'board-A', workspace_id: 'workspace-A', title: 'Board', state: 'ACTIVE' },
  });
  await providerEntered;
  // Authorization was valid when the provider started. Revoke only while paused.
  if (mode.includes('-membership-')) tables.memberships = [];
  else if (mode.includes('-board-grant-')) tables.board_members = [];
  else if (mode.includes('-guest-')) tables.board_guest_access = [];
  else if (mode.includes('-public-') || mode.includes('-workspace-')) board.visibility = 'PRIVATE';
  else throw new Error(`Unknown revocation: ${mode}`);
  resetReads();
  release();
  assertDenied(await pending);
  assert.equal(calls, 1, 'Denied search must not reach the next provider request');
  assert.ok(!seenMessages.join('').includes('PRIVATE_'));
  console.info(`verified ${mode}: real paused provider denial without card/metadata/S3 reads`);
} else if (mode === 'queued-revocation') {
  board.visibility = 'PUBLIC';
  tables.memberships = [];
  tables.board_members = [];
  resetReads();
  assertDenied(
    await searchCards({
      boardId: 'board-A',
      actorId: 'actor',
      model: 'fixture',
      toolCall: toolCall('*'),
    })
  );
  assert.deepEqual(locks, ['workspace-memberships:workspace-A', 'board-members:board-A']);
  console.info(
    'verified authorization re-reads board after canonical workspace-before-board locks'
  );
} else if (mode === 'policy') {
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
    tables.board_members = grant === 'member' ? [{ user_id: 'actor', board_id: 'board-A' }] : [];
    tables.board_guest_access =
      grant === 'guest' ? [{ user_id: 'actor', board_id: 'board-A' }] : [];
    for (const query of ['*', 'PRIVATE', localCard, 'local001']) {
      resetReads();
      const result = await searchCards({
        boardId: 'board-A',
        actorId: 'actor',
        model: 'fixture',
        toolCall: toolCall(query),
      });
      if (!allowed) {
        assertDenied(result);
        continue;
      }
      assert.equal(
        result.status,
        200,
        `${role}/${visibility}/${grant}/${query}: ${JSON.stringify(result)}`
      );
      assert.ok(JSON.stringify(result).includes('PRIVATE_DESCRIPTION'));
      assert.ok(JSON.stringify(result).includes('PRIVATE_FILENAME.txt'));
      assert.ok(!JSON.stringify(result).includes('COMMENT_DRAFT'));
      assert.ok(reads.indexOf('memberships') < reads.indexOf('cards'));
      assert.deepEqual(
        s3Reads,
        query === localCard || query === 'local001' ? [`${localCard}/card`] : []
      );
    }
  }
  board.visibility = 'PUBLIC';
  resetReads();
  assertDenied(
    await searchCards({
      boardId: 'board-A',
      actorId: '',
      model: 'fixture',
      toolCall: toolCall('*'),
    })
  );
  tables.boards = [];
  resetReads();
  assertDenied(
    await searchCards({
      boardId: 'board-A',
      actorId: 'actor',
      model: 'fixture',
      toolCall: toolCall(localCard),
    }),
    404
  );
  console.info(
    'verified reader policy, UUID/short-ID/keyword/wildcard success, drafts, server S3 and missing context denial'
  );
} else if (mode === 'scope') {
  for (const query of [foreignCard, otherWorkspaceCard, 'foreign1', 'foreign2']) {
    resetReads();
    const result = await searchCards({
      boardId: 'board-A',
      actorId: 'actor',
      model: 'fixture',
      toolCall: toolCall(query),
    });
    assert.equal(result.status, 200);
    assert.ok(result.data?.message?.includes('No matching cards'));
    assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
    assert.ok(!reads.includes('attachments'));
    assert.deepEqual(s3Reads, []);
  }
  // A membership in another workspace is not authority over this private board.
  tables.memberships = [{ user_id: 'actor', workspace_id: 'workspace-B', role: 'OWNER' }];
  for (const query of ['*', localCard]) {
    resetReads();
    assertDenied(
      await searchCards({
        boardId: 'board-A',
        actorId: 'actor',
        model: 'fixture',
        toolCall: toolCall(query),
      })
    );
  }
  console.info('verified same/other-workspace foreign UUID/short-ID and actor workspace scope');
} else if (mode === 'caller') {
  for (const query of ['*', localCard]) {
    resetReads();
    const providerInputs: string[] = [];
    const searchInputs: Array<Parameters<typeof searchCards>[0]> = [];
    boardChatAssistDeps.searchCards = async (input) => {
      searchInputs.push(input);
      return searchCards(input);
    };
    boardChatAssistDeps.requestBoardChatAssistCompletion = (input) => {
      providerInputs.push(JSON.stringify(input.messages));
      return Promise.resolve(
        providerInputs.length === 1
          ? { status: 200, data: { model: 'fixture', toolCalls: [toolCall(query)] } }
          : { status: 200, data: { model: 'fixture', message: 'Done' } }
      );
    };
    assert.equal(
      (
        await assistBoardChat({
          boardId: 'board-A',
          actorId: 'actor',
          sessionId: 'session',
          prompt: 'Find the card',
          request: new Request('http://fixture.invalid'),
          board: { id: 'board-A', workspace_id: 'workspace-A', title: 'Board', state: 'ACTIVE' },
        })
      ).status,
      200
    );
    assert.equal(searchInputs[0]?.actorId, 'actor');
    assert.equal(searchInputs[0].boardId, 'board-A');
    assert.equal(providerInputs.length, 2);
    assert.ok(providerInputs[1]?.includes('PRIVATE_DESCRIPTION'));
    assert.ok(providerInputs[1]?.includes('PRIVATE_FILENAME.txt'));
    assert.equal(providerInputs[1]?.includes('PRIVATE_BYTES'), query === localCard);
    assert.ok(!providerInputs[1].includes('COMMENT_DRAFT'));
  }
  console.info(
    'verified dispatcher actor propagation and authorized provider metadata/content in both branches'
  );
} else {
  throw new Error(`Unknown scenario: ${mode}`);
}
