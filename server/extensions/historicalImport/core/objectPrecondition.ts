import { GetObjectCommand } from '@aws-sdk/client-s3';
import { s3Client } from '../../attachment/common/config/s3';
import { sha256Hex, type StagedPayload } from './payload';

export interface AttachmentObjectPrecondition {
  bucket: string;
  key: string;
  byte_count: number;
  sha256: string;
}

export interface AttachmentObjectReader {
  read(bucket: string, key: string): Promise<Uint8Array>;
}

const s3Reader: AttachmentObjectReader = {
  async read(bucket, key) {
    const response = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
      abortSignal: AbortSignal.timeout(30_000),
    });
    if (!response.Body) throw new Error('attachment object response has no body');
    return response.Body.transformToByteArray();
  },
};

function validPrecondition(value: unknown): value is AttachmentObjectPrecondition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.bucket === 'string' &&
    p.bucket.length > 0 &&
    typeof p.key === 'string' &&
    p.key.length > 0 &&
    Number.isSafeInteger(p.byte_count) &&
    Number(p.byte_count) >= 0 &&
    typeof p.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(p.sha256)
  );
}

export async function verifyAttachmentObjectPrecondition(
  payload: StagedPayload,
  reader: AttachmentObjectReader = s3Reader
): Promise<AttachmentObjectPrecondition> {
  const precondition = payload.object_precondition;
  if (!validPrecondition(precondition)) {
    throw new Error('FILE attachment requires object_precondition {bucket,key,byte_count,sha256}');
  }
  const fields = payload.fields;
  if (
    fields.s3_bucket !== precondition.bucket ||
    fields.s3_key !== precondition.key ||
    fields.size_bytes !== precondition.byte_count
  ) {
    throw new Error('attachment object precondition disagrees with staged row fields');
  }
  const bytes = await reader.read(precondition.bucket, precondition.key);
  if (bytes.byteLength !== precondition.byte_count) {
    throw new Error(
      `attachment object byte count mismatch: expected ${precondition.byte_count}, found ${bytes.byteLength}`
    );
  }
  const actual = sha256Hex(bytes);
  if (actual !== precondition.sha256) {
    throw new Error(
      `attachment object sha256 mismatch: expected ${precondition.sha256.slice(0, 12)}, found ${actual.slice(0, 12)}`
    );
  }
  return precondition;
}
