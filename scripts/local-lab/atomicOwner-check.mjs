import { test, mock } from 'node:test';
// Node's filesystem fault-injection API is intentionally exercised by the explicit Node gate.
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicPrivateJson } from './resetCheckpoint.mjs';

test('ownership publication keeps complete old or new authority through injected faults', async () => {
  const state = await mkdtemp(resolve(tmpdir(), 'chimedeck-owner-'));
  const path = resolve(state, 'identity.json');
  const before = { project: 'owned', marker: 'same-binding', revision: 'old' };
  const after = { ...before, revision: 'new' };
  try {
    await writeFile(path, JSON.stringify(before), { mode: 0o600 });
    mock.method(fs, 'renameSync', () => {
      throw new Error('injected pre-publication failure');
    });
    syncBuiltinESMExports();
    assert.throws(() => atomicPrivateJson(state, 'identity.json', after), /pre-publication/);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), before);
    mock.restoreAll();
    syncBuiltinESMExports();
    const sync = fs.fsyncSync;
    let calls = 0;
    mock.method(fs, 'fsyncSync', (fd) => {
      if (++calls === 2) throw new Error('injected post-publication failure');
      return sync(fd);
    });
    syncBuiltinESMExports();
    assert.throws(() => atomicPrivateJson(state, 'identity.json', after), /post-publication/);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), after);
    mock.restoreAll();
    syncBuiltinESMExports();
    atomicPrivateJson(state, 'identity.json', before);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), before);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    await rm(state, { recursive: true, force: true });
  }
});
test('only explicit application-stamp publication discards a failed new receipt', async () => {
  const state = await mkdtemp(resolve(tmpdir(), 'chimedeck-stamp-'));
  try {
    const sync = fs.fsyncSync;
    let calls = 0;
    mock.method(fs, 'fsyncSync', (fd) => {
      if (++calls === 2) throw new Error('injected stamp failure');
      return sync(fd);
    });
    syncBuiltinESMExports();
    assert.throws(
      () => atomicPrivateJson(state, 'app-start.json', { revision: 'new' }, false, true),
      /stamp failure/
    );
    await assert.rejects(readFile(resolve(state, 'app-start.json')));
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    await rm(state, { recursive: true, force: true });
  }
});
