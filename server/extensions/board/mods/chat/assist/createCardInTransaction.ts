import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import type { CreateCardInput, createCard } from '../../../../card/mods/create';
import { between, HIGH_SENTINEL } from '../../../../list/mods/fractional';
import { sanitizeText, sanitizeRichText } from '../../../../../common/sanitize';
import { generateShortId } from '../../../../../common/ids/shortId';

// The shared createCard service owns its connection and cannot participate in
// the authorization transaction. Keep this AI-only insert on the locked trx;
// use the same sanitation, ordering, short-ID, attribution and cover contract.
export async function createCardInTransaction(
  input: CreateCardInput,
  trx: Knex.Transaction
): Promise<Awaited<ReturnType<typeof createCard>>> {
  const lastCard = await trx('cards')
    .where({ list_id: input.listId, archived: false })
    .orderBy('position', 'desc')
    .first<{ position: string } | undefined>();
  let shortId: string | undefined;
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = generateShortId();
    if (!(await trx('cards').where({ short_id: candidate }).first())) {
      shortId = candidate;
      break;
    }
  }
  if (!shortId) throw new Error('failed-to-generate-unique-short-id:cards');
  const [card] = (await trx('cards')
    .insert({
      id: randomUUID(),
      short_id: shortId,
      list_id: input.listId,
      title: sanitizeText(input.title.trim()),
      description: input.description ? sanitizeRichText(input.description.trim()) : null,
      position: between(lastCard?.position ?? '', HIGH_SENTINEL),
      archived: false,
      start_date: input.startDate ?? null,
      created_by: input.createdBy ?? null,
    })
    .returning('*')) as Array<Awaited<ReturnType<typeof createCard>>>;
  if (!card) throw new Error('card-insert-returned-no-row');
  // Newly inserted cards have no cover attachment.
  return { ...card, cover_image_url: null, cover_aspect_ratio: null, cover_is_gif: false };
}
