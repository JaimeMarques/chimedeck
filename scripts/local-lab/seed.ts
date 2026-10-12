import Knex from 'knex';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateApiToken } from '../../server/extensions/apiToken/mods/generate';
import { demoCards } from './demoFixtures';

const url = new URL(Bun.env.DATABASE_URL ?? '');
const marker = Bun.env.LAB_MARKER;
const state = Bun.env.LAB_STATE;
if (
  url.hostname !== '127.0.0.1' ||
  url.port !== '35432' ||
  url.pathname !== '/chimedeck_lab' ||
  url.username !== 'chimedeck_lab' ||
  !marker ||
  !state
)
  throw new Error('Refusing non-lab seed');
const db = Knex({ client: 'pg', connection: url.toString() });
if (existsSync(resolve(state, 'credentials.json')))
  throw new Error('Refusing to replace existing lab credentials');
try {
  const identity = await db<{ marker: string }>('local_lab_identity').first();
  if (identity?.marker !== marker) throw new Error('Database ownership marker mismatch');
  if ((await db('users').count('* as count').first())?.count !== '0')
    throw new Error('Seed requires an empty synthetic lab; use guarded reset');
  const password = `Lab-${randomUUID()}`;
  const hash = await Bun.password.hash(password, { algorithm: 'bcrypt', cost: 12 });
  const users = ['admin', 'member', 'restricted', 'raceTarget'].map((role) => ({
    id: randomUUID(),
    name: `Lab ${role}`,
    email: `${role}@example.test`,
    password_hash: hash,
    email_verified: true,
  }));
  const workspaceId = randomUUID(),
    boardId = randomUUID(),
    listId = randomUUID(),
    cardId = randomUUID(),
    checklistId = randomUUID();
  const admin = users[0];
  if (!admin) throw new Error('Missing synthetic admin');
  const seededCards = demoCards.map((fixture, index) => ({
    ...fixture,
    id: index === 0 ? cardId : randomUUID(),
  }));
  const credentials: Record<string, unknown> = {
    marker,
    password,
    workspaceId,
    boardId,
    listId,
    cardId,
    checklistId,
    demoCards: seededCards,
    apiUrl: 'http://127.0.0.1:33000',
    frontendUrl: 'http://127.0.0.1:35173',
  };
  await db.transaction(async (trx) => {
    await trx('users').insert(users);
    await trx('workspaces').insert({
      id: workspaceId,
      name: 'Synthetic MCP lab',
      owner_id: admin.id,
    });
    await trx('memberships').insert(
      users.map((user, index) => ({
        user_id: user.id,
        workspace_id: workspaceId,
        role: index === 0 ? 'OWNER' : index === 2 ? 'GUEST' : 'MEMBER',
      }))
    );
    await trx('boards').insert({
      id: boardId,
      workspace_id: workspaceId,
      title: 'Synthetic parity fixtures',
      visibility: 'PRIVATE',
      short_id: 'labboard',
    });
    await trx('board_members').insert(
      users.slice(0, 2).map((user, index) => ({
        id: randomUUID(),
        board_id: boardId,
        user_id: user.id,
        role: index ? 'MEMBER' : 'ADMIN',
      }))
    );
    await trx('lists').insert({ id: listId, board_id: boardId, title: 'Lab Todo', position: 'a' });
    await trx('cards').insert(
      seededCards.map((fixture, index) => ({
        id: fixture.id,
        list_id: listId,
        title: fixture.title,
        description: fixture.description,
        position: String.fromCharCode(97 + index),
        short_id: fixture.shortId,
        created_by: admin.id,
        due_date: fixture.dueDate ?? null,
        amount: fixture.amount ?? null,
        currency: fixture.currency ?? null,
      }))
    );
    const labelId = randomUUID();
    await trx('labels').insert({
      id: labelId,
      board_id: boardId,
      name: 'Synthetic demo',
      color: '#2563EB',
    });
    await trx('card_labels').insert(
      seededCards.slice(1, 4).map((fixture) => ({ card_id: fixture.id, label_id: labelId }))
    );
    await trx('checklists').insert({
      id: checklistId,
      card_id: cardId,
      title: 'Lab checklist',
      position: 'a',
    });
    await trx('checklist_items').insert(
      [0, 1, 2].map((index) => ({
        id: randomUUID(),
        card_id: cardId,
        checklist_id: checklistId,
        title: `Item ${String(index)}`,
        checked: false,
        position: String(index),
      }))
    );
    for (const [index, user] of users.entries()) {
      const token = await generateApiToken();
      await trx('api_tokens').insert({
        id: randomUUID(),
        user_id: user.id,
        name: 'local-lab',
        token_hash: token.hash,
        token_prefix: token.prefix,
      });
      const role = ['admin', 'member', 'restricted', 'raceTarget'][index];
      if (!role) throw new Error('Unexpected fixture role');
      credentials[role] = {
        id: user.id,
        email: user.email,
        token: token.raw,
      };
    }
  });
  await writeFile(resolve(state, 'credentials.json'), JSON.stringify(credentials), {
    mode: 0o600,
    flag: 'wx',
  });
} finally {
  await db.destroy();
}
