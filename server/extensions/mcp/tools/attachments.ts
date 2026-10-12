import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { config } from '../config';
import { acknowledgedCreate, fields, type Row } from './results';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  ToolError,
  apiFetch,
  apiPath,
  dataOf,
  findRow,
  inParent,
  request,
  rowWithId,
  rowsOf,
  runTool,
} from './toolSupport';

// Card attachments. Names, arguments and read-backs mirror the local Python
// server (chimedeck_mcp/tools.py), except download_attachment, which returns
// the bytes as MCP content instead of writing to the server's disk.

export const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;

const attachmentCardId = z.string().min(1).describe('ID of the card the attachment is on');
const attachmentRow = rowWithId.extend({
  type: z.string().optional(),
  status: z.string().optional(),
  name: z.string().nullable().optional(),
  external_url: z.string().nullable().optional(),
  content_type: z.string().nullable().optional(),
  size_bytes: z.number().nullable().optional(),
});
type AttachmentRow = z.infer<typeof attachmentRow>;

// Reads the body, failing as soon as it passes the cap (Content-Length can be absent or wrong).
async function readCapped(res: Response): Promise<Uint8Array> {
  if (Number(res.headers.get('content-length') ?? 0) > MAX_DOWNLOAD_BYTES) {
    await res.body?.cancel();
    throw new ToolError('attachment-too-large');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body?.getReader();
  for (let next = await reader?.read(); next && !next.done; next = await reader?.read()) {
    total += next.value.byteLength;
    if (total > MAX_DOWNLOAD_BYTES) {
      await reader?.cancel();
      throw new ToolError('attachment-too-large');
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks);
}

async function download(row: AttachmentRow, token: string) {
  // [why] A link has no bytes; /view would 302 to the external URL.
  if (row.type !== 'FILE' || row.external_url) throw new ToolError('not-a-file');
  if (row.status !== 'READY') throw new ToolError('not-ready');
  if ((row.size_bytes ?? 0) > MAX_DOWNLOAD_BYTES) throw new ToolError('attachment-too-large');

  const path = apiPath`/api/v1/attachments/${row.id}/view`;
  const res = await apiFetch(path, token, { redirect: 'manual' });
  // Exactly 200: 202 means still processing, 3xx a redirect we never follow.
  if (res.status !== 200) {
    await res.body?.cancel();
    throw new ToolError(`http-${String(res.status)}`);
  }
  const mimeType =
    (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ||
    row.content_type ||
    'application/octet-stream';
  // The SPA's HTML page (or the browser viewer) instead of the file.
  if (mimeType === 'text/html' && row.content_type !== 'text/html') {
    await res.body?.cancel();
    throw new ToolError('invalid-response');
  }
  const bytes = await readCapped(res);
  if (typeof row.size_bytes === 'number' && bytes.byteLength !== row.size_bytes)
    throw new ToolError('size-mismatch');

  const data = Buffer.from(bytes).toString('base64');
  const block: CallToolResult['content'][number] = mimeType.startsWith('image/')
    ? { type: 'image', data, mimeType }
    : { type: 'resource', resource: { uri: `${config.apiUrl}${path}`, mimeType, blob: data } };
  return {
    meta: {
      id: row.id,
      name: row.name ?? null,
      size_bytes: bytes.byteLength,
      content_type: mimeType,
    },
    block,
  };
}

async function downloadToDisk(row: AttachmentRow, token: string, destPath: string) {
  if (row.type !== 'FILE' || row.external_url) throw new ToolError('not-a-file');
  if (row.status !== 'READY') throw new ToolError('not-ready');
  const destination = resolve(
    destPath.startsWith('~/') ? join(homedir(), destPath.slice(2)) : destPath
  );
  const temporary = join(dirname(destination), `.chimedeck-${randomUUID()}.part`);
  const res = await apiFetch(apiPath`/api/v1/attachments/${row.id}/view`, token);
  if (res.status !== 200) {
    await res.body?.cancel();
    throw new ToolError(`http-${String(res.status)}`);
  }
  const mimeType =
    (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ||
    row.content_type ||
    'application/octet-stream';
  if (mimeType === 'text/html' && row.content_type !== 'text/html') {
    await res.body?.cancel();
    throw new ToolError('invalid-response');
  }
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let published = false;
  let ownedTemporary = false;
  const reader = res.body?.getReader();
  try {
    await mkdir(dirname(destination), { recursive: true });
    file = await open(temporary, 'wx', 0o600);
    ownedTemporary = true;
    let total = 0;
    for (let next = await reader?.read(); next && !next.done; next = await reader?.read()) {
      total += next.value.byteLength;
      if (typeof row.size_bytes === 'number' && total > row.size_bytes)
        throw new ToolError('size-mismatch');
      let offset = 0;
      while (offset < next.value.byteLength) {
        const result = await file.write(next.value, offset, next.value.byteLength - offset);
        if (result.bytesWritten === 0) throw new ToolError('disk-write');
        offset += result.bytesWritten;
      }
    }
    if (
      typeof row.size_bytes !== 'number' ||
      !Number.isSafeInteger(row.size_bytes) ||
      row.size_bytes < 0 ||
      total !== row.size_bytes
    )
      throw new ToolError('size-mismatch');
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, destination);
    published = true;
    return {
      id: row.id,
      name: row.name ?? null,
      path: destination,
      size_bytes: total,
      content_type: mimeType,
      verified: true,
    };
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError('download-failed');
  } finally {
    await reader?.cancel().catch(() => {});
    await file?.close().catch(() => {});
    if (!published && ownedTemporary) await unlink(temporary).catch(() => {});
  }
}

export function registerAttachmentTools(server: McpServer, token: string, localDisk = false): void {
  const cardAttachments = async (cardId: string) =>
    (
      await request({
        path: apiPath`/api/v1/cards/${cardId}/attachments`,
        token,
        schema: rowsOf(rowWithId),
      })
    ).data;

  server.registerTool(
    'get_attachments',
    {
      description: 'List the attachments on a card.',
      inputSchema: { cardId: z.string().min(1).describe('ID of the card') },
      annotations: { readOnlyHint: true },
    },
    (args) => runTool(token, () => cardAttachments(args.cardId))
  );

  server.registerTool(
    'download_attachment',
    {
      description: localDisk
        ? 'Stream an uploaded attachment to destPath on the local stdio client machine. Verifies size before atomic replacement; returns small metadata only.'
        : "Fetch an uploaded card attachment's bytes (max 10 MB). Returns its metadata, then the file " +
          'as an image block (image types) or an embedded resource with a base64 blob. Link attachments have no bytes.',
      inputSchema: {
        cardId: attachmentCardId,
        attachmentId: z.string().min(1).describe('ID of the attachment (from get_attachments)'),
        ...(localDisk
          ? { destPath: z.string().min(1).describe('Local destination file path') }
          : {}),
      },
      annotations: { readOnlyHint: !localDisk },
    },
    async (args) => {
      let block: CallToolResult['content'][number] | undefined;
      const result = await runTool(token, async () => {
        const row = attachmentRow.safeParse(
          inParent(await cardAttachments(args.cardId), args.attachmentId, 'card')
        );
        if (!row.success) throw new ToolError('invalid-response');
        if (localDisk) {
          if (typeof args.destPath !== 'string') throw new ToolError('bad-request');
          return downloadToDisk(row.data, token, args.destPath);
        }
        const file = await download(row.data, token);
        block = file.block;
        return file.meta;
      });
      if (block) result.content.push(block);
      return result;
    }
  );

  server.registerTool(
    'add_url_attachment',
    {
      description: 'Attach a link to a card.',
      inputSchema: {
        cardId: z.string().min(1).describe('ID of the card'),
        url: z.string().min(1).describe('Link URL'),
        name: z.string().optional().describe('Display name (defaults to the URL)'),
      },
    },
    (args) =>
      runTool(token, async () => {
        return acknowledgedCreate(
          () =>
            request({
              method: 'POST',
              path: apiPath`/api/v1/cards/${args.cardId}/attachments/url`,
              // [why] The server rejects a missing name; Python leaves it optional.
              body: { url: args.url, name: args.name || args.url },
              token,
              schema: z.unknown(),
            }),
          async (ack) => {
            const row = findRow(await cardAttachments(args.cardId), 'id', String(ack.id));
            return {
              row,
              selected: true,
              extra: {
                attachment: fields(
                  row,
                  new Set(
                    'id card_id type name external_url view_url content_type size_bytes status created_at'.split(
                      ' '
                    )
                  )
                ) as Row,
              },
            };
          },
          { name: args.name || args.url, view_url: args.url }
        );
      })
  );

  server.registerTool(
    'delete_attachment',
    {
      description:
        'Remove an attachment from a card. It must be on cardId (not-in-card otherwise).',
      inputSchema: {
        cardId: attachmentCardId,
        attachmentId: z.string().min(1).describe('ID of the attachment'),
      },
      annotations: { destructiveHint: true },
    },
    (args) =>
      runTool(token, async () => {
        // [why] There is no GET /attachments/:id, so the card's list is both the
        // scope check (DELETE /attachments/:id alone would delete it on any card) and the read-back.
        const target = inParent(await cardAttachments(args.cardId), args.attachmentId, 'card');
        // The route answers 200 {data: {id}}; anything else (HTML-200, null) is invalid-response.
        const { data } = await request({
          method: 'DELETE',
          path: apiPath`/api/v1/attachments/${target.id}`,
          token,
          schema: dataOf(rowWithId),
        });
        if (data.id !== target.id) throw new ToolError('invalid-response');
        if ((await cardAttachments(args.cardId)).some((row) => row.id === target.id))
          throw new ToolError('delete-failed');
        return { deleted: true, id: target.id };
      })
  );
}
