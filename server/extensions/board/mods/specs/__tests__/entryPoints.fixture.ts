// Spawned in a separate process: dependency doubles cannot leak into other tests.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSpecsFileDeps, readSpecsFileTool } from '../../chat/assist/readSpecsFile';
import { handlePutSpecsFile, specsFileWriteDeps } from '../../../api/github/specs/file';
import { handleReadSpecsFile, specsReadDeps } from '../../../api/specs/read';

const sandbox = await mkdtemp(join(tmpdir(), 'chimedeck-specs-entrypoints-'));
const repoPath = join(sandbox, 'repo');
const outside = join(sandbox, 'outside');
const secret = 'DISPOSABLE SECRET — Olá 🌍';
const board = {
  id: 'board',
  workspace_id: 'workspace',
  title: 'board',
  state: 'ACTIVE',
  github_project_url: 'https://github.com/example/repo',
};
try {
  await mkdir(join(repoPath, 'specs'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(repoPath, 'README.md'), secret);
  await writeFile(join(outside, 'sentinel.md'), secret);
  await symlink(outside, join(repoPath, 'specs', 'link'));
  const download = () => Promise.resolve({ repoPath, ref: 'main', fetchedAt: 'now' });
  readSpecsFileDeps.downloadRepositoryFromProjectUrl = download;
  specsFileWriteDeps.downloadRepositoryFromProjectUrl = download;
  specsFileWriteDeps.authenticate = () => Promise.resolve(null);
  specsFileWriteDeps.requireBoardAccess = (request) => {
    request.board = { ...board, state: 'ACTIVE', created_at: new Date() };
    return Promise.resolve(null);
  };
  specsFileWriteDeps.requireWorkspaceMembership = (request) => {
    request.callerRole = 'MEMBER';
    return Promise.resolve(null);
  };
  specsFileWriteDeps.requireRole = () => null;
  specsReadDeps.authenticate = specsFileWriteDeps.authenticate;
  specsReadDeps.requireBoardAccess = specsFileWriteDeps.requireBoardAccess;
  specsReadDeps.requireWorkspaceMembership = specsFileWriteDeps.requireWorkspaceMembership;
  specsReadDeps.requireRole = specsFileWriteDeps.requireRole;
  specsReadDeps.downloadRepositoryFromProjectUrl = download;
  specsFileWriteDeps.invalidateSpecsCachesForBoard = () => undefined;
  for (const path of ['specs/../README.md', 'specs/link/sentinel.md', '/specs/valid.md']) {
    const result = await readSpecsFileTool({
      board,
      toolCall: {
        id: 'read',
        type: 'function',
        function: { name: 'read_specs_file', arguments: JSON.stringify({ path }) },
      },
      model: 'test',
    });
    assert.equal(result.status, 422, `AI rejected ${path}`);
    const response = await handlePutSpecsFile(
      new Request('http://localhost/specs', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-match': '*' },
        body: JSON.stringify({ path, content: 'ATTACK' }),
      }),
      'board'
    );
    assert.equal(response.status, 400, `GitHub PUT rejected ${path}`);
    const readResponse = await handleReadSpecsFile(
      new Request(`http://localhost/specs?path=${encodeURIComponent(path)}`),
      'board'
    );
    assert.equal(readResponse.status, 400, `GET rejected ${path}`);
    assert.equal(await readFile(join(repoPath, 'README.md'), 'utf8'), secret);
    assert.equal(await readFile(join(outside, 'sentinel.md'), 'utf8'), secret);
  }
  // Positive entrypoint path: nested Unicode file created, then read by AI/GET.
  const validPath = 'specs/área/Guia 🌍.md';
  const content = '# Normal spec — Olá 🌍';
  const saved = await handlePutSpecsFile(
    new Request('http://localhost/specs', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: validPath, content }),
    }),
    'board'
  );
  assert.equal(saved.status, 201);
  const read = await readSpecsFileTool({
    board,
    toolCall: {
      id: 'read',
      type: 'function',
      function: { name: 'read_specs_file', arguments: JSON.stringify({ path: validPath }) },
    },
    model: 'test',
  });
  assert.equal(read.status, 200);
  assert.ok(read.data?.message?.includes(content));
  // Expire the earlier empty manifest without changing any global clock.
  specsReadDeps.now = () => new Date('2100-01-01T00:00:00Z');
  const get = await handleReadSpecsFile(
    new Request(`http://localhost/specs?path=${encodeURIComponent(validPath)}`),
    'board'
  );
  assert.equal(get.status, 200);
  assert.equal(((await get.json()) as { data: { content: string } }).data.content, content);
  // Missing symlink-root paths fail before any filesystem I/O too.
  await rm(join(repoPath, 'specs'), { recursive: true });
  await symlink(outside, join(repoPath, 'specs'));
  const result = await readSpecsFileTool({
    board,
    toolCall: {
      id: 'read',
      type: 'function',
      function: {
        name: 'read_specs_file',
        arguments: JSON.stringify({ path: 'specs/sentinel.md' }),
      },
    },
    model: 'test',
  });
  assert.equal(result.status, 422);
  const rootRead = await handleReadSpecsFile(
    new Request('http://localhost/specs?path=specs%2Fsentinel.md'),
    'board'
  );
  assert.equal(rootRead.status, 400);
  console.info('PASS real AI read, GET and GitHub PUT scope/symlink boundaries');
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
