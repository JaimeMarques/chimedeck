import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import console from 'node:console';
import { strict as assert } from 'node:assert';
import { localDockerHost, inspectOwnedResources } from './labGuards.mjs';

const [state, revision, endpoint, daemonId, postgresId] = process.argv.slice(2);
if (!state || !revision || !/^[a-f0-9]{64}$/.test(postgresId ?? ''))
  throw new Error('Explicit lab state/revision/validated Postgres ID required');
const identity = JSON.parse(await readFile(resolve(state, 'identity.json'), 'utf8'));
const runtime = JSON.parse(await readFile(resolve(state, 'environment.json'), 'utf8'));
const env = { PATH: process.env.PATH, HOME: process.env.HOME };
const host = localDockerHost(endpoint);
assert.equal(host, identity.docker_host);
assert.equal(daemonId, identity.docker_id);
const docker = (args) => {
  const result = spawnSync('docker', ['--host', host, ...args], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, 'Guard Docker command failed');
  return result.stdout.trim();
};
const validateTarget = () => {
  assert.equal(docker(['info', '--format', '{{.ID}}']), daemonId, 'Guard daemon changed');
  const found = inspectOwnedResources(
    docker,
    identity.project,
    identity.checkout,
    resolve(identity.checkout, 'scripts/local-lab/compose.yml')
  );
  const postgres = found.container.find(
    (container) =>
      container.Id === postgresId && container.Name === '/chimedeck-compact-lab-postgres-1'
  );
  assert.ok(postgres?.Running, 'Guard Postgres snapshot missing/stopped/replaced');
};
const count = () => {
  validateTarget();
  const result = spawnSync(
    'docker',
    [
      '--host',
      host,
      'exec',
      postgresId,
      'psql',
      '-U',
      'chimedeck_lab',
      '-d',
      'chimedeck_lab',
      '-At',
      '-c',
      'SELECT count(*) FROM users',
    ],
    { env, encoding: 'utf8' }
  );
  assert.equal(result.status, 0);
  return result.stdout.trim();
};
const before = count();
const temporary = await mkdtemp(resolve(state, 'guard-fixture-'));
try {
  await writeFile(
    resolve(temporary, 'identity.json'),
    JSON.stringify({ ...identity, marker: 'not-the-owned-database' }),
    { mode: 0o600 }
  );
  await writeFile(resolve(temporary, 'environment.json'), JSON.stringify(runtime), { mode: 0o600 });
  const reset = spawnSync(
    'node',
    ['scripts/local-lab/control.mjs', 'reset', temporary, revision, '--nonstarting-marker-check'],
    {
      env,
      encoding: 'utf8',
    }
  );
  assert.notEqual(reset.status, 0);
  assert.ok(
    reset.stderr.includes('Connected database is not the owned lab') ||
      reset.stderr.includes('Owned Postgres is stopped')
  );
  for (const url of [
    'postgresql://chimedeck_lab:invalid@deck.fyrebird.xyz:5432/chimedeck_lab',
    'postgresql://chimedeck_lab:invalid@127.0.0.1:35432/other_database',
  ]) {
    const seed = spawnSync('bun', ['scripts/local-lab/seed.ts'], {
      env: { ...env, DATABASE_URL: url, LAB_STATE: state, LAB_MARKER: identity.marker },
      encoding: 'utf8',
    });
    assert.notEqual(seed.status, 0);
    assert.ok(seed.stderr.includes('Refusing non-lab seed'));
  }
  assert.equal(count(), before);
  console.info(
    'PASS wrong database marker, production hostname and foreign database refusal; owned data unchanged'
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
