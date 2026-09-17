import { describe, expect, it } from 'bun:test';

const migration = Bun.file(
  new URL(
    '../../../../../db/migrations/0120_historical_import_source_references.ts',
    import.meta.url
  ).pathname
);

describe('historical import detached source reference migration', () => {
  it('stores JSON arrays without live FKs and makes the evidence immutable', async () => {
    const source = await migration.text();

    expect(source).toContain("jsonb('source_references')");
    expect(source).toContain("jsonb_typeof(source_references) = 'array'");
    expect(source).toContain('BEFORE UPDATE OF source_references');
    expect(source).toContain('detached historical source references are immutable');
    expect(source).not.toMatch(/source_references[\s\S]{0,180}references\(/);
  });
});
