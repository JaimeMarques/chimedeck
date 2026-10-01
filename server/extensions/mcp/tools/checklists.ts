import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolError, apiPath, dataOf, findRow, request, rowWithId, runTool } from './toolSupport';

// Checklist writes. Names, arguments and return shapes mirror the local Python
// server (chimedeck_mcp/tools.py); every write reads the card back.

const destructive = { destructiveHint: true };
const checklistId = z.string().min(1).describe('ID of the checklist');
const itemId = z.string().min(1).describe('ID of the checklist item');

// Write responses carry the owning card, which the read-back uses.
const written = dataOf(rowWithId.extend({ card_id: z.string().min(1) }));
const itemRow = z.looseObject({ id: z.string().min(1), checklist_id: z.string().nullable() });
const cardWithChecklists = z.looseObject({
  data: rowWithId,
  includes: z.looseObject({ checklists: z.array(rowWithId), checklistItems: z.array(itemRow) }),
});
type Card = z.infer<typeof cardWithChecklists>;

const readCard = (cardId: string, token: string) =>
  request({ path: apiPath`/api/v1/cards/${cardId}`, token, schema: cardWithChecklists });

// Python _checklist_view: {checklist, items, card}.
function checklistView(card: Card, id: string) {
  const checklist = findRow(card.includes.checklists, 'id', id);
  return { checklist, items: card.includes.checklistItems.filter((item) => item.checklist_id === id), card };
}

// Python _item_view: {item, card}.
const itemView = (card: Card, id: string) => ({ item: findRow(card.includes.checklistItems, 'id', id), card });

export function registerChecklistTools(server: McpServer, token: string): void {
  const write = async (method: string, path: string, body: unknown) =>
    (await request({ method, path, body, token, schema: written })).data;

  // There is no GET route for a checklist or item, so a delete is verified on the card.
  const deleteFromCard = async (path: string, cardId: string, id: string, rows: (card: Card) => Array<{ id: string }>) => {
    await request({ method: 'DELETE', path, token, schema: z.unknown() });
    if (rows(await readCard(cardId, token)).some((row) => row.id === id)) throw new ToolError('delete-failed');
    return { deleted: true, id };
  };

  server.registerTool('create_checklist', {
    description: 'Create a checklist on a card. Returns {checklist, items, card}.',
    inputSchema: {
      cardId: z.string().min(1).describe('ID of the card'),
      title: z.string().min(1).describe('Checklist title'),
    },
  }, (args) => runTool(token, async () => {
    const created = await write('POST', apiPath`/api/v1/cards/${args.cardId}/checklists`, { title: args.title });
    return checklistView(await readCard(created.card_id, token), created.id);
  }));

  server.registerTool('add_checklist_item', {
    description: 'Add an item to a checklist. Returns {item, card}.',
    inputSchema: { checklistId, title: z.string().min(1).describe('Item text') },
  }, (args) => runTool(token, async () => {
    const created = await write('POST', apiPath`/api/v1/checklists/${args.checklistId}/items`, { title: args.title });
    return itemView(await readCard(created.card_id, token), created.id);
  }));

  server.registerTool('set_checklist_item', {
    description: 'Check/uncheck or rename a checklist item. Returns {item, card}. Give checked, title or both.',
    inputSchema: {
      itemId,
      checked: z.boolean().optional().describe('true to tick, false to untick'),
      title: z.string().min(1).optional().describe('New item text'),
    },
  }, ({ itemId: id, checked, title }) => runTool(token, async () => {
    // [why] Python's schema anyOf(checked, title); a zod raw shape cannot express it.
    if (checked === undefined && title === undefined) throw new ToolError('nothing-to-update');
    const updated = await write('PATCH', apiPath`/api/v1/checklist-items/${id}`, { checked, title });
    return itemView(await readCard(updated.card_id, token), updated.id);
  }));

  server.registerTool('rename_checklist', {
    description: 'Rename a checklist. Returns {checklist, items, card}.',
    inputSchema: { checklistId, title: z.string().min(1).describe('New title') },
  }, (args) => runTool(token, async () => {
    const updated = await write('PATCH', apiPath`/api/v1/checklists/${args.checklistId}`, { title: args.title });
    return checklistView(await readCard(updated.card_id, token), updated.id);
  }));

  server.registerTool('delete_checklist', {
    description: 'Delete a checklist and all its items.',
    inputSchema: { cardId: z.string().min(1).describe('ID of the card the checklist is on'), checklistId },
    annotations: destructive,
  }, (args) => runTool(token, () => deleteFromCard(
    apiPath`/api/v1/checklists/${args.checklistId}`, args.cardId, args.checklistId, (card) => card.includes.checklists,
  )));

  server.registerTool('delete_checklist_item', {
    description: 'Delete one checklist item.',
    inputSchema: { cardId: z.string().min(1).describe('ID of the card the item is on'), itemId },
    annotations: destructive,
  }, (args) => runTool(token, () => deleteFromCard(
    apiPath`/api/v1/checklist-items/${args.itemId}`, args.cardId, args.itemId, (card) => card.includes.checklistItems,
  )));
}
