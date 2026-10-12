import { spawn } from 'node:child_process';
import { lstatSync, openSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { atomicPrivateJson } from './resetCheckpoint.mjs';

export async function acquireLease(state, binding) {
  const guard = resolve(state, 'lifecycle.guard');
  const record = resolve(state, 'lifecycle-lease.json');
  const present = (path) => {
    try {
      lstatSync(path);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  };
  if (
    present(guard) &&
    (!lstatSync(guard).isFile() ||
      lstatSync(guard).isSymbolicLink() ||
      (lstatSync(guard).mode & 0o777) !== 0o600 ||
      readFileSync(guard).length)
  )
    throw new Error('Unknown lifecycle guard file');
  closeSync(openSync(guard, 'a', 0o600));
  // The kernel guard serializes journal acquire/recovery/release as well as lifecycle work.
  // EOF releases it if this controller dies; no process is killed for recovery.
  const child = spawn('flock', ['-n', guard, 'sh', '-c', 'printf "ready\\n"; cat >/dev/null'], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const ended = new Promise((accept) => child.once('exit', accept));
  await new Promise((accept, reject) => {
    child.once('error', reject);
    child.stdout.once('data', () => accept());
    child.once('exit', () => reject(new Error('Lab lifecycle lease busy or unavailable')));
  });
  let nonce;
  const read = () => {
    const info = lstatSync(record);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600)
      throw new Error('Unknown lifecycle lease record');
    const value = JSON.parse(readFileSync(record, 'utf8'));
    if (
      JSON.stringify(Object.keys(value).sort()) !==
        JSON.stringify(['binding', 'nonce', 'pid'].sort()) ||
      JSON.stringify(value.binding) !== JSON.stringify(binding) ||
      !Number.isSafeInteger(value.pid) ||
      value.pid < 1 ||
      typeof value.nonce !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(value.nonce)
    )
      throw new Error('Unknown or unbound lifecycle lease owner');
    return value;
  };
  try {
    if (present(record)) {
      const owner = read();
      let gone = false;
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        if (error.code === 'ESRCH') gone = true;
        else throw error;
      }
      if (!gone) throw new Error('Lifecycle owner is live; stale recovery refused');
      unlinkSync(record);
    }
    nonce = randomUUID();
    atomicPrivateJson(state, 'lifecycle-lease.json', { binding, pid: process.pid, nonce }, true);
  } catch (error) {
    child.stdin.end();
    await ended;
    throw error;
  }
  return async () => {
    try {
      const owner = read();
      if (owner.pid !== process.pid || owner.nonce !== nonce)
        throw new Error('Lifecycle owner changed');
      unlinkSync(record);
    } finally {
      child.stdin.end();
      await ended;
    }
  };
}
