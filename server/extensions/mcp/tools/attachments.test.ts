import { strict as assert } from 'node:assert';
import { MAX_DOWNLOAD_BYTES, registerAttachmentTools } from './attachments';
import {
  apiError, defineToolScenarios, expectAnnotations, expectReadErrors, html, json, type Harness, type RecordedRequest,
} from './toolSupport.fixture';

const file = (fields: Record<string, unknown> = {}) => ({
  id: 'a1', card_id: 'c1', name: 'shot.png', type: 'FILE', status: 'READY', external_url: null,
  content_type: 'image/png', size_bytes: 4, view_url: '/api/v1/attachments/a1/view', ...fields,
});
const link = { id: 'a2', card_id: 'c1', name: 'Docs', type: 'URL', status: 'READY', external_url: null,
  content_type: null, size_bytes: null, view_url: 'https://example.test/docs' };
const calls = (h: Harness) => h.requests.map(({ method, path, body }) => ({ method, path, body }));
const get = (path: string) => ({ method: 'GET', path, body: undefined });
const route = (write: () => Response, read: () => Response) =>
  (r: RecordedRequest) => (r.method === 'GET' ? read() : write());
const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const binary = (body: BodyInit, type = 'image/png', status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': type } });
// List GETs get `rows`, the /view GET gets `view`.
const serve = (rows: unknown[], view: () => Response) =>
  (r: RecordedRequest) => (r.path.endsWith('/view') ? view() : json({ data: rows }));

defineToolScenarios(import.meta, registerAttachmentTools, {
  registration: (h) => {
    expectAnnotations(h, ['get_attachments', 'download_attachment'], { readOnlyHint: true });
    expectAnnotations(h, ['delete_attachment'], { destructiveHint: true });
  },
  get_attachments: async (h) => {
    h.respond(() => json({ data: [file(), link] }));
    assert.deepEqual(await h.ok('get_attachments', { cardId: 'c/1' }), [file(), link]);
    assert.deepEqual(calls(h), [get('/api/v1/cards/c%2F1/attachments')]);
    await expectReadErrors(h, 'get_attachments', { cardId: 'c1' });
  },
  download_image: async (h) => {
    h.respond(serve([link, file()], () => binary(bytes, 'image/png; charset=binary')));
    const { result, isError } = await h.call('download_attachment', { cardId: 'c1', attachmentId: 'a1' });
    assert.equal(isError, false);
    assert.deepEqual(result.content, [
      { type: 'text', text: JSON.stringify({ id: 'a1', name: 'shot.png', size_bytes: 4, content_type: 'image/png' }) },
      { type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: 'image/png' },
    ]);
    assert.deepEqual(calls(h), [get('/api/v1/cards/c1/attachments'), get('/api/v1/attachments/a1/view')]);
  },
  download_resource: async (h) => {
    const pdf = file({ id: 'a/3', name: 'doc.pdf', content_type: 'application/pdf', size_bytes: 3 });
    h.respond(serve([pdf], () => binary('PDF', 'application/pdf')));
    const { result } = await h.call('download_attachment', { cardId: 'c1', attachmentId: 'a/3' });
    const block = result.content[1];
    assert.ok(block?.type === 'resource' && 'blob' in block.resource);
    assert.equal(block.resource.blob, Buffer.from('PDF').toString('base64'));
    assert.equal(block.resource.mimeType, 'application/pdf');
    assert.ok(block.resource.uri.endsWith('/api/v1/attachments/a%2F3/view'));
    assert.equal(h.requests[1]?.path, '/api/v1/attachments/a%2F3/view');
  },
  download_refusals: async (h) => {
    const args = { cardId: 'c1', attachmentId: 'a1' };
    const refuse = async (row: unknown, code: string) => {
      h.respond(serve([row], () => binary(bytes)));
      await h.fail('download_attachment', args, code);
      assert.equal(h.requests.length, 1, `${code}: no /view fetch`);
    };
    await refuse({ ...link, id: 'a1' }, 'not-a-file');
    await refuse(file({ external_url: 'https://example.test/x' }), 'not-a-file');
    await refuse(file({ status: 'PENDING' }), 'not-ready');
    await refuse(file({ size_bytes: MAX_DOWNLOAD_BYTES + 1 }), 'attachment-too-large');
    await refuse(file({ id: 'other' }), 'readback-failed');
    await refuse(file({ size_bytes: 'four' }), 'invalid-response');
  },
  download_too_large: async (h) => {
    const args = { cardId: 'c1', attachmentId: 'a1' };
    const big = new Uint8Array(MAX_DOWNLOAD_BYTES + 1);
    // Content-Length over the cap (row size unknown).
    h.respond(serve([file({ size_bytes: null })], () => binary(big)));
    await h.fail('download_attachment', args, 'attachment-too-large');
    // No Content-Length: the streamed byte count trips the cap.
    h.respond(serve([file({ size_bytes: null })], () => binary(new ReadableStream({
      pull(controller) { controller.enqueue(big); controller.close(); },
    }))));
    await h.fail('download_attachment', args, 'attachment-too-large');
  },
  download_errors: async (h) => {
    const args = { cardId: 'c1', attachmentId: 'a1' };
    const view = async (response: () => Response, code: string) => {
      h.respond(serve([file()], response));
      await h.fail('download_attachment', args, code);
    };
    await view(() => apiError(404, 'attachment-not-found'), 'http-404');
    await view(() => json({ name: 'attachment-pending' }, 202), 'http-202');
    await view(() => Response.redirect('https://example.test/elsewhere', 302), 'http-302');
    await view(html, 'invalid-response');
    await view(() => binary(new Uint8Array(3)), 'size-mismatch');
    h.respond(() => apiError(403, 'forbidden'));
    await h.fail('download_attachment', args, 'forbidden');
    h.respond(html);
    await h.fail('download_attachment', args, 'invalid-response');
    h.respond(() => json(null));
    await h.fail('download_attachment', args, 'invalid-response');
  },
  add_url_attachment: async (h) => {
    const args = { cardId: 'c1', url: 'https://example.test/docs', name: 'Docs' };
    h.respond(route(() => json({ data: { id: 'a2' } }, 201), () => json({ data: [file(), link] })));
    assert.deepEqual(await h.ok('add_url_attachment', args), link);
    assert.deepEqual(calls(h), [
      { method: 'POST', path: '/api/v1/cards/c1/attachments/url', body: { url: 'https://example.test/docs', name: 'Docs' } },
      get('/api/v1/cards/c1/attachments'),
    ]);
    // name omitted is not sent; the server currently requires it.
    h.respond(route(() => apiError(400, 'bad-request'), () => json({ data: [] })));
    await h.fail('add_url_attachment', { cardId: 'c1', url: 'https://example.test/docs' }, 'bad-request');
    assert.deepEqual(calls(h)[0]?.body, { url: 'https://example.test/docs' });
    h.respond(route(() => json({ data: { id: 'a2' } }, 201), () => json({ data: [file()] })));
    await h.fail('add_url_attachment', args, 'readback-failed');
    h.respond(route(() => json(null), () => json({ data: [link] })));
    await h.fail('add_url_attachment', args, 'invalid-response');
    h.respond(route(html, () => json({ data: [link] })));
    await h.fail('add_url_attachment', args, 'invalid-response');
    h.respond(route(() => json({ data: { id: 'a2' } }, 201), () => apiError(404)));
    await h.fail('add_url_attachment', args, 'http-404');
  },
  delete_attachment: async (h) => {
    const args = { cardId: 'c1', attachmentId: 'a1' };
    h.respond(route(() => json({ data: { id: 'a1' } }), () => json({ data: [link] })));
    assert.deepEqual(await h.ok('delete_attachment', args), { deleted: true, id: 'a1' });
    assert.deepEqual(calls(h), [
      { method: 'DELETE', path: '/api/v1/attachments/a1', body: undefined },
      get('/api/v1/cards/c1/attachments'),
    ]);
    // Still listed (also covers a null or HTML-200 DELETE).
    h.respond(route(html, () => json({ data: [file()] })));
    await h.fail('delete_attachment', args, 'delete-failed');
    h.respond(route(() => json(null), () => json({ data: [file()] })));
    await h.fail('delete_attachment', args, 'delete-failed');
    h.respond(route(() => apiError(403, 'forbidden'), () => json({ data: [] })));
    await h.fail('delete_attachment', args, 'forbidden');
    h.respond(route(() => json({ data: { id: 'a1' } }), html));
    await h.fail('delete_attachment', args, 'invalid-response');
  },
});
