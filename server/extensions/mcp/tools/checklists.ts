import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  acknowledgedCreate,
  ambiguous,
  children,
  errorCode,
  equal,
  fields,
  identity,
  relationFields,
  verified,
  type Row,
} from './results';
import {
  ToolError,
  apiPath,
  dataOf,
  deleteNoContent,
  findRow,
  inParent,
  request,
  rowWithId,
  runTool,
} from './toolSupport';

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

const readCard = async (cardId: string, token: string) => {
  const card = await request({
    path: apiPath`/api/v1/cards/${cardId}`,
    token,
    schema: cardWithChecklists,
  });
  if (z.uuid().safeParse(cardId).success && identity(card.data.id) !== identity(cardId))
    throw new ToolError('invalid-response');
  return card;
};

// card/api/get.ts appends a synthetic `__ungrouped__` checklist for legacy items
// with no checklist_id; it has no row, so it is never a scope match.
const realChecklists = (card: Card) =>
  card.includes.checklists.filter((row) => row.id !== '__ungrouped__');

// Python _checklist_view: {checklist, items, card}.
function checklistView(card: Card, id: string) {
  const checklist = findRow(card.includes.checklists, 'id', id);
  return {
    checklist: fields(checklist, relationFields.checklists ?? new Set()) as Row,
    card_id: card.data.id,
  };
}

// Python _item_view: {item, card}.
const itemView = (card: Card, id: string) => ({
  item: fields(
    findRow(children(card, 'checklistItems'), 'id', id),
    relationFields.checklistItems ?? new Set()
  ) as Row,
  card_id: card.data.id,
});

export function registerChecklistTools(server: McpServer, token: string): void {
  const write = async (method: string, path: string, body: unknown) =>
    (await request({ method, path, body, token, schema: written })).data;

  server.registerTool(
    'set_checklist_items',
    {
      description:
        'Update 1–100 unique checklist items in order. Stops after the first request error; no retry or rollback. Request outcomes and final observations are independent.',
      inputSchema: {
        cardId: z.string().min(1),
        items: z
          .array(
            z
              .strictObject({
                itemId,
                checked: z.boolean().optional(),
                title: z.string().min(1).optional(),
              })
              .refine((item) => item.checked !== undefined || item.title !== undefined)
          )
          .min(1)
          .max(100)
          .refine(
            (items) => new Set(items.map((item) => identity(item.itemId))).size === items.length
          ),
      },
    },
    ({ cardId, items }) =>
      runTool(token, async () => {
        const before = await readCard(cardId, token);
        const members = children(before, 'checklistItems');
        const targets = items.map((item) => {
          const row = inParent(members as Array<Row & { id: string }>, item.itemId, 'card');
          return {
            id: row.id,
            item_id: item.itemId,
            desired: {
              ...(item.checked === undefined ? {} : { checked: item.checked }),
              ...(item.title === undefined ? {} : { title: item.title.trim() }),
            },
          };
        });
        type Outcome = {
          item_id: string;
          request_outcome: 'succeeded' | 'failed' | 'unknown' | 'not_attempted';
          error?: { code: string };
        } & (
          | {
              observation: 'unknown';
              verified: false;
              observed?: never;
              verification_error?: never;
            }
          | { observation: 'matches'; verified: true; observed: Row; verification_error?: never }
          | {
              observation: 'mismatch';
              verified: false;
              observed: Row;
              verification_error: { code: string; fields: string[] };
            }
        );
        const outcomes: Outcome[] = targets.map(({ item_id }) => ({
          item_id,
          request_outcome: 'not_attempted',
          observation: 'unknown',
          verified: false,
        }));
        for (const [index, target] of targets.entries()) {
          const outcome = outcomes[index];
          if (!outcome) throw new ToolError('internal');
          try {
            const ack = (
              await request({
                method: 'PATCH',
                path: apiPath`/api/v1/checklist-items/${target.id}`,
                body: target.desired,
                token,
                schema: dataOf(rowWithId),
              })
            ).data;
            if (identity(ack.id) !== identity(target.id))
              throw new ToolError('invalid-response', undefined, 'response');
            outcome.request_outcome = 'succeeded';
          } catch (error) {
            outcome.request_outcome = ambiguous(error) ? 'unknown' : 'failed';
            outcome.error = { code: errorCode(error) };
            break;
          }
        }
        let verificationError: { code: string } | undefined;
        try {
          const after = await readCard(before.data.id, token);
          if (identity(after.data.id) !== identity(before.data.id))
            throw new ToolError('invalid-response');
          const rows = children(after, 'checklistItems');
          for (const [index, target] of targets.entries()) {
            const outcome = outcomes[index];
            if (!outcome) throw new ToolError('internal');
            if (outcome.request_outcome === 'not_attempted') continue;
            const row = rows.find(
              (row) => typeof row.id === 'string' && identity(row.id) === identity(target.id)
            );
            const mismatched = Object.entries(target.desired)
              .filter(([key, value]) => !row || !(key in row) || !equal(key, row[key], value))
              .map(([key]) => key);
            const observed = Object.fromEntries(
              Object.keys(target.desired)
                .filter((key) => row && key in row)
                .map((key) => [key, row?.[key]])
            );
            const receipt = {
              item_id: outcome.item_id,
              request_outcome: outcome.request_outcome,
              ...(outcome.error ? { error: outcome.error } : {}),
            };
            outcomes[index] = mismatched.length
              ? {
                  ...receipt,
                  observation: 'mismatch',
                  verified: false,
                  observed,
                  verification_error: { code: 'readback-mismatch', fields: mismatched },
                }
              : { ...receipt, observation: 'matches', verified: true, observed };
          }
        } catch (error) {
          verificationError = { code: errorCode(error) };
        }
        const complete = outcomes.every(
          (item) => item.request_outcome === 'succeeded' && item.observation === 'matches'
        );
        return {
          card_id: before.data.id,
          items: outcomes,
          complete,
          partial: !complete,
          ...(verificationError ? { readback_error: verificationError } : {}),
        };
      })
  );

  // There is no GET route for a checklist or item, so the card is the scope
  // check before the delete (not-in-card, no DELETE sent) and the read-back after.
  const deleteFromCard = async (
    cardId: string,
    id: string,
    rows: (card: Card) => Array<{ id: string }>,
    path: (id: string) => string
  ) => {
    const card = await readCard(cardId, token);
    const target = inParent(rows(card), id, 'card');
    await deleteNoContent(path(target.id), token);
    if (rows(await readCard(card.data.id, token)).some((row) => row.id === target.id))
      throw new ToolError('delete-failed');
    return { deleted: true, verified: true, id: target.id, card_id: card.data.id };
  };

  server.registerTool(
    'create_checklist',
    {
      description:
        'Create a checklist on a card. Returns a compact creation receipt with request_outcome and verified; ' +
        'successful read-back adds the selected checklist and card_id, not items or a full card. ' +
        'An unknown request_outcome or failed verification does not prove no write occurred; never automatically retry.',
      inputSchema: {
        cardId: z.string().min(1).describe('ID of the card'),
        title: z.string().min(1).describe('Checklist title'),
      },
    },
    (args) =>
      runTool(token, async () => {
        return acknowledgedCreate(
          () =>
            request({
              method: 'POST',
              path: apiPath`/api/v1/cards/${args.cardId}/checklists`,
              body: { title: args.title },
              token,
              schema: z.unknown(),
            }),
          async (ack) => {
            const card = await readCard(args.cardId, token);
            children(card, 'checklists');
            const view = checklistView(card, String(ack.id));
            return { row: view.checklist, extra: view, selected: true };
          },
          { title: args.title.trim() || 'Checklist' }
        );
      })
  );

  server.registerTool(
    'add_checklist_item',
    {
      description:
        'Add an item to a checklist. Returns a compact creation receipt with request_outcome and verified; ' +
        'successful read-back adds the selected item and card_id, not a full card. ' +
        'An unknown request_outcome or failed verification does not prove no write occurred; never automatically retry.',
      inputSchema: { checklistId, title: z.string().min(1).describe('Item text') },
    },
    (args) =>
      runTool(token, async () => {
        return acknowledgedCreate(
          () =>
            request({
              method: 'POST',
              path: apiPath`/api/v1/checklists/${args.checklistId}/items`,
              body: { title: args.title },
              token,
              schema: z.unknown(),
            }),
          async (ack) => {
            if (typeof ack.card_id !== 'string' || !ack.card_id)
              throw new ToolError('invalid-response');
            const view = itemView(await readCard(ack.card_id, token), String(ack.id));
            if (
              typeof view.item.checklist_id !== 'string' ||
              identity(view.item.checklist_id) !== identity(args.checklistId)
            )
              throw new ToolError('scope-mismatch');
            return { row: view.item, extra: view, selected: true };
          },
          { title: args.title.trim() }
        );
      })
  );

  server.registerTool(
    'set_checklist_item',
    {
      description:
        'Check/uncheck or rename a checklist item. Give checked, title or both. Returns a compact receipt ' +
        'with id, verified, verified_fields, observed, the selected item and card_id, not a full card.',
      inputSchema: {
        itemId,
        checked: z.boolean().optional().describe('true to tick, false to untick'),
        title: z.string().min(1).optional().describe('New item text'),
      },
    },
    ({ itemId: id, checked, title }) =>
      runTool(token, async () => {
        // [why] Python's schema anyOf(checked, title); a zod raw shape cannot express it.
        if (checked === undefined && title === undefined) throw new ToolError('nothing-to-update');
        const updated = await write('PATCH', apiPath`/api/v1/checklist-items/${id}`, {
          checked,
          title,
        });
        if (identity(updated.id) !== identity(id))
          throw new ToolError('invalid-response', undefined, 'response');
        const view = itemView(await readCard(updated.card_id, token), id);
        const desired = {
          ...(checked === undefined ? {} : { checked }),
          ...(title === undefined ? {} : { title: title.trim() }),
        };
        return { ...verified(view.item, desired), ...view, observed: {} };
      })
  );

  server.registerTool(
    'rename_checklist',
    {
      description:
        'Rename a checklist. Returns a compact receipt with id, verified, verified_fields, observed, ' +
        'the selected checklist and card_id, not items or a full card.',
      inputSchema: { checklistId, title: z.string().min(1).describe('New title') },
    },
    (args) =>
      runTool(token, async () => {
        const updated = await write('PATCH', apiPath`/api/v1/checklists/${args.checklistId}`, {
          title: args.title,
        });
        if (identity(updated.id) !== identity(args.checklistId))
          throw new ToolError('invalid-response', undefined, 'response');
        const view = checklistView(await readCard(updated.card_id, token), args.checklistId);
        return { ...verified(view.checklist, { title: args.title.trim() }), ...view, observed: {} };
      })
  );

  server.registerTool(
    'delete_checklist',
    {
      description:
        'Delete a checklist and all its items. It must be on cardId (not-in-card otherwise).',
      inputSchema: {
        cardId: z.string().min(1).describe('ID of the card the checklist is on'),
        checklistId,
      },
      annotations: destructive,
    },
    (args) =>
      runTool(token, () =>
        deleteFromCard(
          args.cardId,
          args.checklistId,
          realChecklists,
          (id) => apiPath`/api/v1/checklists/${id}`
        )
      )
  );

  server.registerTool(
    'delete_checklist_item',
    {
      description: 'Delete one checklist item. It must be on cardId (not-in-card otherwise).',
      inputSchema: { cardId: z.string().min(1).describe('ID of the card the item is on'), itemId },
      annotations: destructive,
    },
    (args) =>
      runTool(token, () =>
        deleteFromCard(
          args.cardId,
          args.itemId,
          (card) => card.includes.checklistItems,
          (id) => apiPath`/api/v1/checklist-items/${id}`
        )
      )
  );
}
