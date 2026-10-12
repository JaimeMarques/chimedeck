import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { dependencyDigest } from './labGuards.mjs';

const source = dirname(fileURLToPath(import.meta.url));
const revision = 'a'.repeat(40);
async function fixture(options) {
  const directory = await mkdtemp(resolve(tmpdir(), 'chimedeck-controller-'));
  const socket = createServer();
  const endpoint = `unix://${resolve(directory, 'fixture.sock')}`;
  await new Promise((accept, reject) => {
    socket.once('error', reject);
    socket.listen(endpoint.slice('unix://'.length), accept);
  });
  const checkout = resolve(directory, 'checkout'),
    state = resolve(directory, 'state'),
    bin = resolve(directory, 'bin'),
    home = resolve(directory, 'home');
  for (const path of [
    resolve(checkout, 'scripts/local-lab'),
    resolve(checkout, 'node_modules'),
    state,
    bin,
    resolve(home, '.docker'),
  ])
    await mkdir(path, { recursive: true, mode: 0o700 });
  for (const name of ['control.mjs', 'labGuards.mjs'])
    await cp(resolve(source, name), resolve(checkout, 'scripts/local-lab', name));
  await writeFile(resolve(checkout, 'package.json'), '{}');
  await writeFile(resolve(checkout, 'bun.lock'), 'synthetic-lock');
  await writeFile(resolve(home, '.docker/config.json'), '{"currentContext":"remote-fixture"}');
  const config = {
    revision,
    status: options.status ?? '',
    collision: options.collision,
    rename: options.rename,
    log: resolve(directory, 'docker-calls.jsonl'),
  };
  await writeFile(resolve(bin, 'fixture.json'), JSON.stringify(config));
  const common = `const fs=require('node:fs'),path=require('node:path');const config=JSON.parse(fs.readFileSync(path.join(__dirname,'fixture.json'),'utf8'));const args=process.argv.slice(2);`;
  await writeFile(
    resolve(bin, 'git'),
    `#!/usr/bin/env node\n${common}\nprocess.stdout.write(args[0]==='status'?config.status:args[0]==='diff'&&config.rename?(args.includes('--no-renames')?'db/migrations/moved.ts\\n':'')+'server/extensions/mcp/moved.ts\\n':config.revision+'\\n');`,
    { mode: 0o700 }
  );
  await writeFile(
    resolve(bin, 'docker'),
    `#!/usr/bin/env node\n${common}\nfs.appendFileSync(config.log,JSON.stringify(args)+'\\n');if(args[0]!=='--host'||!args[1].startsWith('unix:///'))process.exit(80);const a=args.slice(2);if(a[0]==='info'){process.stdout.write('fixture-daemon\\n');process.exit(0);}if(a.includes('inspect')){process.stdout.write(JSON.stringify({Name:config.collision,Labels:{}}));process.exit(0);}if(!a.includes('--filter')&&((a[0]==='volume'&&config.collision?.endsWith('_s3'))||(a[0]==='network'&&config.collision?.endsWith('_default'))||(a[0]==='ps'&&config.collision?.endsWith('-postgres-1')))){process.stdout.write(config.collision+'\\n');process.exit(0);}if(a[0]==='ps'||a.includes('ls'))process.exit(0);process.stderr.write('unexpected mutation');process.exit(81);`,
    { mode: 0o700 }
  );
  await writeFile(
    resolve(state, 'identity.json'),
    JSON.stringify({
      project: 'chimedeck-compact-lab',
      checkout,
      revision,
      marker: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      database: 'chimedeck_lab',
      docker_host: endpoint,
      docker_id: 'fixture-daemon',
      dependency_digest: dependencyDigest(checkout),
      allow_mcp_dev: options.persistedMcp ?? false,
    }),
    { mode: 0o600 }
  );
  await writeFile(
    resolve(state, 'environment.json'),
    JSON.stringify({
      LAB_CHECKOUT: checkout,
      LAB_DB_PASSWORD: 'a'.repeat(48),
      LAB_JWT_PRIVATE_KEY: 'synthetic',
      LAB_JWT_PUBLIC_KEY: 'synthetic',
    }),
    { mode: 0o600 }
  );
  if (options.envFile) await writeFile(resolve(checkout, options.envFile), 'SYNTHETIC=true');
  const identityBefore = await readFile(resolve(state, 'identity.json'), 'utf8');
  const result = spawnSync(
    process.execPath,
    [
      resolve(checkout, 'scripts/local-lab/control.mjs'),
      options.command ?? 'start',
      state,
      revision,
    ],
    {
      cwd: checkout,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: home,
        ...(options.endpoint ? { LAB_DOCKER_HOST: options.endpoint } : {}),
        ...(options.allowMcp !== undefined ? { LAB_ALLOW_MCP_DEV: options.allowMcp } : {}),
      },
      encoding: 'utf8',
    }
  );
  let calls = [];
  try {
    calls = (await readFile(config.log, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    /* Refusals before Docker correctly have no recorder. */
  }
  return { directory, checkout, home, state, endpoint, socket, identityBefore, result, calls };
}
const mutations = ['up', 'down', 'run', 'rm', 'create', 'start', 'stop'];
async function refuse(options, message, beforeDocker = false) {
  const value = await fixture(options);
  try {
    assert.notEqual(value.result.status, 0);
    assert.ok(value.result.stderr.includes(message), 'Expected specific guard refusal');
    assert.ok(
      value.calls.every((args) => !args.some((arg) => mutations.includes(arg))),
      'Guard must precede every mutation'
    );
    assert.ok(
      value.calls.every((args) => args[0] === '--host' && args[1] === value.endpoint),
      'Every Docker command pins the verified local endpoint'
    );
    if (beforeDocker) assert.equal(value.calls.length, 0);
    assert.equal(
      await readFile(resolve(value.state, 'identity.json'), 'utf8'),
      value.identityBefore,
      'Refusal must not rewrite recorded ownership or permissions'
    );
    assert.equal(
      await readFile(resolve(value.home, '.docker/config.json'), 'utf8'),
      '{"currentContext":"remote-fixture"}'
    );
  } finally {
    await new Promise((accept) => value.socket.close(accept));
    await rm(value.directory, { recursive: true, force: true });
  }
}
test('controller rejects dotenv variants before Docker or application mutation', async () => {
  for (const envFile of ['.env.local', '.env.development.local', '.env.production'])
    await refuse({ envFile }, 'Loader environment file', true);
});
test('controller refuses remote endpoint before Docker invocation', async () => {
  for (const endpoint of ['tcp://remote.invalid:2375', 'ssh://remote.invalid'])
    await refuse({ endpoint }, 'local Unix Docker endpoint', true);
});
test('controller inspects foreign exact names despite absent project labels; saved remote context is unchanged', async () => {
  for (const collision of [
    'chimedeck-compact-lab_s3',
    'chimedeck-compact-lab_default',
    'chimedeck-compact-lab-postgres-1',
  ])
    await refuse({ collision }, 'Foreign or unmarked');
});
test('controller rejects dirty protected working/index/untracked files before Docker mutation', async () => {
  for (const status of [
    ' M package.json\0',
    'M  bun.lock\0',
    '?? db/migrations/new.ts\0',
    ' M server/config/env.ts\0',
    ' M vite.config.ts\0',
  ])
    await refuse({ status }, 'Protected source/index/untracked', true);
});
test('MCP development permission is per-run even with a legacy sticky identity', async () => {
  for (const allowMcp of [undefined, '0'])
    await refuse(
      { status: ' M server/extensions/mcp/tools/example.ts\0', persistedMcp: true, allowMcp },
      'Protected source/index/untracked',
      true
    );
  await refuse(
    {
      status: ' M server/extensions/mcp/tools/example.ts\0',
      persistedMcp: true,
      allowMcp: '1',
      collision: 'chimedeck-compact-lab_s3',
    },
    'Foreign or unmarked'
  );
});
test('pin rejects protected source renamed into an allowed directory before mutation', async () => {
  await refuse({ command: 'pin', rename: true }, 'Pin only supports committed');
});
