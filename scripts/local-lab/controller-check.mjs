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
function ownedObjects(checkout, options) {
  const project = 'chimedeck-compact-lab';
  const composePath = resolve(checkout, 'scripts/local-lab/compose.yml');
  const network = `${project}_default`;
  const labels = { 'com.docker.compose.project': project };
  const container = ['postgres', 'redis', 'localstack', 'app'].map((service, index) => {
    const ports = ['5432/tcp', '6379/tcp', '4566/tcp', '3000/tcp'];
    const hostPorts = ['35432', '36379', '34566', '33000'];
    const volumes = ['postgres', 'redis', 's3'];
    const destinations = ['/var/lib/postgresql/data', '/data', '/var/lib/localstack'];
    const binding = { [ports[index]]: [{ HostIp: '127.0.0.1', HostPort: hostPorts[index] }] };
    return {
      Id: String(index + 1).repeat(64),
      Name: `/${project}-${service}-1`,
      Running: true,
      Labels: {
        ...labels,
        'com.docker.compose.service': service,
        'com.docker.compose.project.config_files': composePath,
        'com.docker.compose.project.working_dir': dirname(composePath),
        'com.docker.compose.oneoff': 'False',
      },
      Mounts:
        service === 'app'
          ? [{ Type: 'bind', Source: checkout, Destination: '/app', RW: false }]
          : [
              {
                Type: 'volume',
                Name: `${project}_${volumes[index]}`,
                Destination: destinations[index],
              },
            ],
      Networks: { [network]: {} },
      Ports: binding,
      RequestedPorts: binding,
      Command: ['bun', 'server/index.ts'],
    };
  });
  if (options.migration)
    container.push({
      ...container[3],
      Id: '5'.repeat(64),
      Name: options.migrationName ?? `/${project}-migrate-1`,
      Running: options.migration === 'running',
      Ports: {},
      RequestedPorts: {},
      Command: ['bun', 'run', 'db:migrate'],
      Labels: {
        ...container[3].Labels,
        'com.docker.compose.oneoff': options.foreignMigration ? 'False' : 'True',
      },
    });
  return {
    container,
    volume: ['postgres', 'redis', 's3'].map((name) => ({
      Name: `${project}_${name}`,
      Labels: labels,
      Driver: 'local',
      Options: {},
    })),
    network: [
      {
        Name: network,
        Labels: labels,
        Driver: 'bridge',
        Scope: 'local',
        Internal: false,
        Containers: Object.fromEntries(
          container.map((entry) => [entry.Id, { Name: entry.Name.slice(1) }])
        ),
      },
    ],
  };
}
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
    objects: options.owned ? ownedObjects(checkout, options) : undefined,
    disappearMigration: options.disappearMigration,
    log: resolve(directory, 'docker-calls.jsonl'),
  };
  await writeFile(resolve(bin, 'fixture.json'), JSON.stringify(config));
  const common = `const fs=require('node:fs'),path=require('node:path');const config=JSON.parse(fs.readFileSync(path.join(__dirname,'fixture.json'),'utf8'));const args=process.argv.slice(2);`;
  await writeFile(
    resolve(bin, 'git'),
    `#!${process.execPath}\n${common}\nprocess.stdout.write(args[0]==='status'?config.status:args[0]==='diff'?(config.rename?(args.includes('--no-renames')?'db/migrations/moved.ts\\n':'')+'server/extensions/mcp/moved.ts\\n':''):config.revision+'\\n');`,
    { mode: 0o700 }
  );
  await writeFile(
    resolve(bin, 'docker'),
    `#!${process.execPath}\n${common}
fs.appendFileSync(config.log,JSON.stringify(args)+'\\n');
if(args[0]!=='--host'||!args[1].startsWith('unix:///'))process.exit(80);
const a=args.slice(2),save=()=>fs.writeFileSync(path.join(__dirname,'fixture.json'),JSON.stringify(config));
if(a[0]==='info'){process.stdout.write('fixture-daemon\\n');process.exit(0);}
if(config.objects){
  const kind=a[0]==='ps'?'container':a[0];
  if(a.includes('inspect')){
    const id=a.at(-1),entry=config.objects[kind]?.find(x=>x.Id===id||x.Name===id||x.Name==='/'+id);
    if(!entry){process.stderr.write('No such object: '+id);process.exit(1);}
    process.stdout.write(a.includes('{{.Id}}')?entry.Id:JSON.stringify(entry));process.exit(0);
  }
  if(a[0]==='ps'||a.includes('ls')){process.stdout.write(config.objects[kind].map(x=>x.Name.replace(/^\\//,'')).join('\\n'));process.exit(0);}
  if(a[0]==='exec'){process.stdout.write(a.at(-1).includes('to_regclass')?'t':'chimedeck_lab:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');process.exit(0);}
  if(a[0]==='stop'||a[0]==='rm'){
    const entry=config.objects.container.find(x=>x.Id===a[1]);
    if(!entry){process.stderr.write('No such container: '+a[1]);process.exit(1);}
    if(a[0]==='rm'||(config.disappearMigration&&entry.Name.endsWith('-migrate-1')))config.objects.container=config.objects.container.filter(x=>x!==entry);
    else entry.Running=false;
    save();process.exit(0);
  }
  if(a[0]==='compose'&&a.includes('--force-recreate')){config.objects.container.find(x=>x.Name.endsWith('-app-1')).Id='c'.repeat(64);save();process.exit(0);}
  if(a[0]==='compose'&&(a.includes('up')||a.includes('run')))process.exit(0);
  if((a[0]==='network'||a[0]==='volume')&&a[1]==='rm')process.exit(0);
}
if(a.includes('inspect')){process.stdout.write(JSON.stringify({Name:config.collision,Labels:{}}));process.exit(0);}
if(!a.includes('--filter')&&((a[0]==='volume'&&config.collision?.endsWith('_s3'))||(a[0]==='network'&&config.collision?.endsWith('_default'))||(a[0]==='ps'&&config.collision?.endsWith('-postgres-1')))){process.stdout.write(config.collision+'\\n');process.exit(0);}
if(a[0]==='ps'||a.includes('ls'))process.exit(0);
process.stderr.write('unexpected mutation');process.exit(81);`,
    { mode: 0o700 }
  );
  await writeFile(
    resolve(state, 'identity.json'),
    JSON.stringify({
      project: 'chimedeck-compact-lab',
      checkout,
      revision: options.identityRevision ?? revision,
      marker: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      database: 'chimedeck_lab',
      docker_host: endpoint,
      docker_id: 'fixture-daemon',
      dependency_digest: dependencyDigest(checkout),
      allow_mcp_dev: options.persistedMcp ?? false,
    }),
    { mode: 0o600 }
  );
  for (const name of ['node', 'bun'])
    await writeFile(
      resolve(bin, name),
      `#!${process.execPath}\n${common}\nfs.appendFileSync(config.log,JSON.stringify(['client-${name}',...args])+'\\n');`,
      { mode: 0o700 }
    );
  if (options.loaded)
    await writeFile(resolve(state, 'app-start.json'), JSON.stringify(options.loaded), {
      mode: 0o600,
    });
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
  const invoke = (command) =>
    spawnSync(
      process.execPath,
      [resolve(checkout, 'scripts/local-lab/control.mjs'), command, state, revision],
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
  const result = invoke(options.command ?? 'start');
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
  return {
    directory,
    checkout,
    home,
    state,
    endpoint,
    socket,
    identityBefore,
    result,
    calls,
    invoke,
    config,
  };
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
      value.calls
        .filter((args) => !args[0].startsWith('client-'))
        .every((args) => args[0] === '--host' && args[1] === value.endpoint),
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
test('clean proof rejects missing stale cached-development and container-mismatched app provenance', async () => {
  for (const loaded of [
    undefined,
    { container_id: '4'.repeat(64), revision, development: true },
    { container_id: '4'.repeat(64), revision: 'b'.repeat(40), development: false },
    { container_id: '6'.repeat(64), revision, development: false },
  ])
    await refuse({ command: 'test', owned: true, loaded }, 'Loaded app provenance');
});
test('pin does not relabel loaded app; clean proof refuses until restart', async () => {
  const loaded = { container_id: '4'.repeat(64), revision: 'b'.repeat(40), development: false };
  const value = await fixture({
    command: 'pin',
    owned: true,
    identityRevision: 'b'.repeat(40),
    loaded,
  });
  try {
    assert.equal(value.result.status, 0, value.result.stderr);
    assert.deepEqual(
      JSON.parse(await readFile(resolve(value.state, 'app-start.json'), 'utf8')),
      loaded
    );
    const proof = value.invoke('test');
    assert.notEqual(proof.status, 0);
    assert.ok(proof.stderr.includes('Loaded app provenance'));
    const calls = (await readFile(value.config.log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(calls.every((args) => !args.some((arg) => mutations.includes(arg))));
  } finally {
    await new Promise((accept) => value.socket.close(accept));
    await rm(value.directory, { recursive: true, force: true });
  }
});
test('explicit development proof recreates hosted source before fresh stdio client', async () => {
  const value = await fixture({
    command: 'test',
    owned: true,
    allowMcp: '1',
    status: ' M server/extensions/mcp/tools/example.ts\0',
    loaded: { container_id: '4'.repeat(64), revision, development: true },
  });
  try {
    assert.equal(value.result.status, 0, value.result.stderr);
    const recreate = value.calls.findIndex((args) => args.includes('--force-recreate'));
    const client = value.calls.findIndex((args) => args[0] === 'client-bun');
    assert.ok(recreate >= 0 && client > recreate);
    assert.deepEqual(JSON.parse(await readFile(resolve(value.state, 'app-start.json'), 'utf8')), {
      container_id: 'c'.repeat(64),
      revision,
      development: true,
    });
    assert.equal(
      await readFile(resolve(value.state, 'identity.json'), 'utf8'),
      value.identityBefore
    );
  } finally {
    await new Promise((accept) => value.socket.close(accept));
    await rm(value.directory, { recursive: true, force: true });
  }
});
test('running owned migration refuses start and foreign oneoff refuses cleanup before mutation', async () => {
  await refuse(
    { command: 'start', owned: true, migration: 'running' },
    'Owned migration is already running'
  );
  await refuse(
    { command: 'stop', owned: true, migration: 'running', foreignMigration: true },
    'Foreign migration'
  );
  await refuse(
    {
      command: 'stop',
      owned: true,
      migration: 'running',
      migrationName: '/chimedeck-compact-lab-app-run-legacy',
    },
    'Unexpected project-labelled'
  );
});
test('exited owned migration is removed by ID after marker verification before a named fresh run', async () => {
  const value = await fixture({ command: 'start', owned: true, migration: 'exited' });
  try {
    assert.equal(value.result.status, 0, value.result.stderr);
    const marker = value.calls.findIndex((args) =>
      args.some((arg) => arg.includes('current_database()'))
    );
    const remove = value.calls.findIndex((args) => args[2] === 'rm' && args[3] === '5'.repeat(64));
    const migrate = value.calls.findIndex(
      (args) => args.includes('--name') && args.includes('chimedeck-compact-lab-migrate-1')
    );
    assert.ok(marker >= 0 && remove > marker && migrate > remove);
    assert.ok(value.calls.some((args) => args.includes('--force-recreate')));
    assert.deepEqual(JSON.parse(await readFile(resolve(value.state, 'app-start.json'), 'utf8')), {
      container_id: 'c'.repeat(64),
      revision,
      development: false,
    });
  } finally {
    await new Promise((accept) => value.socket.close(accept));
    await rm(value.directory, { recursive: true, force: true });
  }
});
test('interrupted owned migration can disappear after stop; cleanup uses snapshot IDs safely', async () => {
  const value = await fixture({
    command: 'reset',
    owned: true,
    migration: 'running',
    disappearMigration: true,
  });
  try {
    assert.equal(value.result.status, 0, value.result.stderr);
    const actions = value.calls.filter((args) => ['stop', 'rm'].includes(args[2]));
    assert.ok(actions.length >= 9);
    assert.ok(actions.every((args) => /^[a-f0-9]{64}$/.test(args[3])));
    const stops = actions.filter((args) => args[2] === 'stop').map((args) => args[3]);
    assert.ok(stops.indexOf('5'.repeat(64)) < stops.indexOf('1'.repeat(64)));
    assert.ok(stops.indexOf('4'.repeat(64)) < stops.indexOf('1'.repeat(64)));
    assert.ok(
      value.calls.some((args) => args.includes('inspect') && args.at(-1) === '5'.repeat(64))
    );
  } finally {
    await new Promise((accept) => value.socket.close(accept));
    await rm(value.directory, { recursive: true, force: true });
  }
});
