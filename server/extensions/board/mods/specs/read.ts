// Read through a no-follow descriptor; size and bytes come from the same file.
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { SpecsFileResult } from '../../types';
import { withFileParent } from './filesystem';

export const MAX_FILE_SIZE_BYTES = 1 * 1024 * 1024;

export async function readSpecsHandle(handle: FileHandle): Promise<SpecsFileResult> {
  const info = await handle.stat();
  if (!info.isFile()) throw new Error('specs-file-must-be-markdown');
  if (info.size > MAX_FILE_SIZE_BYTES) throw new Error('specs-file-too-large');
  // Bound actual bytes as well: a concurrently growing file cannot bypass stat.
  const buffer = Buffer.alloc(MAX_FILE_SIZE_BYTES + 1);
  let length = 0;
  while (length < buffer.length) {
    const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  if (length > MAX_FILE_SIZE_BYTES) throw new Error('specs-file-too-large');
  const bytes = buffer.subarray(0, length);
  return {
    content: bytes.toString('utf8'),
    etag: createHash('sha256').update(bytes).digest('hex').slice(0, 32),
    sizeBytes: length,
  };
}

export async function readSpecsFile({
  absolutePath,
}: {
  absolutePath: string;
}): Promise<SpecsFileResult> {
  return withFileParent(absolutePath, false, async (filePath) => {
    const handle = await open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      return await readSpecsHandle(handle);
    } finally {
      await handle.close();
    }
  });
}
