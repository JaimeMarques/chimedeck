import { expect, test } from 'bun:test';
import { join } from 'node:path';

for (const scenario of [
  'single-comment', 'single-card', 'multipart-comment', 'multipart-card',
  'single-wrong-user', 'multipart-wrong-user', 'non-image', 'denied',
  'association-ready', 'association-wrong-card', 'association-wrong-user',
  'association-stolen', 'association-card-upload', 'association-pending', 'association-scanning',
  'association-offline-replay', 'association-absolute', 'association-external', 'cleanup-drafts', 'cleanup-s3-failure',
  'association-canonical', 'association-pdf', 'association-missing-raw', 'association-missing-old-id', 'association-missing-new-id',
  'delete-success', 'delete-rollback',
  'association-cross-card-link', 'association-claimed-rejected', 'association-rejected-new',
]) {
  test(`comment images boundary: ${scenario}`, () => {
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, 'images.fixture.ts'), scenario]);
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
  });
}
