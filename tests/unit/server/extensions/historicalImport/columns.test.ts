// tests/unit/server/extensions/historicalImport/columns.test.ts
// Staged-timestamp projection: a historical created_at/updated_at declared by a
// staged payload may only reach a row whose destination table really has that
// column. No DB here — the column probe is injected, so the contract is pinned
// without a destination database.
import { describe, expect, it } from 'bun:test';
import type { Knex } from 'knex';
import {
  HISTORICAL_TIMESTAMP_FIELDS,
  applyHistoricalTimestamps,
  createCachedColumnProbe,
  projectHistoricalTimestamps,
  queryTableColumns,
} from '../../../../../server/extensions/historicalImport/core/columns';

// The three destination classes this contract must distinguish, as they exist
// in the migrations: neither column (lists/checklist_items/labels), created_at
// only (boards/activities/...), or both (cards/comments/attachments/checklists).
const LISTS = new Set(['id', 'board_id', 'title', 'position', 'archived', 'short_id']);
const CARDS = new Set([
  'id',
  'list_id',
  'title',
  'description',
  'position',
  'archived',
  'created_at',
  'updated_at',
]);
const ACTIVITIES = new Set([
  'id',
  'entity_type',
  'entity_id',
  'board_id',
  'action',
  'actor_id',
  'payload',
  'created_at',
]);

interface FakeQueryLog {
  tables: string[];
  wheres: Array<Record<string, unknown>>;
  selects: string[][];
}

function fakeTrx(rows: Array<Record<string, unknown>>): {
  trx: Knex.Transaction;
  log: FakeQueryLog;
} {
  const log: FakeQueryLog = { tables: [], wheres: [], selects: [] };
  const builder = {
    where(clause: Record<string, unknown>) {
      log.wheres.push(clause);
      return builder;
    },
    select(...columns: string[]) {
      log.selects.push(columns);
      return Promise.resolve(rows);
    },
  };
  const trx = (table: string) => {
    log.tables.push(table);
    return builder;
  };
  return { trx: trx as unknown as Knex.Transaction, log };
}

describe('queryTableColumns (live schema, fail-closed)', () => {
  it('returns the real column names of the requested table', async () => {
    const { trx, log } = fakeTrx([{ column_name: 'id' }, { column_name: 'created_at' }]);
    const columns = await queryTableColumns(trx, 'lists');
    expect([...columns].sort()).toEqual(['created_at', 'id']);
    expect(log.tables).toEqual(['information_schema.columns']);
    expect(log.wheres[0]).toMatchObject({ table_name: 'lists' });
  });

  it('throws instead of reporting "no columns" when the table is not visible', async () => {
    // An empty result means the lookup itself failed (unknown table, wrong
    // schema/search_path). Treating it as "column absent" would silently drop
    // historical timestamps, so it must fail closed.
    const { trx } = fakeTrx([]);
    await expect(queryTableColumns(trx, 'lists')).rejects.toThrow(
      /column metadata unavailable for table .*lists/
    );
  });
});

describe('createCachedColumnProbe', () => {
  it('probes each table once and reuses the result', async () => {
    let calls = 0;
    const probe = createCachedColumnProbe(async (_trx, table) => {
      calls += 1;
      return table === 'lists' ? LISTS : CARDS;
    });
    const trx = {} as Knex.Transaction;
    const first = await probe(trx, 'lists');
    const second = await probe(trx, 'lists');
    const other = await probe(trx, 'cards');
    expect(calls).toBe(2);
    expect(first).toBe(second);
    expect(other).toBe(CARDS);
  });

  it('does not memoise a failed lookup', async () => {
    let calls = 0;
    const probe = createCachedColumnProbe(async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return LISTS;
    });
    const trx = {} as Knex.Transaction;
    await expect(probe(trx, 'lists')).rejects.toThrow('boom');
    expect(await probe(trx, 'lists')).toBe(LISTS);
    expect(calls).toBe(2);
  });
});

describe('projectHistoricalTimestamps (pure)', () => {
  it('keeps a declared timestamp when the column exists', () => {
    const row: Record<string, unknown> = { id: 'crd_1' };
    const result = projectHistoricalTimestamps(
      row,
      { created_at: '2021-05-03T10:00:00.000Z', updated_at: '2021-05-04T11:45:00.000Z' },
      CARDS
    );
    expect(row).toEqual({
      id: 'crd_1',
      created_at: '2021-05-03T10:00:00.000Z',
      updated_at: '2021-05-04T11:45:00.000Z',
    });
    expect(result).toEqual({ applied: ['created_at', 'updated_at'], omitted: [] });
  });

  it('drops a declared timestamp whose column does not exist, leaving the row untouched', () => {
    const row: Record<string, unknown> = { id: 'lst_1', title: 'list' };
    const result = projectHistoricalTimestamps(
      row,
      { created_at: '2021-05-01T08:15:00.000Z', updated_at: '2021-05-02T09:30:00.000Z' },
      LISTS
    );
    expect(Object.keys(row)).toEqual(['id', 'title']);
    expect(result).toEqual({ applied: [], omitted: ['created_at', 'updated_at'] });
  });

  it('never projects a homonymous-but-different column', () => {
    // `lists` has neither column: nothing may be invented, renamed or reused
    // (no `created`, no `createdAt`, no overwrite of an existing column).
    const row: Record<string, unknown> = { id: 'lst_1', position: '0001', archived: false };
    projectHistoricalTimestamps(row, { created_at: '2021-05-01T08:15:00.000Z' }, LISTS);
    expect(Object.keys(row).sort()).toEqual(['archived', 'id', 'position']);
    expect(row['position']).toBe('0001');
    expect(row['archived']).toBe(false);
  });

  it('projects created_at but not updated_at when only the first exists', () => {
    const row: Record<string, unknown> = { id: 'act_1' };
    const result = projectHistoricalTimestamps(
      row,
      { created_at: '2021-05-10T17:05:00.000Z', updated_at: '2021-05-10T17:06:00.000Z' },
      ACTIVITIES
    );
    expect(row).toEqual({ id: 'act_1', created_at: '2021-05-10T17:05:00.000Z' });
    expect(result).toEqual({ applied: ['created_at'], omitted: ['updated_at'] });
  });

  it('treats absent, null and empty declarations as undeclared', () => {
    for (const declared of [undefined, null, {}, { created_at: '' }, { created_at: null }]) {
      const row: Record<string, unknown> = { id: 'lst_1' };
      const result = projectHistoricalTimestamps(
        row,
        declared as { created_at?: string },
        LISTS
      );
      expect(result).toEqual({ applied: [], omitted: [] });
      expect(Object.keys(row)).toEqual(['id']);
    }
  });

  it('only ever considers the two historical timestamp fields', () => {
    const row: Record<string, unknown> = { id: 'crd_1' };
    const result = projectHistoricalTimestamps(
      row,
      { created_at: '2021-05-03T10:00:00.000Z', position: 'injected' } as Record<string, unknown>,
      CARDS
    );
    expect(HISTORICAL_TIMESTAMP_FIELDS).toEqual(['created_at', 'updated_at']);
    expect(row['position']).toBeUndefined();
    expect(result.applied).toEqual(['created_at']);
  });
});

describe('applyHistoricalTimestamps (probe-backed)', () => {
  it('queries the destination schema once a timestamp is declared', async () => {
    const probed: string[] = [];
    const probe = async (_trx: Knex.Transaction, table: string) => {
      probed.push(table);
      return CARDS;
    };
    const row: Record<string, unknown> = { id: 'crd_1' };
    const result = await applyHistoricalTimestamps(
      probe,
      {} as Knex.Transaction,
      'cards',
      row,
      { created_at: '2021-05-03T10:00:00.000Z' }
    );
    expect(probed).toEqual(['cards']);
    expect(result).toEqual({ applied: ['created_at'], omitted: [] });
    expect(row['created_at']).toBe('2021-05-03T10:00:00.000Z');
  });

  it('does not query the schema when the payload declares no timestamp', async () => {
    let calls = 0;
    const probe = async () => {
      calls += 1;
      return CARDS;
    };
    const row: Record<string, unknown> = { id: 'lst_1' };
    const result = await applyHistoricalTimestamps(
      probe,
      {} as Knex.Transaction,
      'lists',
      row,
      { fields: {} } as Record<string, unknown>
    );
    expect(calls).toBe(0);
    expect(result).toEqual({ applied: [], omitted: [] });
    expect(Object.keys(row)).toEqual(['id']);
  });

  it('propagates a failed column lookup (never silently drops history)', async () => {
    const probe = async () => {
      throw new Error('column metadata unavailable for table public.lists');
    };
    await expect(
      applyHistoricalTimestamps(probe, {} as Knex.Transaction, 'lists', { id: 'lst_1' }, {
        created_at: '2021-05-01T08:15:00.000Z',
      })
    ).rejects.toThrow(/column metadata unavailable/);
  });
});
