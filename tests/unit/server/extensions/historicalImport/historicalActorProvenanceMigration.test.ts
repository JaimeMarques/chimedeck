import { describe, expect, it } from 'bun:test';

const migration = Bun.file(
  new URL(
    '../../../../../db/migrations/0121_historical_import_actor_provenance.ts',
    import.meta.url
  ).pathname
);

describe('historical import actor provenance migration', () => {
  it('stores source and mapped actor ids without foreign keys and makes both immutable', async () => {
    const source = await migration.text();

    expect(source).toContain("string('historical_source_actor_id')");
    expect(source).toContain("string('historical_target_actor_id')");
    expect(source).toContain(
      'BEFORE UPDATE OF historical_source_actor_id, historical_target_actor_id'
    );
    expect(source).toContain('historical actor provenance is immutable');
    expect(source).not.toMatch(/historical_(?:source|target)_actor_id[\s\S]{0,160}references\(/);
  });
});
