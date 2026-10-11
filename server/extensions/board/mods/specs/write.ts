import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { readSpecsHandle } from './read';
import { isMissing, withFileParent } from './filesystem';
import { normalizeSpecsFilePath, resolveSpecsFilePath } from './resolvePath';

export interface WriteSpecsFileInput {
  repoPath: string;
  filePath: string;
  content: string;
  ifMatch?: string | null;
}

export interface WriteSpecsFileResult {
  path: string;
  absolutePath: string;
  etag: string;
  sha: string;
  sizeBytes: number;
  created: boolean;
}

function normalizeEntityTag(value: string): string {
  return value.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
}

function parseIfMatchHeader(value: string | null | undefined): Set<string> | null {
  if (!value) return null;
  const tokens = value
    .split(',')
    .map((token) => normalizeEntityTag(token))
    .filter((token) => token.length > 0);
  return new Set(tokens);
}

function computeSha(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 32);
}

export async function writeSpecsFile({
  repoPath,
  filePath,
  content,
  ifMatch,
}: WriteSpecsFileInput): Promise<WriteSpecsFileResult> {
  const resolved = resolveSpecsFilePath({ repoPath, filePath });
  if (!resolved.ok) {
    throw new Error(resolved.reason);
  }

  const relativePath = normalizeSpecsFilePath(filePath);

  const buffer = Buffer.from(content, 'utf8');
  const created = await withFileParent(resolved.absolutePath, true, async (target) => {
    let handle;
    let created = false;
    try {
      handle = await open(target, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (!isMissing(error)) throw error;
      handle = await open(
        target,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o666
      );
      created = true;
    }
    try {
      if (!created) {
        const current = await readSpecsHandle(handle);
        const matches = parseIfMatchHeader(ifMatch);
        if (!matches) throw new Error('missing-specs-file-precondition');
        if (!matches.has('*') && !matches.has(current.etag))
          throw new Error('stale-specs-file-precondition');
      }
      await handle.truncate(0);
      await handle.writeFile(buffer);
      return created;
    } finally {
      await handle.close();
    }
  });

  const sha = computeSha(buffer);
  return {
    path: relativePath,
    absolutePath: resolved.absolutePath,
    etag: sha,
    sha,
    sizeBytes: buffer.length,
    created,
  };
}
