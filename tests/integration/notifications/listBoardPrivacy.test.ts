import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import knex from 'knex';

// The query uses a Knex PostgreSQL builder; its portable SELECT is run against
// in-memory SQLite so these assertions exercise the actual joins and projections.
Bun.env.DATABASE_URL ??= 'postgres://localhost/chimedeck_test';
const { buildNotificationListQuery } = await import('../../../server/extensions/notifications/api/list');

function rowsForCard({ notificationBoardId, cardBoardId, sourceType = 'card_description' }: {
  notificationBoardId: string | null;
  cardBoardId: string;
  sourceType?: 'card_description' | 'comment';
}) {
  const sqlite = new Database(':memory:');
  const builder = knex({ client: 'pg' });
  try {
    sqlite.exec(`
      CREATE TABLE notifications (id TEXT, type TEXT, source_type TEXT, source_id TEXT, card_id TEXT, emoji TEXT, board_id TEXT, user_id TEXT, actor_id TEXT, read INTEGER, created_at TEXT);
      CREATE TABLE users (id TEXT, nickname TEXT, name TEXT, email TEXT, avatar_url TEXT);
      CREATE TABLE boards (id TEXT, title TEXT);
      CREATE TABLE lists (id TEXT, board_id TEXT, title TEXT);
      CREATE TABLE cards (id TEXT, list_id TEXT, title TEXT, description TEXT);
      CREATE TABLE comments (id TEXT, content TEXT, parent_id TEXT);
      CREATE TABLE activities (id TEXT, payload TEXT);
      INSERT INTO boards VALUES ('source', 'Source board'), ('destination', 'Destination board');
      INSERT INTO lists VALUES ('source-list', 'source', 'Source list'), ('destination-list', 'destination', 'Private destination list');
      INSERT INTO users VALUES ('recipient', NULL, 'Recipient', 'recipient@example.test', NULL), ('actor', NULL, 'Actor', 'actor@example.test', NULL);
      INSERT INTO cards VALUES ('card', '${cardBoardId}-list', 'Private updated title', 'Private updated description');
      INSERT INTO comments VALUES ('comment', 'Private edited comment', NULL);
    `);
    sqlite.query(`INSERT INTO notifications VALUES (?, 'mention', ?, ?, 'card', NULL, ?, 'recipient', 'actor', 0, '2026-01-01')`)
      .run('notification', sourceType, sourceType === 'comment' ? 'comment' : 'card', notificationBoardId);
    const { sql, bindings } = buildNotificationListQuery(builder, 'recipient', 20).toSQL();
    return sqlite.query(sql).all(...bindings) as Array<Record<string, unknown>>;
  } finally {
    sqlite.close();
    void builder.destroy();
  }
}

describe('notification list board privacy', () => {
  it('does not show current card content or private destination list after a cross-board move', () => {
    const [row] = rowsForCard({ notificationBoardId: 'source', cardBoardId: 'destination' });
    expect(row.id).toBe('notification');
    expect(row.board_title).toBe('Source board');
    expect(row.card_title).toBeNull();
    expect(row.card_description_content).toBeNull();
    expect(row.list_title).toBeNull();
  });

  it('keeps current card and list information for notifications on the same board', () => {
    const [row] = rowsForCard({ notificationBoardId: 'destination', cardBoardId: 'destination' });
    expect(row.card_title).toBe('Private updated title');
    expect(row.card_description_content).toBe('Private updated description');
    expect(row.list_title).toBe('Private destination list');
  });

  it('keeps current card and list information for global notifications', () => {
    const [row] = rowsForCard({ notificationBoardId: null, cardBoardId: 'destination' });
    expect(row.card_title).toBe('Private updated title');
    expect(row.card_description_content).toBe('Private updated description');
    expect(row.list_title).toBe('Private destination list');
  });

  it('does not show subsequently edited comments on cards moved to another board', () => {
    const [row] = rowsForCard({ notificationBoardId: 'source', cardBoardId: 'destination', sourceType: 'comment' });
    expect(row.comment_content).toBeNull();
    expect(row.source_comment_id).toBeNull();
    expect(row.source_comment_parent_id).toBeNull();
  });

  it('keeps comments for notifications on the current board', () => {
    const [row] = rowsForCard({ notificationBoardId: 'destination', cardBoardId: 'destination', sourceType: 'comment' });
    expect(row.comment_content).toBe('Private edited comment');
  });
});
