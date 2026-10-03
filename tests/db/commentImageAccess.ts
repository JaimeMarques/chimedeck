// Real PostgreSQL regression for attachment proxy access. Disposable database only.
import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';

const databaseUrl = Bun.env.DATABASE_URL;
assert.equal(Bun.env.CHIMEDECK_TEST_SANDBOX, '1');
assert.ok(databaseUrl);
const url = new URL(databaseUrl);
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
assert.match(decodeURIComponent(url.pathname.slice(1)), /(?:^|[_-])(test|sandbox)(?:$|[_-])/i);

const { db } = await import('../../server/common/db');
const { handleViewAttachment } = await import('../../server/extensions/attachment/api/view');
const { handleThumbnailAttachment } = await import('../../server/extensions/attachment/api/thumbnail');
const ids = {
  owner: randomUUID(), member: randomUUID(), outsider: randomUUID(),
  workspace: randomUUID(), board: randomUUID(), list: randomUUID(), card: randomUUID(),
  comment: randomUUID(), draft: randomUUID(), published: randomUUID(),
};
const people = ['owner', 'member', 'outsider'] as const;
const tokens = Object.fromEntries(people.map((name) => [name, `hf_${randomUUID()}`])) as Record<(typeof people)[number], string>;
const short = () => randomUUID().slice(0, 8);
const call = async (name: 'owner' | 'member' | 'outsider', id: string, thumbnail = false) => {
  const path = `/api/v1/attachments/${id}/${thumbnail ? 'thumbnail' : 'view'}`;
  const req = new Request(`http://localhost${path}`, {
    headers: { Authorization: `Bearer ${tokens[name]}` },
  });
  return thumbnail ? handleThumbnailAttachment(req, id) : handleViewAttachment(req, id);
};

try {
  await db('users').insert(people.map((name) => ({
    id: ids[name], email: `${ids[name]}@example.test`, name, email_verified: true,
  })));
  await db('workspaces').insert({ id: ids.workspace, name: `image-access-${short()}`, owner_id: ids.owner });
  await db('memberships').insert(people.map((name) => ({
    workspace_id: ids.workspace, user_id: ids[name], role: name === 'owner' ? 'OWNER' : 'MEMBER',
  })));
  await db('boards').insert({ id: ids.board, workspace_id: ids.workspace, title: 'Private', visibility: 'PRIVATE', short_id: short() });
  await db('board_members').insert({ id: randomUUID(), board_id: ids.board, user_id: ids.member, role: 'MEMBER' });
  await db('lists').insert({ id: ids.list, board_id: ids.board, title: 'Inbox', short_id: short(), position: 'a0' });
  await db('cards').insert({ id: ids.card, list_id: ids.list, title: 'Private comment', short_id: short(), position: 'a0', archived: false });
  await db('comments').insert({ id: ids.comment, card_id: ids.card, user_id: ids.owner, content: 'Published image' });
  await db('attachments').insert([
    { id: ids.draft, card_id: ids.card, uploaded_by: ids.owner, name: 'draft.png', type: 'FILE', status: 'PENDING',
      upload_context: 'comment', comment_id: null, thumbnail_key: 'test/draft-thumb' },
    { id: ids.published, card_id: ids.card, uploaded_by: ids.owner, name: 'published.png', type: 'FILE', status: 'PENDING',
      upload_context: 'comment', comment_id: ids.comment, thumbnail_key: 'test/published-thumb' },
  ]);
  await db('api_tokens').insert(people.map((name) => ({
    id: randomUUID(), user_id: ids[name], name: 'Disposable attachment access test',
    token_hash: createHash('sha256').update(tokens[name]).digest('hex'), token_prefix: tokens[name].slice(0, 10),
  })));
  for (const thumbnail of [false, true]) {
    assert.equal((await call('owner', ids.draft, thumbnail)).status, 202, 'draft uploader can retrieve status');
    assert.equal((await call('member', ids.draft, thumbnail)).status, 403, 'other board member cannot read unpublished draft');
    assert.equal((await call('outsider', ids.draft, thumbnail)).status, 403, 'private-board outsider cannot read draft');
    assert.equal((await call('member', ids.published, thumbnail)).status, 202, 'board member can read posted image status');
    assert.equal((await call('outsider', ids.published, thumbnail)).status, 403, 'private-board outsider cannot read posted image');
    console.info(`PASS ${thumbnail ? 'thumbnail' : 'view'} enforces draft ownership and private-board access`);
  }
} finally {
  try {
    await db('api_tokens').whereIn('user_id', [ids.owner, ids.member, ids.outsider]).delete();
    await db('boards').where({ id: ids.board }).delete();
    await db('memberships').where({ workspace_id: ids.workspace }).delete();
    await db('workspaces').where({ id: ids.workspace }).delete();
    await db('users').whereIn('id', [ids.owner, ids.member, ids.outsider]).delete();
  } finally { await db.destroy(); }
}
