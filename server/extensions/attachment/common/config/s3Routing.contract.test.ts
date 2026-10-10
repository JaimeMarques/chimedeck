import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../../../../');
const directOperations = [
  'server/extensions/attachment/api/multipart/start.ts',
  'server/extensions/attachment/workers/thumbnail.ts',
  'server/extensions/board/mods/chat/assist/searchCards.ts',
  'server/extensions/board/mods/chat/assist/readAttachments.ts',
  'server/extensions/cardChat/mods/assist/readAttachments.ts',
];

describe('self-hosted S3 routing integration contract', () => {
  for (const path of directOperations) {
    test(`${path} keeps direct object operations on the internal client`, async () => {
      const source = await Bun.file(resolve(root, path)).text();
      expect(source).toContain('s3ServerClient.send(');
      expect(source).not.toContain('s3Client.send(');
    });
  }
  test('browser upload signatures still use the public client', async () => {
    for (const path of [
      'server/extensions/attachment/mods/s3/presignPut.ts',
      'server/extensions/attachment/api/multipart/partUrl.ts',
    ]) {
      const source = await Bun.file(resolve(root, path)).text();
      expect(source).toContain('getSignedUrl(s3Client,');
    }
  });
});
