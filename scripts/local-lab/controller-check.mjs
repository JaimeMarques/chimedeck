import { test, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { dependencyDigest } from './labGuards.mjs';
import { checkpointFor, atomicPrivateJson } from './resetCheckpoint.mjs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { acquireLease } from './labLease.mjs';

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
  if (options.disappearPgOnStart) container[0].Running = false;
  return {
    container,
    volume: ['postgres', 'redis', 's3'].map((name) => ({
      Name: `${project}_${name}`,
      Labels: labels,
      Driver: 'local',
      CreatedAt: '2026-10-12T00:00:00Z',
      Options: {},
    })),
    network: [
      {
        Name: network,
        Id: '7'.repeat(64),
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
  for (const name of [
    'control.mjs',
    'labGuards.mjs',
    'resetCheckpoint.mjs',
    'labLease.mjs',
    'guards.mjs',
  ])
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
    checkout,
    startupDrift: options.startupDrift,
    foreignConsumer: options.foreignConsumer,
    interrupt: options.interrupt,
    disappearPgOnStart: options.disappearPgOnStart,
    disappearPgOnExec: options.disappearPgOnExec,
    daemon: options.daemon,
    migrationFault: options.migrationFault,
    initCrash: options.initCrash,
    migrationClearFault: options.migrationClearFault,
    migrationGateOnLease: options.migrationGateOnLease,
    guardReentry: options.guardReentry,
    state,
    log: resolve(directory, 'docker-calls.jsonl'),
  };
  await writeFile(resolve(bin, 'fixture.json'), JSON.stringify(config));
  const common = `const fs=require('node:fs'),path=require('node:path');const config=JSON.parse(fs.readFileSync(path.join(__dirname,'fixture.json'),'utf8'));const args=process.argv.slice(2);`;
  await writeFile(
    resolve(bin, 'git'),
    `#!${process.execPath}\n${common}\nprocess.stdout.write(args[0]==='status'?config.status:args[0]==='ls-files'?'server/extensions/mcp/tools/example.ts\\0':args[0]==='diff'?(config.rename?(args.includes('--no-renames')?'db/migrations/moved.ts\\n':'')+'server/extensions/mcp/moved.ts\\n':''):config.revision+'\\n');`,
    { mode: 0o700 }
  );
  await writeFile(
    resolve(bin, 'docker'),
    `#!${process.execPath}\n${common}
fs.appendFileSync(config.log,JSON.stringify(args)+'\\n');
if(args[0]!=='--host'||!args[1].startsWith('unix:///'))process.exit(80);
const a=args.slice(2),save=()=>fs.writeFileSync(path.join(__dirname,'fixture.json'),JSON.stringify(config));
if(a[0]==='info'){process.stdout.write((config.daemon??'fixture-daemon')+'\\n');process.exit(0);}
if(config.objects){
  const kind=a[0]==='ps'?'container':a[0];
  if(a.includes('inspect')){
    const id=a.at(-1),entry=config.objects[kind]?.find(x=>x.Id===id||x.Name===id||x.Name==='/'+id);
    if(!entry){process.stderr.write('No such object: '+id);process.exit(1);}
    process.stdout.write(a.includes('{{.Id}}')?entry.Id:JSON.stringify(entry));process.exit(0);
  }
  if(a[0]==='ps'&&a.some(x=>x.startsWith('volume='))){process.stdout.write(config.objects.container.map(x=>x.Id).concat(config.foreignConsumer?['f'.repeat(64)]:[]).join('\\n'));process.exit(0);}
  if(a[0]==='ps'||a.includes('ls')){process.stdout.write(config.objects[kind].map(x=>x.Name.replace(/^\\//,'')).join('\\n'));process.exit(0);}
  if(a[0]==='start'||a[0]==='exec'){
    if((a[0]==='start'&&config.disappearPgOnStart)||(a[0]==='exec'&&config.disappearPgOnExec)){config.objects.container.find(x=>x.Name.endsWith('-postgres-1')).Id='e'.repeat(64);save();}
    const entry=config.objects.container.find(x=>x.Id===a[1]);
    if(!entry){process.stderr.write('No such container: '+a[1]);process.exit(1);}
    if(a[0]==='start'){entry.Running=true;save();process.exit(0);}
    process.stdout.write(a.at(-1).includes('to_regclass')?'t':'chimedeck_lab:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');process.exit(0);
  }
  if(a[0]==='stop'||a[0]==='rm'){
    if(config.interrupt==='post-pg'&&a[0]==='rm'&&a[1]==='2'.repeat(64)){config.interrupt=undefined;save();process.stderr.write('injected interruption');process.exit(81);}
    const entry=config.objects.container.find(x=>x.Id===a[1]);
    if(!entry){process.stderr.write('No such container: '+a[1]);process.exit(1);}
    if(a[0]==='rm'||(config.disappearMigration&&entry.Name.endsWith('-migrate-1')))config.objects.container=config.objects.container.filter(x=>x!==entry);
    else entry.Running=false;
    save();process.exit(0);
  }
  if(a[0]==='compose'&&a.includes('--force-recreate')){config.objects.container.find(x=>x.Name.endsWith('-app-1')).Id='c'.repeat(64);if(config.startupDrift==='head')config.revision='b'.repeat(40);if(config.startupDrift==='content')fs.writeFileSync(path.join(config.checkout,'server/extensions/mcp/tools/example.ts'),'changed');save();process.exit(0);}
  if(a[0]==='compose'&&a.includes('run')){
    if(config.migrationFault==='error'){process.stderr.write('injected migration failure');process.exit(81);}
    if(config.migrationFault==='drift')config.status=' M db/migrations/changed.ts\\0';
    save();process.exit(0);
  }
  if(a[0]==='compose'&&a.includes('up')){if(config.migrationFault==='before')config.status=' M db/migrations/changed.ts\\0';save();process.exit(0);}
  if((a[0]==='network'||a[0]==='volume')&&a[1]==='rm'){
    if(config.interrupt===a[0]){config.interrupt=undefined;save();process.stderr.write('injected interruption');process.exit(81);}
    config.objects[a[0]]=config.objects[a[0]].filter(x=>x.Id!==a[2]&&x.Name!==a[2]);save();process.exit(0);
  }
}
if(a.includes('inspect')){process.stdout.write(JSON.stringify({Name:config.collision,Labels:{}}));process.exit(0);}
if(!a.includes('--filter')&&((a[0]==='volume'&&config.collision?.endsWith('_s3'))||(a[0]==='network'&&config.collision?.endsWith('_default'))||(a[0]==='ps'&&config.collision?.endsWith('-postgres-1')))){process.stdout.write(config.collision+'\\n');process.exit(0);}
if(a[0]==='ps'||a.includes('ls'))process.exit(0);
process.stderr.write('unexpected mutation');process.exit(81);`,
    { mode: 0o700 }
  );
  await mkdir(resolve(checkout, 'server/extensions/mcp/tools'), { recursive: true });
  await writeFile(resolve(checkout, 'server/extensions/mcp/tools/example.ts'), 'original');
  if (!options.initializing)
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
  if (options.pending) {
    const binding = {
      state,
      checkout,
      project: 'chimedeck-compact-lab',
      marker: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      docker_host: endpoint,
      docker_id: 'fixture-daemon',
      revision: options.identityRevision ?? revision,
    };
    const checkpoint = checkpointFor(binding, ownedObjects(checkout, options));
    if (options.mutateCheckpoint) options.mutateCheckpoint(checkpoint);
    await writeFile(
      resolve(state, 'reset-checkpoint.json'),
      options.malformedCheckpoint ?? JSON.stringify(checkpoint),
      { mode: 0o600 }
    );
    if (options.partial) {
      config.objects.container = [];
      config.objects.network = [];
    }
    if (options.mutateResources) options.mutateResources(config.objects);
    await writeFile(resolve(bin, 'fixture.json'), JSON.stringify(config));
  }
  if (options.generatedFailure) await mkdir(resolve(state, 'credentials.json'));
  for (const name of ['node', 'bun'])
    await writeFile(
      resolve(bin, name),
      `#!${process.execPath}\n${common}\nfs.appendFileSync(config.log,JSON.stringify(['client-${name}',...args])+'\\n');if(config.guardReentry&&args[0]?.endsWith('guards.mjs')){const cp=require('node:child_process');const value=cp.spawnSync(process.execPath,[path.join(config.checkout,'scripts/local-lab/control.mjs'),'stop',config.state,config.revision],{env:process.env,encoding:'utf8'});if(value.status===0||!value.stderr.includes('lease busy'))process.exit(82);}if(args[0]?.endsWith('control.mjs')&&args[1]==='reset'){const cp=require('node:child_process');const value=cp.spawnSync(process.execPath,args,{env:process.env,encoding:'utf8'});process.stdout.write(value.stdout??'');process.stderr.write(value.stderr??'');process.exit(value.status??1);}`,
      { mode: 0o700 }
    );
  if (options.loaded)
    await writeFile(resolve(state, 'app-start.json'), JSON.stringify(options.loaded), {
      mode: 0o600,
    });
  if (!options.initializing || options.orphanEnvironment)
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
  const faultFile = resolve(bin, 'init-fault.mjs');
  await writeFile(
    faultFile,
    `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';import process from'node:process';const path=${JSON.stringify(resolve(bin, 'fixture.json'))};const original=fs.linkSync;fs.linkSync=(from,to)=>{const c=JSON.parse(fs.readFileSync(path,'utf8'));original(from,to);if(c.migrationGateOnLease&&to.endsWith('lifecycle-lease.json')){c.migrationGateOnLease=undefined;fs.writeFileSync(path,JSON.stringify(c));fs.writeFileSync(to.replace('lifecycle-lease.json','migration-pending.json'),'{}',{mode:0o600});}if(c.initCrash&&to.endsWith(c.initCrash+'.json')){c.initCrash=undefined;fs.writeFileSync(path,JSON.stringify(c));process.exit(91);}};const remove=fs.unlinkSync,sync=fs.fsyncSync;let clearing=false;fs.unlinkSync=(file)=>{const result=remove(file);if(String(file).endsWith('migration-pending.json'))clearing=true;return result;};fs.fsyncSync=(fd)=>{const c=JSON.parse(fs.readFileSync(path,'utf8'));if(clearing&&c.migrationClearFault){c.migrationClearFault=undefined;fs.writeFileSync(path,JSON.stringify(c));clearing=false;throw new Error('injected migration clear uncertainty');}return sync(fd);};syncBuiltinESMExports();`
  );
  if (options.envFile) await writeFile(resolve(checkout, options.envFile), 'SYNTHETIC=true');
  const identityBefore = options.initializing
    ? undefined
    : await readFile(resolve(state, 'identity.json'), 'utf8');
  const invoke = (command, extra = [], inject = false) =>
    spawnSync(
      process.execPath,
      [
        ...(inject ? ['--import', faultFile] : []),
        resolve(checkout, 'scripts/local-lab/control.mjs'),
        command,
        state,
        revision,
        ...extra,
      ],
      {
        cwd: checkout,
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          HOME: home,
          ...(options.initializing ? { LAB_DOCKER_HOST: endpoint } : {}),
          ...(options.endpoint ? { LAB_DOCKER_HOST: options.endpoint } : {}),
          ...(options.allowMcp !== undefined ? { LAB_ALLOW_MCP_DEV: options.allowMcp } : {}),
        },
        encoding: 'utf8',
      }
    );
  const result = invoke(
    options.command ?? 'start',
    [],
    Boolean(options.initCrash || options.migrationClearFault || options.migrationGateOnLease)
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
      !value.calls.some((args) => args[2] === 'rm' && args[3] === '5'.repeat(64)),
      'An already absent authorized ID is not selected again by name'
    );
  } finally {
    await new Promise((accept) => value.socket.close(accept));
    await rm(value.directory, { recursive: true, force: true });
  }
});
test('startup HEAD and same-status content drift refuse without a new app stamp', async () => {
  for (const startupDrift of ['head', 'content']) {
    const value = await fixture({
      command: 'restart-app',
      owned: true,
      startupDrift,
      ...(startupDrift === 'content'
        ? { allowMcp: '1', status: ' M server/extensions/mcp/tools/example.ts\0' }
        : {}),
    });
    try {
      assert.notEqual(value.result.status, 0);
      assert.ok(
        value.result.stderr.includes(
          startupDrift === 'head' ? 'revision changed' : 'content changed'
        )
      );
      await assert.rejects(readFile(resolve(value.state, 'app-start.json')));
    } finally {
      await new Promise((accept) => value.socket.close(accept));
      await rm(value.directory, { recursive: true, force: true });
    }
  }
});
test('running and stopped foreign volume consumers refuse before destructive commands', async () => {
  for (const foreignConsumer of ['running', 'stopped'])
    await refuse({ command: 'reset', owned: true, foreignConsumer }, 'Foreign consumer');
});
test('reset resumes post-Postgres network volume and generated cleanup interruptions', async () => {
  for (const interrupt of ['post-pg', 'network', 'volume', 'generated']) {
    const value = await fixture({
      command: 'reset',
      owned: true,
      ...(interrupt === 'generated' ? { generatedFailure: true } : { interrupt }),
    });
    try {
      assert.notEqual(value.result.status, 0);
      const checkpointPath = resolve(value.state, 'reset-checkpoint.json');
      const checkpointBefore = await readFile(checkpointPath, 'utf8');
      assert.ok(
        !JSON.parse(
          await readFile(resolve(value.directory, 'bin/fixture.json'), 'utf8')
        ).objects.container.some((entry) => entry.Name.endsWith('-postgres-1'))
      );
      assert.equal(value.invoke('status').status, 0);
      assert.equal(value.invoke('stop').status, 0);
      assert.equal(await readFile(checkpointPath, 'utf8'), checkpointBefore);
      if (interrupt === 'generated')
        await rm(resolve(value.state, 'credentials.json'), { recursive: true });
      const resumed = value.invoke('reset');
      assert.equal(resumed.status, 0, resumed.stderr);
      await assert.rejects(readFile(checkpointPath));
      assert.equal(
        await readFile(resolve(value.state, 'identity.json'), 'utf8'),
        value.identityBefore
      );
    } finally {
      await new Promise((accept) => value.socket.close(accept));
      await rm(value.directory, { recursive: true, force: true });
    }
  }
});
test('pending checkpoint blocks every setup/proof command without overwriting authority', async () => {
  for (const command of [
    'start',
    'pin',
    'prepare',
    'restart-app',
    'seed',
    'frontend',
    'browser',
    'guards',
    'test',
  ])
    await refuse({ command, owned: true, pending: true, partial: true }, 'Pending reset', true);
});
test('invalid unbound replaced altered or foreign-consumed snapshots refuse safely', async () => {
  for (const options of [
    { malformedCheckpoint: '{bad' },
    {
      mutateCheckpoint: (checkpoint) => {
        checkpoint.version = 2;
      },
    },
    {
      mutateCheckpoint: (checkpoint) => {
        checkpoint.binding.marker = 'changed';
      },
    },
    {
      mutateCheckpoint: (checkpoint) => {
        checkpoint.binding.state = '/different';
      },
    },
    {
      mutateCheckpoint: (checkpoint) => {
        checkpoint.generated.push('../outside');
      },
    },
    {
      mutateResources: (resources) => {
        resources.container[0].Id = 'e'.repeat(64);
      },
    },
    {
      mutateResources: (resources) => {
        resources.network[0].Id = 'e'.repeat(64);
      },
    },
    {
      mutateResources: (resources) => {
        resources.volume[0].CreatedAt = '2026-10-13T00:00:00Z';
      },
    },
    { foreignConsumer: 'stopped' },
    { daemon: 'changed-daemon' },
  ]) {
    const value = await fixture({ command: 'reset', owned: true, pending: true, ...options });
    try {
      const checkpointBefore = await readFile(
        resolve(value.state, 'reset-checkpoint.json'),
        'utf8'
      );
      assert.notEqual(value.result.status, 0);
      assert.ok(value.calls.every((args) => !args.some((arg) => mutations.includes(arg))));
      assert.equal(
        await readFile(resolve(value.state, 'reset-checkpoint.json'), 'utf8'),
        checkpointBefore
      );
      assert.equal(
        await readFile(resolve(value.state, 'identity.json'), 'utf8'),
        value.identityBefore
      );
    } finally {
      await new Promise((accept) => value.socket.close(accept));
      await rm(value.directory, { recursive: true, force: true });
    }
  }
});
test('active same-state lifecycle owner prevents another reset from resuming its journal', async () => {
  const value = await fixture({ command: 'status', owned: true, pending: true, partial: true });
  const binding = {
    state: value.state,
    checkout: value.checkout,
    project: 'chimedeck-compact-lab',
    marker: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    docker_host: value.endpoint,
    docker_id: 'fixture-daemon',
  };
  try {
    assert.equal(value.result.status, 0, value.result.stderr);
    const checkpoint = await readFile(resolve(value.state, 'reset-checkpoint.json'), 'utf8');
    const release = await acquireLease(value.state, binding);
    try {
      const reset = value.invoke('reset');
      assert.notEqual(reset.status, 0);
      assert.ok(reset.stderr.includes('lease busy'));
      assert.equal(
        await readFile(resolve(value.state, 'reset-checkpoint.json'), 'utf8'),
        checkpoint
      );
    } finally {
      await release();
    }
    const reset = value.invoke('reset');
    assert.equal(reset.status, 0, reset.stderr);
  } finally {
    await new Promise((accept) => value.socket.close(accept));
    await rm(value.directory, { recursive: true, force: true });
  }
});
test('validated Postgres snapshot ID never starts or queries a same-name replacement', async () => {
  for (const options of [{ disappearPgOnStart: true }, { disappearPgOnExec: true }]) {
    const value = await fixture({ command: 'reset', owned: true, ...options });
    try {
      assert.notEqual(value.result.status, 0);
      const postgresCalls = value.calls.filter((args) => ['start', 'exec'].includes(args[2]));
      assert.ok(postgresCalls.length > 0);
      assert.ok(postgresCalls.every((args) => args[3] === '1'.repeat(64)));
      assert.ok(!postgresCalls.some((args) => args[3] === 'e'.repeat(64)));
      await assert.rejects(readFile(resolve(value.state, 'reset-checkpoint.json')));
      assert.equal(
        await readFile(resolve(value.state, 'identity.json'), 'utf8'),
        value.identityBefore
      );
    } finally {
      await new Promise((accept) => value.socket.close(accept));
      await rm(value.directory, { recursive: true, force: true });
    }
  }
});
test('owner publication failures leave complete authority usable by cleanup commands', async () => {
  const value = await fixture({ command: 'status', owned: true });
  try {
    assert.equal(value.result.status, 0, value.result.stderr);
    const owner = JSON.parse(value.identityBefore);
    const updated = { ...owner, dependency_digest: 'new-preparation' };
    mock.method(fs, 'renameSync', () => {
      throw new Error('injected before publication');
    });
    syncBuiltinESMExports();
    assert.throws(
      () => atomicPrivateJson(value.state, 'identity.json', updated),
      /before publication/
    );
    mock.restoreAll();
    syncBuiltinESMExports();
    assert.equal(value.invoke('status').status, 0);
    const sync = fs.fsyncSync;
    let calls = 0;
    mock.method(fs, 'fsyncSync', (fd) => {
      if (++calls === 2) throw new Error('injected after publication');
      return sync(fd);
    });
    syncBuiltinESMExports();
    assert.throws(
      () => atomicPrivateJson(value.state, 'identity.json', updated),
      /after publication/
    );
    mock.restoreAll();
    syncBuiltinESMExports();
    assert.deepEqual(
      JSON.parse(await readFile(resolve(value.state, 'identity.json'), 'utf8')),
      updated
    );
    const stopped = value.invoke('stop');
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(value.invoke('status').status, 0);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    await new Promise((accept) => value.socket.close(accept));
    await rm(value.directory, { recursive: true, force: true });
  }
});
test('migration source refusal happens before execution; drift error or crash stays gated after revert', async () => {
  for (const mode of ['before', 'drift', 'error', 'crash']) {
    const value = await fixture({
      command: 'start',
      owned: true,
      ...(mode === 'crash' ? { initCrash: 'migration-pending' } : { migrationFault: mode }),
    });
    try {
      assert.notEqual(value.result.status, 0);
      const receipt = resolve(value.state, 'migration-pending.json');
      if (mode === 'before') {
        await assert.rejects(readFile(receipt));
        assert.ok(!value.calls.some((args) => args.includes('db:migrate')));
      } else {
        const recorded = await readFile(receipt, 'utf8');
        const config = JSON.parse(
          await readFile(resolve(value.directory, 'bin/fixture.json'), 'utf8')
        );
        config.status = '';
        config.migrationFault = undefined;
        await writeFile(resolve(value.directory, 'bin/fixture.json'), JSON.stringify(config));
        for (const command of [
          'start',
          'restart-app',
          'prepare',
          'pin',
          'seed',
          'test',
          'browser',
          'frontend',
          'guards',
        ]) {
          const blocked = value.invoke(command);
          assert.notEqual(blocked.status, 0);
          assert.ok(blocked.stderr.includes('Pending migration'));
        }
        assert.equal(value.invoke('status').status, 0);
        assert.equal(value.invoke('stop').status, 0);
        assert.equal(await readFile(receipt, 'utf8'), recorded);
        const reset = value.invoke('reset');
        assert.equal(reset.status, 0, reset.stderr);
        await assert.rejects(readFile(receipt));
      }
    } finally {
      await new Promise((accept) => value.socket.close(accept));
      await rm(value.directory, { recursive: true, force: true });
    }
  }
});
test('init crash boundaries recover orphan environment or committed pair under stable initializer lease', async () => {
  for (const initCrash of ['environment', 'identity']) {
    const value = await fixture({ command: 'init', initializing: true, initCrash });
    try {
      assert.equal(value.result.status, 91);
      const environment = await readFile(resolve(value.state, 'environment.json'), 'utf8');
      const resumed = value.invoke('init');
      assert.equal(resumed.status, 0, resumed.stderr);
      const owner = JSON.parse(await readFile(resolve(value.state, 'identity.json'), 'utf8'));
      assert.equal(owner.checkout, value.checkout);
      if (initCrash === 'identity')
        assert.equal(await readFile(resolve(value.state, 'environment.json'), 'utf8'), environment);
      const before = await readFile(resolve(value.state, 'identity.json'), 'utf8');
      assert.equal(value.invoke('init').status, 0);
      assert.equal(await readFile(resolve(value.state, 'identity.json'), 'utf8'), before);
    } finally {
      await new Promise((accept) => value.socket.close(accept));
      await rm(value.directory, { recursive: true, force: true });
    }
  }
});
test('guards hold real state lease and pass one validated postgres endpoint daemon and ID', async () => {
  const value = await fixture({
    command: 'guards',
    owned: true,
    guardReentry: true,
    loaded: { container_id: '4'.repeat(64), revision, development: false },
  });
  try {
    assert.equal(value.result.status, 0, value.result.stderr);
    const helper = value.calls.find(
      (args) => args[0] === 'client-node' && args[1].endsWith('guards.mjs')
    );
    assert.ok(helper);
    assert.deepEqual(helper.slice(-3), [value.endpoint, 'fixture-daemon', '1'.repeat(64)]);
  } finally {
    await new Promise((accept) => value.socket.close(accept));
    await rm(value.directory, { recursive: true, force: true });
  }
});
test('nonstarting marker probe refuses stopped postgres without start checkpoint or destruction', async () => {
  const value = await fixture({ command: 'status', owned: true, disappearPgOnStart: true });
  try {
    const probed = value.invoke('reset', ['--nonstarting-marker-check']);
    assert.notEqual(probed.status, 0);
    assert.ok(probed.stderr.includes('Owned Postgres is stopped'));
    const calls = (await readFile(value.config.log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(calls.every((args) => !args.some((arg) => mutations.includes(arg))));
    await assert.rejects(readFile(resolve(value.state, 'reset-checkpoint.json')));
  } finally {
    await new Promise((accept) => value.socket.close(accept));
    await rm(value.directory, { recursive: true, force: true });
  }
});
test('guard helper independently refuses changed daemon or postgres identity before count SQL', async () => {
  for (const change of ['daemon', 'postgres']) {
    const value = await fixture({ command: 'status', owned: true });
    try {
      const configPath = resolve(value.directory, 'bin/fixture.json');
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      if (change === 'daemon') config.daemon = 'different';
      else config.objects.container[0].Id = 'e'.repeat(64);
      await writeFile(configPath, JSON.stringify(config));
      const start = (await readFile(value.config.log, 'utf8')).trim().split('\n').length;
      const helper = spawnSync(
        process.execPath,
        [
          resolve(value.checkout, 'scripts/local-lab/guards.mjs'),
          value.state,
          revision,
          value.endpoint,
          'fixture-daemon',
          '1'.repeat(64),
        ],
        {
          env: { PATH: `${resolve(value.directory, 'bin')}:${process.env.PATH}`, HOME: value.home },
          encoding: 'utf8',
        }
      );
      assert.notEqual(helper.status, 0);
      const calls = (await readFile(value.config.log, 'utf8'))
        .trim()
        .split('\n')
        .slice(start)
        .map(JSON.parse);
      assert.ok(!calls.some((args) => args[2] === 'exec'));
    } finally {
      await new Promise((accept) => value.socket.close(accept));
      await rm(value.directory, { recursive: true, force: true });
    }
  }
});
test('concurrent initializer cannot replace a live orphan environment or mix the private pair', async () => {
  const value = await fixture({ command: 'init', initializing: true, initCrash: 'environment' });
  const binding = {
    state: value.state,
    checkout: value.checkout,
    project: 'chimedeck-compact-lab',
    marker: 'initialization',
    docker_host: value.endpoint,
    docker_id: 'fixture-daemon',
  };
  try {
    assert.equal(value.result.status, 91);
    const environment = await readFile(resolve(value.state, 'environment.json'), 'utf8');
    const release = await acquireLease(value.state, binding);
    try {
      const concurrent = value.invoke('init');
      assert.notEqual(concurrent.status, 0);
      assert.ok(concurrent.stderr.includes('lease busy'));
      assert.equal(await readFile(resolve(value.state, 'environment.json'), 'utf8'), environment);
      await assert.rejects(readFile(resolve(value.state, 'identity.json')));
    } finally {
      await release();
    }
    const recovered = value.invoke('init');
    assert.equal(recovered.status, 0, recovered.stderr);
  } finally {
    await new Promise((accept) => value.socket.close(accept));
    await rm(value.directory, { recursive: true, force: true });
  }
});
test('migration receipt clear uncertainty restores the durable fail-closed gate', async () => {
  const value = await fixture({ command: 'start', owned: true, migrationClearFault: true });
  try {
    assert.notEqual(value.result.status, 0);
    assert.ok(value.result.stderr.includes('clear uncertainty'));
    const receipt = await readFile(resolve(value.state, 'migration-pending.json'), 'utf8');
    assert.equal(JSON.parse(receipt).version, 1);
    const blocked = value.invoke('restart-app');
    assert.notEqual(blocked.status, 0);
    assert.ok(blocked.stderr.includes('Pending migration'));
    assert.equal(await readFile(resolve(value.state, 'migration-pending.json'), 'utf8'), receipt);
  } finally {
    await new Promise((accept) => value.socket.close(accept));
    await rm(value.directory, { recursive: true, force: true });
  }
});
test('migration gate appearing during lease acquisition blocks actions at second check', async () => {
  const value = await fixture({ command: 'restart-app', owned: true, migrationGateOnLease: true });
  try {
    assert.notEqual(value.result.status, 0);
    assert.ok(value.result.stderr.includes('Pending migration'));
    assert.ok(value.calls.every((args) => !args.some((arg) => mutations.includes(arg))));
    assert.equal(await readFile(resolve(value.state, 'migration-pending.json'), 'utf8'), '{}');
  } finally {
    await new Promise((accept) => value.socket.close(accept));
    await rm(value.directory, { recursive: true, force: true });
  }
});
