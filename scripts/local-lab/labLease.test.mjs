import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { acquireLease } from './labLease.mjs';

test('per-state lease fails fast while held and releases without killing owners', async () => {
  const state = await mkdtemp(resolve(tmpdir(), 'chimedeck-lease-'));
  const binding = { state, project: 'synthetic', marker: 'owned' };
  try {
    const release = await acquireLease(state, binding);
    await assert.rejects(acquireLease(state, binding), /busy/);
    await release();
    const releaseAgain = await acquireLease(state, binding);
    await releaseAgain();
    await assert.rejects(readFile(resolve(state, 'lifecycle-lease.json')));
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});
test('only bound gone-PID journal ownership can be recovered', async () => {
  const state = await mkdtemp(resolve(tmpdir(), 'chimedeck-lease-recovery-'));
  const binding = { state, project: 'synthetic', marker: 'owned' };
  const record = resolve(state, 'lifecycle-lease.json');
  const nonce = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  try {
    for (const owner of [
      { binding, pid: process.pid, nonce },
      { binding: { ...binding, marker: 'foreign' }, pid: 2147483647, nonce },
      { binding, pid: -1, nonce },
    ]) {
      const text = JSON.stringify(owner);
      await writeFile(record, text, { mode: 0o600 });
      await assert.rejects(acquireLease(state, binding));
      assert.equal(await readFile(record, 'utf8'), text);
    }
    await writeFile(record, JSON.stringify({ binding, pid: 2147483647, nonce }), { mode: 0o600 });
    const release = await acquireLease(state, binding);
    assert.equal(JSON.parse(await readFile(record, 'utf8')).pid, process.pid);
    await release();
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});
