import { describe, expect, it } from 'bun:test';
import {
  verifyAttachmentObjectPrecondition,
  type AttachmentObjectReader,
} from '../../../../../server/extensions/historicalImport/core/objectPrecondition';
import { sha256Hex } from '../../../../../server/extensions/historicalImport/core/payload';

const bytes = new TextEncoder().encode('verified attachment bytes');
const reader: AttachmentObjectReader = {
  async read(bucket, key) {
    expect(bucket).toBe('qa-imports');
    expect(key).toBe('imports/trello/file.bin');
    return bytes;
  },
};

const payload = {
  entity_type: 'attachment',
  source_id: 'trello_attachment_1',
  fields: {
    type: 'FILE',
    s3_bucket: 'qa-imports',
    s3_key: 'imports/trello/file.bin',
    size_bytes: bytes.byteLength,
    status: 'READY',
  },
  object_precondition: {
    bucket: 'qa-imports',
    key: 'imports/trello/file.bin',
    byte_count: bytes.byteLength,
    sha256: sha256Hex(bytes),
  },
};

describe('attachment object precondition', () => {
  it('proves bucket, key, byte count and SHA-256 before an attachment insert', async () => {
    await expect(verifyAttachmentObjectPrecondition(payload, reader)).resolves.toMatchObject({
      bucket: 'qa-imports',
      key: 'imports/trello/file.bin',
      byte_count: bytes.byteLength,
      sha256: sha256Hex(bytes),
    });
  });

  it('fails closed on an object SHA-256 mismatch', async () => {
    const changed = structuredClone(payload);
    changed.object_precondition.sha256 = '0'.repeat(64);
    await expect(verifyAttachmentObjectPrecondition(changed, reader)).rejects.toThrow(
      'attachment object sha256 mismatch'
    );
  });
});
