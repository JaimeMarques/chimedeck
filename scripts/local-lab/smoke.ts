import { strict as assert } from 'node:assert';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { demoCards } from './demoFixtures';
import { equal, timestamp } from '../../server/extensions/mcp/tools/results';

const state = Bun.env.LAB_STATE;
if (!state) throw new Error('Explicit private lab state required');
const user = z.object({ id: z.string(), email: z.string(), token: z.string() });
const credentials = z
  .object({
    marker: z.string(),
    apiUrl: z.literal('http://127.0.0.1:33000'),
    frontendUrl: z.literal('http://127.0.0.1:35173'),
    admin: user,
    member: user,
    restricted: user,
    raceTarget: user,
    password: z.string(),
    boardId: z.string(),
    workspaceId: z.string(),
    cardId: z.string(),
    listId: z.string(),
    demoCards: z
      .array(
        z.object({
          id: z.string(),
          shortId: z.string(),
          title: z.string(),
          description: z.string(),
        })
      )
      .length(10),
  })
  .parse(JSON.parse(await readFile(resolve(state, 'credentials.json'), 'utf8')));
const identity = z
  .object({ marker: z.string() })
  .parse(JSON.parse(await readFile(resolve(state, 'identity.json'), 'utf8')));
if (credentials.marker !== identity.marker) throw new Error('Lab identity mismatch');
const base = credentials.apiUrl;
const token = credentials.admin.token;
const payloadSchema = z.looseObject({ data: z.looseObject({ id: z.string() }) });
const parseResult = (result: CallToolResult): Record<string, unknown> => {
  assert.ok(!JSON.stringify(result).includes(token));
  assert.notEqual(result.isError, true);
  const first = result.content[0];
  assert.ok(first?.type === 'text');
  return z.record(z.string(), z.unknown()).parse(JSON.parse(first.text));
};
async function rest(path: string, method = 'GET', body?: unknown, auth = token) {
  if (!path.startsWith('/api/v1/') || path.includes('..'))
    throw new Error('Refusing non-lab route');
  const response = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  return response;
}
async function jsonRest(path: string, method = 'GET', body?: unknown) {
  const response = await rest(path, method, body);
  assert.ok(response.ok, `Local REST failed: ${method} ${path} (${String(response.status)})`);
  return (await response.json()) as unknown;
}
const clients: Client[] = [];
async function stdio(auth: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['server/extensions/mcp/index.ts'],
    cwd: process.cwd(),
    env: {
      PATH: Bun.env.PATH ?? '',
      HOME: Bun.env.HOME ?? '',
      CHIMEDECK_TOKEN: auth,
      CHIMEDECK_URL: base,
      CHIMEDECK_API_URL: base,
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'isolated-lab-smoke', version: '1' });
  await client.connect(transport);
  clients.push(client);
  return client;
}
const admin = await stdio(token);
const member = await stdio(credentials.member.token);
const restricted = await stdio(credentials.restricted.token);
const hosted = new Client({ name: 'isolated-lab-http-smoke', version: '1' });
const http = new StreamableHTTPClientTransport(new URL('/api/mcp', base), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
// The SDK class exposes sessionId: string|undefined while Transport's exact
// optional property means absent|string. Forward its real protocol methods.
const transport: Transport = {
  start: () => http.start(),
  send: (message, options) => http.send(message, options),
  close: () => http.close(),
};
http.onmessage = (...args) => transport.onmessage?.(...args);
http.onerror = (error) => transport.onerror?.(error);
http.onclose = () => transport.onclose?.();
await hosted.connect(transport);
clients.push(hosted);
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
  parseResult((await client.callTool({ name, arguments: args })) as CallToolResult);
const cardRows = z.object({ data: z.array(z.looseObject({ id: z.string(), title: z.string() })) });
async function verifyDemoReads() {
  assert.deepEqual(
    credentials.demoCards.map(({ shortId, title, description }) => ({
      shortId,
      title,
      description,
    })),
    demoCards.map(({ shortId, title, description }) => ({ shortId, title, description }))
  );
  for (const client of [admin, hosted]) {
    for (const [tool, args] of [
      ['list_cards', { listId: credentials.listId }],
      ['search_cards', { workspaceId: credentials.workspaceId, query: 'Lab' }],
    ] as const) {
      for (const options of [{}, { includeDescription: true }, { view: 'full' }]) {
        const rows = cardRows.parse(await call(client, tool, { ...args, ...options })).data;
        assert.equal(rows.length, 10, `${tool}: persistent demo count`);
        assert.deepEqual(
          rows.map((row) => row.id).sort(),
          credentials.demoCards.map((row) => row.id).sort()
        );
        for (const fixture of credentials.demoCards) {
          const row = rows.find((value) => value.id === fixture.id);
          assert.ok(row);
          assert.equal(row.title, fixture.title);
          if ('includeDescription' in options || 'view' in options)
            assert.equal(row.description, fixture.description);
          else assert.ok(!('description' in row), `${tool}: compact default omits description`);
        }
      }
    }
    for (const fixture of credentials.demoCards) {
      for (const options of [{}, { view: 'full' }]) {
        const card = z
          .object({ data: z.looseObject({ id: z.string(), description: z.string() }) })
          .parse(await call(client, 'get_card', { cardId: fixture.id, ...options })).data;
        assert.equal(card.id, fixture.id);
        assert.equal(card.description, fixture.description);
        const expected = demoCards.find((value) => value.shortId === fixture.shortId);
        assert.ok(expected);
        if (expected.dueDate) assert.equal(timestamp(card.due_date), timestamp(expected.dueDate));
        if (expected.amount) {
          assert.ok(equal('amount', card.amount, 123.45));
          assert.equal(card.currency, expected.currency);
        }
        if (['labcard2', 'labcard3', 'labcard4'].includes(fixture.shortId)) {
          const detail = await call(client, 'get_card', { cardId: fixture.id });
          const labels = z
            .object({
              includes: z.object({
                labels: z.array(z.object({ name: z.string(), color: z.string() })),
              }),
            })
            .parse(detail).includes.labels;
          assert.deepEqual(
            labels.map(({ name, color }) => ({ name, color })),
            [{ name: 'Synthetic demo', color: '#2563EB' }]
          );
        }
      }
    }
  }
}
let createdCard: string | undefined;
let createdBoard: string | undefined;
try {
  await verifyDemoReads();
  assert.equal((await call(admin, 'get_me')).id, credentials.admin.id);
  const [stdioTools, hostedTools] = await Promise.all([admin.listTools(), hosted.listTools()]);
  assert.equal(stdioTools.tools.length, 61);
  assert.deepEqual(
    stdioTools.tools.map((tool) => tool.name),
    hostedTools.tools.map((tool) => tool.name)
  );
  const disk = stdioTools.tools.find((tool) => tool.name === 'download_attachment');
  const hostedDisk = hostedTools.tools.find((tool) => tool.name === 'download_attachment');
  assert.ok(disk?.inputSchema.required?.includes('destPath'));
  assert.equal(hostedDisk?.inputSchema.properties?.destPath, undefined);
  assert.equal(
    (
      (await restricted.callTool({
        name: 'get_card',
        arguments: { cardId: credentials.cardId },
      })) as CallToolResult
    ).isError,
    true
  );
  const board = await call(admin, 'create_board', {
    workspaceId: credentials.workspaceId,
    title: 'Synthetic board roundtrip',
    description: 'Board العربية',
    background: '   ',
  });
  assert.equal(board.verified, true);
  createdBoard = z.string().parse(board.id);
  const selected = z.object({ short_id: z.string().length(8) }).parse(board.board);
  const rawBoard = await rest(`/api/v1/boards/${createdBoard}`);
  assert.equal(rawBoard.status, 200);
  z.object({ data: z.object({ background: z.null() }) }).parse(await rawBoard.json());
  const list = await call(admin, 'create_list', {
    boardId: selected.short_id,
    title: 'Synthetic list',
  });
  assert.equal(list.verified, true);
  const membership = await call(admin, 'invite_to_board', {
    boardId: createdBoard,
    email: credentials.member.email,
  });
  assert.equal(membership.verified, true);
  assert.equal(membership.user_id, credentials.member.id);
  assert.equal(membership.id, undefined);
  assert.equal(
    (
      (await admin.callTool({
        name: 'invite_to_board',
        arguments: { boardId: createdBoard, email: credentials.member.email, role: 'admin' },
      })) as CallToolResult
    ).isError,
    true
  );
  assert.equal(
    (
      await call(admin, 'set_board_member_role', {
        boardId: createdBoard,
        userId: credentials.member.id,
        role: 'admin',
      })
    ).role,
    'ADMIN'
  );
  assert.equal(
    (
      await call(admin, 'set_board_member_role', {
        boardId: createdBoard,
        userId: credentials.member.id,
        role: 'member',
      })
    ).role,
    'MEMBER'
  );
  const renamed = await call(admin, 'rename_list', {
    boardId: createdBoard,
    listId: list.id,
    title: 'Renamed synthetic list',
  });
  assert.equal(renamed.title, 'Renamed synthetic list');
  const updatedBoard = await call(admin, 'update_board', {
    boardId: createdBoard,
    title: 'Updated synthetic board',
  });
  assert.equal(updatedBoard.title, 'Updated synthetic board');
  assert.equal(
    (
      await rest(
        `/api/v1/cards/${credentials.cardId}`,
        'PATCH',
        { title: 'forbidden' },
        credentials.restricted.token
      )
    ).status,
    403
  );
  const original = await call(admin, 'get_card', { cardId: credentials.cardId });
  assert.deepEqual(original, await call(hosted, 'get_card', { cardId: credentials.cardId }));
  assert.deepEqual(original, await call(member, 'get_card', { cardId: credentials.cardId }));
  const race = await Promise.all(
    [0, 1].map(() =>
      rest(`/api/v1/boards/${credentials.boardId}/members`, 'POST', {
        userId: credentials.raceTarget.id,
        role: 'MEMBER',
      })
    )
  );
  assert.deepEqual(race.map((response) => response.status).sort(), [201, 409]);
  assert.equal(
    (
      await rest(
        `/api/v1/cards/${credentials.cardId}`,
        'GET',
        undefined,
        credentials.raceTarget.token
      )
    ).status,
    200
  );
  assert.ok(
    (
      await rest(
        `/api/v1/boards/${credentials.boardId}/members/${credentials.raceTarget.id}`,
        'DELETE'
      )
    ).ok
  );
  assert.equal(
    (
      (await restricted.callTool({
        name: 'get_card',
        arguments: { cardId: credentials.cardId },
      })) as CallToolResult
    ).isError,
    true
  );
  const created = await call(admin, 'create_card', {
    listId: credentials.listId,
    title: 'Synthetic roundtrip',
    description: 'Complete UTF-8 — العربية 🐦',
  });
  assert.equal(created.request_outcome, 'succeeded');
  assert.equal(created.verified, true);
  createdCard = z.string().parse(created.id);
  const label = await call(admin, 'create_label', {
    boardId: credentials.boardId,
    name: 'Synthetic label',
    color: '#123456',
  });
  assert.equal(label.verified, true);
  assert.equal(label.request_outcome, 'succeeded');
  const link = await call(admin, 'add_url_attachment', {
    cardId: createdCard,
    url: `${credentials.frontendUrl}/b/labboard?card=labcard1`,
    name: 'Synthetic local card link',
  });
  assert.equal(link.verified, true);
  assert.equal(link.request_outcome, 'succeeded');
  assert.equal(
    (await call(admin, 'delete_attachment', { cardId: createdCard, attachmentId: link.id }))
      .deleted,
    true
  );
  assert.equal(
    (await call(admin, 'add_card_label', { cardId: createdCard, labelId: label.id })).verified,
    true
  );
  assert.equal(
    (await call(admin, 'remove_card_label', { cardId: createdCard, labelId: label.id })).verified,
    true
  );
  assert.equal(
    (await call(admin, 'delete_label', { boardId: credentials.boardId, labelId: label.id }))
      .deleted,
    true
  );
  assert.equal(
    (await call(admin, 'add_card_member', { cardId: createdCard, userId: credentials.member.id }))
      .verified,
    true
  );
  assert.equal(
    (
      await call(admin, 'remove_card_member', {
        cardId: createdCard,
        userId: credentials.member.id,
      })
    ).verified,
    true
  );
  const copy = await call(admin, 'copy_card', {
    cardId: createdCard,
    targetListId: list.id,
    title: 'Synthetic copy',
  });
  assert.equal(copy.verified, true);
  const moved = await call(admin, 'move_card', {
    cardId: copy.id,
    targetListId: credentials.listId,
    afterCardId: null,
  });
  assert.equal(moved.verified, true);
  await call(admin, 'delete_card', { cardId: copy.id });
  const updated = await call(hosted, 'update_card', {
    cardId: createdCard,
    title: 'Updated roundtrip',
    dueDate: '2026-10-12T12:00:00.123Z',
    dueComplete: true,
  });
  assert.equal(updated.verified, true);
  assert.equal(
    (
      await call(admin, 'set_card_price', {
        cardId: createdCard,
        amount: 123.45,
        currency: 'USD',
        label: ' lab ',
      })
    ).verified,
    true
  );
  const checklist = await call(admin, 'create_checklist', {
    cardId: createdCard,
    title: 'Task list',
  });
  assert.equal(checklist.verified, true);
  const first = await call(admin, 'add_checklist_item', {
    checklistId: checklist.id,
    title: 'First',
  });
  const second = await call(hosted, 'add_checklist_item', {
    checklistId: checklist.id,
    title: 'Second',
  });
  assert.equal(first.verified, true);
  assert.equal(second.verified, true);
  const batch = await call(admin, 'set_checklist_items', {
    cardId: createdCard,
    items: [
      { itemId: first.id, checked: true },
      { itemId: second.id, title: 'Second done' },
    ],
  });
  assert.equal(batch.complete, true);
  const comment = await call(member, 'write_comment', {
    cardId: createdCard,
    content: 'Parent discussion العربية',
  });
  assert.equal(comment.verified, true);
  const parentId = z.string().parse(comment.id);
  const reply = payloadSchema.parse(
    await jsonRest(`/api/v1/cards/${createdCard}/comments`, 'POST', {
      content: 'Synthetic reply',
      parent_id: parentId,
    })
  );
  const discussion = await call(hosted, 'get_card_discussion', { cardId: createdCard, all: true });
  assert.equal(discussion.complete, true);
  assert.equal(z.array(z.unknown()).parse(discussion.data).length, 2);
  assert.equal(
    (
      await call(admin, 'edit_comment', {
        cardId: createdCard,
        commentId: reply.data.id,
        content: 'Reply edited',
      })
    ).verified,
    true
  );
  const bytes = new TextEncoder().encode('Synthetic attachment — العربية 🐦');
  const upload = z
    .object({ data: z.object({ attachmentId: z.string(), uploadUrl: z.string() }) })
    .parse(
      await jsonRest(`/api/v1/cards/${createdCard}/attachments/upload-url`, 'POST', {
        filename: 'lab.txt',
        mimeType: 'text/plain',
        sizeBytes: bytes.length,
      })
    );
  const storageUrl = new URL(upload.data.uploadUrl);
  assert.equal(storageUrl.origin, 'http://127.0.0.1:34566');
  const stored = await fetch(storageUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain' },
    body: bytes,
    redirect: 'manual',
  });
  assert.ok(stored.ok);
  await jsonRest(`/api/v1/cards/${createdCard}/attachments`, 'POST', {
    attachmentId: upload.data.attachmentId,
  });
  const destPath = resolve(state, 'smoke-attachment.txt');
  const downloaded = await call(admin, 'download_attachment', {
    cardId: createdCard,
    attachmentId: upload.data.attachmentId,
    destPath,
  });
  assert.equal(downloaded.size_bytes, bytes.length);
  assert.deepEqual(new Uint8Array(await readFile(destPath)), bytes);
  const inBand = (await hosted.callTool({
    name: 'download_attachment',
    arguments: { cardId: createdCard, attachmentId: upload.data.attachmentId },
  })) as CallToolResult;
  assert.notEqual(inBand.isError, true);
  assert.equal(inBand.content.length, 2);
  assert.equal((await call(admin, 'archive_card', { cardId: createdCard })).verified, true);
  assert.equal(
    (await call(admin, 'archive_card', { cardId: createdCard, archived: false })).verified,
    true
  );
  assert.equal(
    (
      await call(admin, 'delete_attachment', {
        cardId: createdCard,
        attachmentId: upload.data.attachmentId,
      })
    ).deleted,
    true
  );
  assert.equal(
    (await call(admin, 'delete_checklist_item', { cardId: createdCard, itemId: first.id }))
      .verified,
    true
  );
  assert.equal(
    (await call(admin, 'delete_checklist', { cardId: createdCard, checklistId: checklist.id }))
      .verified,
    true
  );
  assert.equal(
    (await call(member, 'delete_comment', { cardId: createdCard, commentId: parentId })).verified,
    true
  );
  assert.equal((await call(admin, 'delete_card', { cardId: createdCard })).deleted, true);
  createdCard = undefined;
  assert.ok((await rest(`/api/v1/boards/${createdBoard}`, 'DELETE', { confirm: true })).ok);
  createdBoard = undefined;
  await verifyDemoReads();
  await writeFile(
    resolve(state, 'smoke-result.json'),
    JSON.stringify({
      status: 'passed',
      catalogue: 61,
      transports: ['stdio', 'http'],
      permissions: ['ADMIN', 'MEMBER', 'restricted GUEST'],
      upload: 'LocalStack real bytes',
      cleanup: 'roundtrip card deleted',
      persistentDemoCards: 10,
      demoReads:
        'both transports: exact IDs/full texts, compact list/search omission, explicit description/full preservation before and after CRUD cleanup',
    }),
    { mode: 0o600 }
  );
  console.info('PASS real local stdio/HTTP CRUD, roles, threads and attachment bytes');
} finally {
  if (createdCard) await rest(`/api/v1/cards/${createdCard}`, 'DELETE').catch(() => {});
  if (createdBoard)
    await rest(`/api/v1/boards/${createdBoard}`, 'DELETE', { confirm: true }).catch(() => {});
  await Promise.all(clients.map((client) => client.close()));
}
