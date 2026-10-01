import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolError, apiPath, assertGone, dataOf, readCard, request, rowWithId, runTool } from './toolSupport';

// Card writes: field edits, due date, archive, delete, copy. Names, arguments
// and read-backs mirror the local Python server (chimedeck_mcp/tools.py,
// "Extensions: card writes").

const cardId = z.string().min(1).describe('ID of the card');
// [why] PATCH /cards/:id stores due_date without validating it; reject non-dates here.
const dueDate = z.string()
  .refine((value) => value === '' || !Number.isNaN(Date.parse(value)), 'Expected an ISO-8601 date')
  .nullable().optional();
const written = dataOf(rowWithId);

type CardFields = { title?: string; description?: string; due_date?: string | null; due_complete?: boolean };

// Read the card back and check the fields that come back verbatim. Title and
// description are sanitized server-side, so they are not compared.
async function patchCard(id: string, fields: CardFields, token: string) {
  if (Object.keys(fields).length === 0) throw new ToolError('nothing-to-update');
  await request({ method: 'PATCH', path: apiPath`/api/v1/cards/${id}`, body: fields, token, schema: written });
  const card = await readCard(id, token);
  const { due_date: date, due_complete: complete } = card.data;
  if (fields.due_complete !== undefined && complete !== fields.due_complete) throw new ToolError('readback-failed');
  if (fields.due_date !== undefined) {
    const got = typeof date === 'string' ? Date.parse(date) : date;
    if (got !== (fields.due_date === null ? null : Date.parse(fields.due_date))) throw new ToolError('readback-failed');
  }
  return card;
}

// snake_case body; camelCase keys are silently ignored by the server.
function dueFields(args: { dueDate?: string | null | undefined; dueComplete?: boolean | undefined }): CardFields {
  const fields: CardFields = {};
  // [why] An explicit UTC instant: a bare date would be stored in the DB session's
  // timezone and fail the read-back comparison on a non-UTC database.
  if (args.dueDate !== undefined) fields.due_date = args.dueDate ? new Date(args.dueDate).toISOString() : null;
  if (args.dueComplete !== undefined) fields.due_complete = args.dueComplete;
  return fields;
}

export function registerCardEdits(server: McpServer, token: string): void {
  server.registerTool('update_card', {
    description: "Update a card's title, description, due date and/or completion tick. "
      + 'Pass only the fields to change. Returns the card with its includes.',
    inputSchema: {
      cardId,
      title: z.string().optional().describe('New title'),
      description: z.string().optional().describe('New description'),
      dueDate: dueDate.describe('Due date as ISO-8601 (e.g. 2026-09-20T12:00:00.000Z); null or empty string clears it'),
      dueComplete: z.boolean().optional().describe('Mark the due date complete (the visible tick) or not'),
    },
  }, (args) => runTool(token, () => {
    const fields: CardFields = {};
    if (args.title !== undefined) fields.title = args.title;
    if (args.description !== undefined) fields.description = args.description;
    return patchCard(args.cardId, { ...fields, ...dueFields(args) }, token);
  }));

  server.registerTool('set_card_due', {
    description: "Set or clear a card's due date and its completion tick. Returns the card with its includes.",
    inputSchema: {
      cardId,
      dueDate: dueDate.describe('Due date as ISO-8601; null or empty clears it'),
      dueComplete: z.boolean().optional().describe('Mark complete (true) or not (false)'),
    },
  }, (args) => runTool(token, () => patchCard(args.cardId, dueFields(args), token)));

  server.registerTool('archive_card', {
    description: 'Archive a card (archived=true) or restore it (archived=false). Returns the card with its includes.',
    inputSchema: { cardId, archived: z.boolean().optional().describe('true to archive (default), false to restore') },
  }, (args) => runTool(token, async () => {
    const want = args.archived ?? true;
    // [why] PATCH /cards/:id/archive toggles and ignores its body, so only
    // send it when the card is not already in the requested state.
    const { data: before } = await request({
      path: apiPath`/api/v1/cards/${args.cardId}`, token,
      schema: dataOf(rowWithId.extend({ archived: z.boolean() })),
    });
    if (before.archived !== want) {
      await request({
        method: 'PATCH', path: apiPath`/api/v1/cards/${args.cardId}/archive`,
        body: want ? {} : { archived: false }, token, schema: written,
      });
    }
    const card = await readCard(args.cardId, token);
    if (card.data.archived !== want) throw new ToolError('readback-failed');
    return card;
  }));

  server.registerTool('delete_card', {
    description: 'Permanently delete a card. Prefer archive_card unless deletion is intended.',
    inputSchema: { cardId },
    annotations: { destructiveHint: true },
  }, (args) => runTool(token, async () => {
    const { data: card } = await readCard(args.cardId, token); // resolves a short ID to the UUID
    await request({ method: 'DELETE', path: apiPath`/api/v1/cards/${card.id}`, token, schema: z.unknown() });
    await assertGone(apiPath`/api/v1/cards/${card.id}`, token);
    return { deleted: true, id: card.id, title: card.title };
  }));

  server.registerTool('copy_card', {
    description: 'Copy a card into a list. Returns the new card with its includes.',
    inputSchema: {
      cardId: z.string().min(1).describe('ID of the card to copy'),
      targetListId: z.string().min(1).describe('ID of the destination list'),
      title: z.string().optional().describe('Title for the copy (defaults to the original)'),
      keepChecklists: z.boolean().optional().describe('Copy checklists too'),
      keepMembers: z.boolean().optional().describe('Copy members too'),
    },
  }, ({ cardId: source, targetListId, title, keepChecklists, keepMembers }) => runTool(token, async () => {
    const created = await request({
      method: 'POST', path: apiPath`/api/v1/cards/${source}/copy`,
      body: { targetListId, title, keepChecklists, keepMembers }, token, schema: written,
    });
    return readCard(created.data.id, token);
  }));
}
