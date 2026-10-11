import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpecsFileResult } from '../../../types';
import { listSpecsFiles } from '../list';
import { MAX_FILE_SIZE_BYTES, readSpecsFile } from '../read';

let repoPath: string;

beforeEach(async () => {
  repoPath = await mkdtemp(join(tmpdir(), 'chimedeck-specs-files-'));
  await mkdir(join(repoPath, 'specs'));
});

afterEach(async () => {
  await rm(repoPath, { recursive: true, force: true });
});

describe('specs file helpers', () => {
  it('lists nested markdown files with byte sizes, ignoring other files', async () => {
    await mkdir(join(repoPath, 'specs', 'nested'), { recursive: true });
    const content = '# Olá 🌍\n';
    await writeFile(join(repoPath, 'specs', 'guide.md'), content);
    await writeFile(join(repoPath, 'specs', 'nested', 'empty.md'), '');
    await writeFile(join(repoPath, 'specs', 'ignored.txt'), 'not markdown');
    await writeFile(join(repoPath, 'outside.md'), 'outside specs');

    const entries = await listSpecsFiles({ repoPath });
    expect(entries.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'specs/guide.md', sizeBytes: Buffer.byteLength(content) },
      { path: 'specs/nested/empty.md', sizeBytes: 0 },
    ]);
  });

  it('returns an empty listing when specs does not exist', async () => {
    expect(await listSpecsFiles({ repoPath })).toEqual([]);
  });

  it('reads UTF-8 content with byte size and a content-derived ETag', async () => {
    const absolutePath = join(repoPath, 'specs', 'guide.md');
    const content = '# Olá 🌍\n';
    await writeFile(absolutePath, content);

    const result: SpecsFileResult = await readSpecsFile({ absolutePath });
    expect(result).toEqual({
      content,
      sizeBytes: Buffer.byteLength(content),
      etag: createHash('sha256').update(content).digest('hex').slice(0, 32),
    });

    await writeFile(absolutePath, '# Changed\n');
    expect((await readSpecsFile({ absolutePath })).etag).not.toBe(result.etag);
  });

  it('accepts the file size limit and rejects files above it', async () => {
    const absolutePath = join(repoPath, 'specs', 'large.md');
    await writeFile(absolutePath, Buffer.alloc(MAX_FILE_SIZE_BYTES, 'x'));
    expect((await readSpecsFile({ absolutePath })).sizeBytes).toBe(MAX_FILE_SIZE_BYTES);

    await writeFile(absolutePath, Buffer.alloc(MAX_FILE_SIZE_BYTES + 1, 'x'));
    const error: unknown = await readSpecsFile({ absolutePath }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : undefined).toBe('specs-file-too-large');
  });

  it('rejects reads of missing files', async () => {
    const error: unknown = await readSpecsFile({
      absolutePath: join(repoPath, 'specs', 'missing.md'),
    }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
  });
});
