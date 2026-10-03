import { strict as assert } from 'node:assert';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiPath, assertGone, findRow, readCard, request, rowsOf, rowWithId, runTool } from './toolSupport';
import { apiError, defineToolScenarios, json } from './toolSupport.fixture';

// A scratch write tool exercising the read-back helpers the domain files share.
function registerScratch(server: McpServer, token: string): void {
  server.registerTool('scratch_write', {
    description: 'test only',
    inputSchema: { cardId: z.string(), labelId: z.string() },
  }, ({ cardId, labelId }) => runTool(token, async () => {
    await request({ method: 'PATCH', path: apiPath`/api/v1/cards/${cardId}`, body: { due_complete: true }, token, schema: z.unknown() });
    const card = await readCard(cardId, token);
    const labels = await request({ path: '/api/v1/labels', token, schema: rowsOf(rowWithId) });
    return { card, label: findRow(labels.data, 'id', labelId) };
  }));
  server.registerTool('scratch_delete', {
    description: 'test only',
    inputSchema: { cardId: z.string() },
  }, ({ cardId }) => runTool(token, async () => {
    await assertGone(apiPath`/api/v1/cards/${cardId}`, token);
    return { deleted: true, id: cardId };
  }));
}

const card = { data: { id: 'c 1', title: 'T' }, includes: {} };
const labels = { data: [{ id: 'lb1', name: 'Bug' }] };

defineToolScenarios(import.meta, registerScratch, {
  'read-back': async (h) => {
    h.respond(({ method, path }) => (method === 'PATCH' ? json(null)
      : path.startsWith('/api/v1/cards/') ? json(card) : json(labels)));
    assert.deepEqual(await h.ok('scratch_write', { cardId: 'c 1', labelId: 'lb1' }), { card, label: labels.data[0] });
    assert.deepEqual(h.requests.map(({ method, path, body }) => [method, path, body]), [
      ['PATCH', '/api/v1/cards/c%201', { due_complete: true }],
      ['GET', '/api/v1/cards/c%201', undefined],
      ['GET', '/api/v1/labels', undefined],
    ]);
    await h.fail('scratch_write', { cardId: 'c 1', labelId: 'missing' }, 'readback-failed');
    h.respond(({ method }) => (method === 'PATCH' ? json(null) : json(null)));
    await h.fail('scratch_write', { cardId: 'c 1', labelId: 'lb1' }, 'invalid-response');
  },
  'assert-gone': async (h) => {
    h.respond(() => apiError(404, 'card-not-found'));
    assert.deepEqual(await h.ok('scratch_delete', { cardId: 'c1' }), { deleted: true, id: 'c1' });
    h.respond(() => json(card));
    await h.fail('scratch_delete', { cardId: 'c1' }, 'delete-failed');
    h.respond(() => apiError(500));
    await h.fail('scratch_delete', { cardId: 'c1' }, 'http-500');
  },
});
