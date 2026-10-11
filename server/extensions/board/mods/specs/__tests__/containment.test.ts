import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { spawnSync, execFileSync } from 'node:child_process';
import { commitSpecsChanges } from '../commit';
import { withDirectory } from '../filesystem';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteSpecsFile } from '../delete';
import { listSpecsFiles } from '../list';
import { buildSpecsManifest } from '../manifest';
import { readSpecsFile } from '../read';
import { resolveSpecsFilePath } from '../resolvePath';
import { writeSpecsFile } from '../write';

let sandbox: string;
let repoPath: string;
let outside: string;
const secret = 'OWN DISPOSABLE SECRET — Olá 🌍';

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'chimedeck-specs-containment-'));
  repoPath = join(sandbox, 'repo');
  outside = join(sandbox, 'outside');
  await mkdir(join(repoPath, 'specs'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, 'sentinel.md'), secret);
  await writeFile(join(repoPath, 'README.md'), secret);
});
afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

async function assertDenied(filePath: string) {
  expect(resolveSpecsFilePath({ repoPath, filePath }).ok).toBe(false);
  await assert.rejects(readSpecsFile({ absolutePath: join(repoPath, filePath) }), Error);
  await assert.rejects(
    writeSpecsFile({ repoPath, filePath, content: 'ATTACK', ifMatch: '*' }),
    Error
  );
  await assert.rejects(deleteSpecsFile({ repoPath, filePath }), Error);
  expect(await readFile(join(outside, 'sentinel.md'), 'utf8')).toBe(secret);
  expect(await readFile(join(repoPath, 'README.md'), 'utf8')).toBe(secret);
}

describe('real filesystem specs containment', () => {
  it('rejects normalized and symlinked commit paths before staging in real Git', async () => {
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        [
          '-C',
          repoPath,
          '-c',
          'user.name=specs-test',
          '-c',
          'user.email=specs-test@example.invalid',
          ...args,
        ],
        { encoding: 'utf8' }
      ).trim();
    git('init', '--quiet');
    git('add', 'README.md');
    git('commit', '--quiet', '-m', 'sentinel baseline');
    const head = git('rev-parse', 'HEAD');
    await writeFile(join(repoPath, 'README.md'), 'ROOT CHANGE');
    const commit = (changedFiles: string[]) =>
      commitSpecsChanges({
        repoPath,
        branch: 'main',
        changedFiles,
        message: 'test',
        actorId: 'actor',
        boardId: 'board',
        botAlias: 'specs-test',
      });
    await assert.rejects(commit(['specs/../README.md']), /path-traversal-detected/);
    await symlink(join(outside, 'sentinel.md'), join(repoPath, 'specs', 'linked.md'));
    await assert.rejects(commit(['specs/linked.md']), /path-traversal-detected/);
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(git('diff', '--cached', '--name-only')).toBe('');
    expect(await readFile(join(outside, 'sentinel.md'), 'utf8')).toBe(secret);
    await writeSpecsFile({ repoPath, filePath: 'specs/nested/valid.md', content: 'valid' });
    const result = await commit(['specs/nested/./valid.md']);
    expect(result.changedFiles).toEqual(['specs/nested/valid.md']);
    expect(result.pushStatus).toBe('pending');
    expect(git('show', '--format=', '--name-only', result.commitHash)).toBe(
      'specs/nested/valid.md'
    );
  });
  it('round-trips nested Unicode filenames through a canonical checkout alias', async () => {
    const alias = join(sandbox, 'alias');
    await symlink(repoPath, alias);
    const filePath = 'specs/área/nested/../nested/Guia 🌍.md';
    const saved = await writeSpecsFile({ repoPath: alias, filePath, content: secret });
    expect(saved.path).toBe('specs/área/nested/Guia 🌍.md');
    expect(saved.created).toBe(true);
    expect(saved.sizeBytes).toBe(Buffer.byteLength(secret));
    const resolved = resolveSpecsFilePath({ repoPath: alias, filePath: saved.path });
    assert.ok(resolved.ok);
    expect((await readSpecsFile({ absolutePath: resolved.absolutePath })).content).toBe(secret);
    expect(await listSpecsFiles({ repoPath: alias })).toEqual([
      { path: saved.path, sizeBytes: Buffer.byteLength(secret) },
    ]);
    await assert.rejects(
      writeSpecsFile({ repoPath: alias, filePath, content: 'wrong' }),
      /missing-specs-file-precondition/
    );
    await assert.rejects(
      writeSpecsFile({ repoPath: alias, filePath, content: 'wrong', ifMatch: 'stale' }),
      /stale-specs-file-precondition/
    );
    const updated = await writeSpecsFile({
      repoPath: alias,
      filePath,
      content: 'Olá',
      ifMatch: saved.etag,
    });
    expect(updated.created).toBe(false);
    expect((await readSpecsFile({ absolutePath: resolved.absolutePath })).content).toBe('Olá');
    expect((await deleteSpecsFile({ repoPath: alias, filePath })).deleted).toBe(true);
    expect((await deleteSpecsFile({ repoPath: alias, filePath })).deleted).toBe(false);
    expect(await listSpecsFiles({ repoPath: alias })).toEqual([]);
  });

  it('rejects cross-platform/encoded escapes without reinterpreting filenames', () => {
    for (const filePath of [
      'specs/../../outside/sentinel.md',
      'specs/../specs-sibling/file.md',
      'specs/../README.md',
      'specs\\\\..\\\\README.md',
      'C:/specs/file.md',
      'C:specs/file.md',
      '//host/specs/file.md',
      '/specs/file.md',
      'specs/%2e%2e/README.md',
      'specs/%252e%252e/%2fREADME.md',
      'specs/file%00.md',
      'SPECS/file.md',
      'specs/file.MD',
      'specs/file.txt',
      'specs/file\0.md',
    ]) {
      expect(resolveSpecsFilePath({ repoPath, filePath }).ok).toBe(false);
    }
  });

  it('exercises the actual AI and GitHub PUT entrypoints in isolation', () => {
    const result = spawnSync(
      process.execPath,
      [new URL('./entryPoints.fixture.ts', import.meta.url).pathname],
      {
        env: {
          ...process.env,
          DATABASE_URL: 'postgres://unused@127.0.0.1:1/unused',
          MULTI_INSTANCE_HANDLING_ENABLED: 'false',
        },
        encoding: 'utf8',
        timeout: 30000,
      }
    );
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 0,
      stdout: 'PASS real AI read, GET and GitHub PUT scope/symlink boundaries\n',
      stderr: '',
    });
  });

  for (const ancestor of ['specs', 'repo'] as const) {
    it.skipIf(process.platform !== 'linux')(
      `pins inode identity when ${ancestor} is swapped after opening`,
      async () => {
        await writeFile(join(repoPath, 'specs', 'sentinel.md'), 'INSIDE');
        await withDirectory(join(repoPath, 'specs'), false, async (pinned) => {
          const original = ancestor === 'repo' ? repoPath : join(repoPath, 'specs');
          await rename(original, join(sandbox, 'held-original'));
          await symlink(outside, original);
          expect(await readFile(join(pinned, 'sentinel.md'), 'utf8')).toBe('INSIDE');
          await writeFile(join(pinned, 'sentinel.md'), 'PINNED WRITE');
          await mkdir(join(pinned, 'created'));
          await writeFile(join(pinned, 'created', 'new.md'), 'PINNED CREATE');
          await unlink(join(pinned, 'sentinel.md'));
          expect(await readFile(join(outside, 'sentinel.md'), 'utf8')).toBe(secret);
          await assert.rejects(readFile(join(outside, 'created', 'new.md')), /ENOENT/);
        });
      }
    );
  }
  it('rejects normalized specs traversal even within the repository', async () => {
    await assertDenied('specs/../README.md');
  });

  it('rejects a symlinked specs root for every file operation', async () => {
    await rm(join(repoPath, 'specs'), { recursive: true });
    await symlink(outside, join(repoPath, 'specs'));
    await assertDenied('specs/sentinel.md');
  });

  it('rejects listing a symlinked specs root', async () => {
    await rm(join(repoPath, 'specs'), { recursive: true });
    await symlink(outside, join(repoPath, 'specs'));
    await assert.rejects(listSpecsFiles({ repoPath }), Error);
  });

  it('limits the manifest to specs and never lists a symlinked root', async () => {
    await writeFile(join(repoPath, 'specs', 'guide.md'), 'Olá 🌍');
    expect((await buildSpecsManifest({ repoPath, ref: 'main', fetchedAt: 'now' })).files).toEqual([
      { path: 'specs/guide.md', sizeBytes: Buffer.byteLength('Olá 🌍') },
    ]);
    await rm(join(repoPath, 'specs'), { recursive: true });
    await symlink(outside, join(repoPath, 'specs'));
    await assert.rejects(buildSpecsManifest({ repoPath, ref: 'main', fetchedAt: 'now' }), Error);
  });

  it('rejects final-component and dangling symlinks', async () => {
    await symlink(join(outside, 'sentinel.md'), join(repoPath, 'specs', 'sentinel.md'));
    await assertDenied('specs/sentinel.md');
    await symlink(join(outside, 'absent.md'), join(repoPath, 'specs', 'dangling.md'));
    await assert.rejects(
      writeSpecsFile({ repoPath, filePath: 'specs/dangling.md', content: 'ATTACK' }),
      Error
    );
    expect(await listSpecsFiles({ repoPath })).toEqual([]);
  });
  for (const operation of ['resolve', 'read', 'write', 'delete', 'create'] as const) {
    it(`rejects symlinked parent: ${operation}`, async () => {
      await symlink(outside, join(repoPath, 'specs', 'link'));
      const filePath = 'specs/link/sentinel.md';
      if (operation === 'resolve')
        expect(resolveSpecsFilePath({ repoPath, filePath }).ok).toBe(false);
      if (operation === 'read')
        await assert.rejects(readSpecsFile({ absolutePath: join(repoPath, filePath) }), Error);
      if (operation === 'write')
        await assert.rejects(
          writeSpecsFile({ repoPath, filePath, content: 'ATTACK', ifMatch: '*' }),
          Error
        );
      if (operation === 'delete')
        await assert.rejects(deleteSpecsFile({ repoPath, filePath }), Error);
      if (operation === 'create')
        await assert.rejects(
          writeSpecsFile({ repoPath, filePath: 'specs/link/new/deep.md', content: 'ATTACK' }),
          Error
        );
      expect(await readFile(join(outside, 'sentinel.md'), 'utf8')).toBe(secret);
    });
  }
});
