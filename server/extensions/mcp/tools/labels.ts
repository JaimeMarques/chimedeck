import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ToolError, apiPath, dataOf, deleteNoContent, expectFields, findRow, inParent, readCard, request, rowWithId, rowsOf, runTool,
} from './toolSupport';

// Board labels and card labels. Names, arguments and read-backs mirror the
// local Python server (chimedeck_mcp/tools.py, "Extensions: labels").

const cardId = z.string().min(1).describe('ID of the card');
const boardId = z.string().min(1).describe('ID of the board');
const written = dataOf(z.looseObject({}));

// Card read-back that must show the label attached (or detached).
async function cardWithLabel(id: string, labelId: string, attached: boolean, token: string) {
  const card = await readCard(id, token);
  const labels = z.array(rowWithId).safeParse(card.includes?.labels);
  if (!labels.success) throw new ToolError('invalid-response');
  if (labels.data.some((label) => label.id === labelId) !== attached) throw new ToolError('readback-failed');
  return card;
}

export function registerLabelTools(server: McpServer, token: string): void {
  const boardLabels = async (board: string) =>
    (await request({ path: apiPath`/api/v1/boards/${board}/labels`, token, schema: rowsOf(rowWithId) })).data;

  server.registerTool('add_card_label', {
    description: 'Add an existing board label to a card. Returns the card with its includes.',
    inputSchema: { cardId, labelId: z.string().min(1).describe('ID of the label (see list_labels)') },
  }, (args) => runTool(token, async () => {
    await request({
      method: 'POST', path: apiPath`/api/v1/cards/${args.cardId}/labels`,
      body: { labelId: args.labelId }, token, schema: written,
    });
    return cardWithLabel(args.cardId, args.labelId, true, token);
  }));

  server.registerTool('remove_card_label', {
    description: 'Remove a label from a card. Returns the card with its includes.',
    inputSchema: { cardId, labelId: z.string().min(1).describe('ID of the label') },
  }, (args) => runTool(token, async () => {
    await deleteNoContent(apiPath`/api/v1/cards/${args.cardId}/labels/${args.labelId}`, token);
    return cardWithLabel(args.cardId, args.labelId, false, token);
  }));

  server.registerTool('create_label', {
    description: 'Create a label on a board.',
    inputSchema: {
      boardId,
      name: z.string().min(1).describe('Label name (must not be empty)'),
      color: z.string().min(1).describe('Hex color, e.g. #0079BF'),
    },
  }, (args) => runTool(token, async () => {
    const created = await request({
      method: 'POST', path: apiPath`/api/v1/boards/${args.boardId}/labels`,
      body: { name: args.name, color: args.color }, token, schema: dataOf(rowWithId),
    });
    const row = findRow(await boardLabels(args.boardId), 'id', created.data.id);
    // Stored as name.trim() and the color verbatim (board/api/labels.ts).
    expectFields(row, { name: args.name.trim(), color: args.color });
    return row;
  }));

  server.registerTool('delete_label', {
    description: 'Delete a board label. It is removed from every card that carried it. '
      + 'The label must be on boardId (not-in-board otherwise).',
    inputSchema: {
      boardId: z.string().min(1).describe('ID of the board the label belongs to'),
      labelId: z.string().min(1).describe('ID of the label'),
    },
    annotations: { destructiveHint: true },
  }, (args) => runTool(token, async () => {
    // [why] There is no GET /labels/:id, so the board's label list is both the
    // scope check (DELETE /labels/:id alone would delete it on any board) and the read-back.
    const target = inParent(await boardLabels(args.boardId), args.labelId, 'board');
    await deleteNoContent(apiPath`/api/v1/labels/${target.id}`, token);
    if ((await boardLabels(args.boardId)).some((label) => label.id === target.id)) throw new ToolError('delete-failed');
    return { deleted: true, id: target.id };
  }));
}
