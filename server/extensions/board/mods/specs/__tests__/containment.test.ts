import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
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

describe('real Git specs commit selection', () => {
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8' }).trim();
  const commit = (changedFiles: string[]) =>
    commitSpecsChanges({
      repoPath,
      branch: 'main',
      changedFiles,
      message: 'Selected specs update',
      actorId: 'actor',
      boardId: 'board',
      botAlias: 'specs-test',
    });
  function initialize() {
    git('init', '--quiet');
    git('config', 'user.name', 'specs-test');
    git('config', 'user.email', 'specs-test@example.invalid');
    git('add', '--', 'README.md');
    git('commit', '--quiet', '-m', 'baseline');
  }

  it('rejects a .md directory before staging any selected files or descendants', async () => {
    initialize();
    const head = git('rev-parse', 'HEAD');
    await mkdir(join(repoPath, 'specs', 'bundle.md'));
    await writeFile(join(repoPath, 'specs', 'bundle.md', 'outside-type.txt'), 'NOT MARKDOWN');
    await symlink(join(outside, 'sentinel.md'), join(repoPath, 'specs', 'bundle.md', 'linked.md'));
    await writeFile(join(repoPath, 'specs', 'safe.md'), 'VALID');
    await assert.rejects(
      commit(['specs/safe.md', 'specs/bundle.md']),
      /specs-file-must-be-regular/
    );
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(git('diff', '--cached', '--name-only')).toBe('');
    expect(await readFile(join(outside, 'sentinel.md'), 'utf8')).toBe(secret);
  });

  it('commits only selected Markdown while preserving unrelated index entries and staged hunks', async () => {
    initialize();
    await writeFile(join(repoPath, 'obsolete.txt'), 'DELETE LATER');
    await writeFile(join(repoPath, 'specs', 'other.md'), 'OTHER BASELINE');
    git('add', '--', 'obsolete.txt', 'specs/other.md');
    git('commit', '--quiet', '-m', 'unrelated baseline');
    await writeFile(join(repoPath, 'README.md'), 'STAGED README');
    await writeFile(join(repoPath, 'extra.txt'), 'STAGED ADDITION');
    await writeFile(join(repoPath, 'specs', 'other.md'), 'STAGED OTHER SPEC');
    git('add', '--', 'README.md', 'extra.txt', 'specs/other.md');
    git('rm', '--quiet', '--', 'obsolete.txt');
    await writeFile(join(repoPath, 'README.md'), 'UNSTAGED README');
    await writeFile(join(repoPath, 'specs', 'other.md'), 'UNSTAGED OTHER SPEC');
    const cachedDiff = git('diff', '--cached', '--binary');
    const unstagedDiff = git('diff', '--binary');
    const indexEntries = git('ls-files', '--stage');
    await writeFile(join(repoPath, 'specs', 'safe.md'), 'SELECTED CONTENT');
    const result = await commit(['specs/./safe.md', 'specs/safe.md']);
    expect(result.changedFiles).toEqual(['specs/safe.md']);
    expect(git('show', '--format=', '--name-only', result.commitHash)).toBe('specs/safe.md');
    expect(git('show', 'HEAD:specs/safe.md')).toBe('SELECTED CONTENT');
    expect(git('diff', '--cached', '--binary')).toBe(cachedDiff);
    expect(git('diff', '--binary')).toBe(unstagedDiff);
    expect(
      git('ls-files', '--stage')
        .split('\n')
        .filter((line) => !line.endsWith('\tspecs/safe.md'))
        .join('\n')
    ).toBe(indexEntries);
    expect(await readFile(join(repoPath, 'README.md'), 'utf8')).toBe('UNSTAGED README');
    expect(await readFile(join(repoPath, 'specs', 'other.md'), 'utf8')).toBe('UNSTAGED OTHER SPEC');
    expect(result.pushStatus).toBe('pending');
    expect(git('show', '-s', '--format=%B', 'HEAD')).toContain('Changed-Files: specs/safe.md');
  });

  it('treats wildcard and bracket filenames as literal selections rather than Git pathspecs', async () => {
    initialize();
    const selected = ['specs/guide*.md', 'specs/guide[ab].md'];
    const unselected = ['specs/guide-other.md', 'specs/guidea.md'];
    for (const file of [...selected, ...unselected]) await writeFile(join(repoPath, file), file);
    const result = await commit(selected);
    expect(result.changedFiles).toEqual(selected);
    expect(
      git('diff-tree', '--no-commit-id', '--name-only', '-r', '-z', result.commitHash)
        .split('\0')
        .filter(Boolean)
        .sort()
    ).toEqual(selected);
    expect(
      git('ls-files', '-z')
        .split('\0')
        .filter((file) => file.startsWith('specs/'))
        .sort()
    ).toEqual(selected);
    for (const file of unselected) expect(await readFile(join(repoPath, file), 'utf8')).toBe(file);
  });

  it('rejects missing untracked leaves and deleted non-regular HEAD entries before staging', async () => {
    initialize();
    await mkdir(join(repoPath, 'specs', 'former-directory.md'));
    await writeFile(join(repoPath, 'specs', 'former-directory.md', 'child.md'), 'CHILD');
    await symlink(join(outside, 'sentinel.md'), join(repoPath, 'specs', 'former-link.md'));
    git('add', '--', 'specs/former-directory.md', 'specs/former-link.md');
    git('commit', '--quiet', '-m', 'non-regular baseline');
    git('rm', '--quiet', '-r', '--', 'specs/former-directory.md', 'specs/former-link.md');
    await mkdir(join(repoPath, 'specs'), { recursive: true });
    const head = git('rev-parse', 'HEAD');
    const index = git('ls-files', '--stage');
    await writeFile(join(repoPath, 'specs', 'safe.md'), 'SELECTED');
    for (const file of ['specs/missing*.md', 'specs/former-directory.md', 'specs/former-link.md']) {
      await assert.rejects(commit(['specs/safe.md', file]), /specs-file-not-found/);
      expect(git('rev-parse', 'HEAD')).toBe(head);
      expect(git('ls-files', '--stage')).toBe(index);
    }
  });

  it('does not commit unrelated staged changes when the selected Markdown has no changes', async () => {
    initialize();
    await writeFile(join(repoPath, 'specs', 'unchanged.md'), 'UNCHANGED');
    git('add', '--', 'specs/unchanged.md');
    git('commit', '--quiet', '-m', 'unchanged Markdown baseline');
    await writeFile(join(repoPath, 'README.md'), 'STAGED ONLY');
    git('add', '--', 'README.md');
    await writeFile(join(repoPath, 'README.md'), 'UNSTAGED ALSO');
    const head = git('rev-parse', 'HEAD');
    const index = git('ls-files', '--stage');
    const cachedDiff = git('diff', '--cached', '--binary');
    const unstagedDiff = git('diff', '--binary');
    await assert.rejects(commit(['specs/unchanged.md']), /no-specs-changes/);
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(git('ls-files', '--stage')).toBe(index);
    expect(git('diff', '--cached', '--binary')).toBe(cachedDiff);
    expect(git('diff', '--binary')).toBe(unstagedDiff);
    expect(await readFile(join(repoPath, 'README.md'), 'utf8')).toBe('UNSTAGED ALSO');
  });

  for (const staged of [false, true]) {
    it(`commits ${staged ? 'already staged' : 'unstaged'} regular Markdown deletions literally`, async () => {
      initialize();
      const selected: [string, string] = ['specs/gone*.md', 'specs/gone[ab].md'];
      const retained = 'specs/gonea.md';
      for (const file of [...selected, retained]) await writeFile(join(repoPath, file), 'BASELINE');
      await chmod(join(repoPath, selected[1]), 0o755);
      git('--literal-pathspecs', 'add', '--', ...selected, retained);
      git('commit', '--quiet', '-m', 'tracked Markdown baseline');
      for (const file of selected) {
        if (staged) git('--literal-pathspecs', 'rm', '--quiet', '--', file);
        else await unlink(join(repoPath, file));
      }
      await writeFile(join(repoPath, 'README.md'), 'UNRELATED STAGED');
      git('add', '--', 'README.md');
      const readmeIndex = git('ls-files', '--stage', '--', 'README.md');
      const result = await commit(selected);
      expect(
        git('diff-tree', '--no-commit-id', '--name-status', '-r', '-z', result.commitHash)
      ).toBe(`D\0${selected[0]}\0D\0${selected[1]}\0`);
      expect(git('ls-files', '--stage', '--', 'README.md')).toBe(readmeIndex);
      expect(git('diff', '--cached', '--name-only')).toBe('README.md');
      expect(git('ls-tree', '-r', '--name-only', 'HEAD', '--', 'specs')).toBe(retained);
      expect(await readFile(join(repoPath, retained), 'utf8')).toBe('BASELINE');
    });
  }
});

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
