import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import {
  dependencyDigest,
  guardSource,
  inspectOwnedResources,
  localDockerHost,
} from './labGuards.mjs';

const checkout = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
const [command, stateArg, revision] = process.argv.slice(2);
if (!stateArg || !revision || !/^[0-9a-f]{40}$/.test(revision))
  throw new Error('Usage: node scripts/local-lab/control.mjs COMMAND STATE EXACT_REVISION');
const state = resolve(stateArg);
const project = 'chimedeck-compact-lab';
const composePath = resolve(checkout, 'scripts/local-lab/compose.yml');
const cleanup = ['stop', 'reset', 'status'].includes(command);
const cleanEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: checkout,
    env: cleanEnv,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0)
    throw new Error(
      `${executable} failed (${String(result.status)}): ${(result.stderr ?? '').slice(-1200)}`
    );
  return result.stdout ?? '';
}
if (!cleanup) {
  if (run('git', ['rev-parse', 'HEAD']).trim() !== revision)
    throw new Error('Selected checkout revision changed');
}
if (existsSync(state) && (realpathSync(state) !== state || (lstatSync(state).mode & 0o077) !== 0))
  throw new Error('Private state path/mode mismatch');
function privateJson(name) {
  const path = resolve(state, name);
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new Error('Private state file ownership/mode mismatch');
  return JSON.parse(readFileSync(path, 'utf8'));
}
const identity = command === 'init' ? undefined : privateJson('identity.json');
const allowMcp = process.env.LAB_ALLOW_MCP_DEV === '1' || identity?.allow_mcp_dev === true;
if (!cleanup) guardSource(checkout, run, allowMcp);
const selectedHost =
  process.env.LAB_DOCKER_HOST ??
  identity?.docker_host ??
  (command === 'init' ? 'unix:///var/run/docker.sock' : undefined);
const dockerHost = localDockerHost(selectedHost);
if (identity?.docker_host && identity.docker_host !== dockerHost)
  throw new Error('Recorded Docker endpoint changed');
if (identity && !identity.docker_id && command !== 'pin')
  throw new Error('Bind the existing owned lab with pin and explicit LAB_DOCKER_HOST first');
const docker = (args, options = {}) => run('docker', ['--host', dockerHost, ...args], options);
const daemonId = docker(['info', '--format', '{{.ID}}']).trim();
if (!daemonId || (identity?.docker_id && identity.docker_id !== daemonId))
  throw new Error('Recorded local Docker daemon identity changed');
function resources(required = false, probe = false) {
  const found = inspectOwnedResources(docker, project, checkout, composePath);
  if (required && !found.container.length) throw new Error('Lab containers missing');
  if (probe && found.published.length)
    run('node', [
      '-e',
      `const net=require('node:net');Promise.all(${JSON.stringify(found.published)}.map(port=>new Promise((accept,reject)=>{const socket=net.connect(port,'127.0.0.1',()=>{socket.destroy();accept();});socket.setTimeout(3000,()=>{socket.destroy();reject(new Error('timeout'));});socket.on('error',reject);}))).catch(()=>process.exit(1));`,
    ]);
  return found;
}
if (command === 'init') {
  if (existsSync(resolve(state, 'identity.json'))) throw new Error('Lab already initialized');
  const existing = resources();
  if (existing.container.length || existing.volume.length || existing.network.length)
    throw new Error('Existing lab resources require their original state; no adoption');
  run('bun', ['install', '--frozen-lockfile']);
  guardSource(checkout, run, allowMcp);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  chmodSync(state, 0o700);
  const keys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const record = {
    project,
    checkout,
    revision,
    marker: randomUUID(),
    database: 'chimedeck_lab',
    docker_host: dockerHost,
    docker_id: daemonId,
    dependency_digest: dependencyDigest(checkout),
    allow_mcp_dev: allowMcp,
  };
  const runtime = {
    LAB_CHECKOUT: checkout,
    LAB_DB_PASSWORD: randomBytes(24).toString('hex'),
    LAB_JWT_PRIVATE_KEY: Buffer.from(keys.privateKey).toString('base64'),
    LAB_JWT_PUBLIC_KEY: Buffer.from(keys.publicKey).toString('base64'),
  };
  for (const [name, data] of [
    ['identity.json', record],
    ['environment.json', runtime],
  ])
    writeFileSync(resolve(state, name), JSON.stringify(data), { mode: 0o600, flag: 'wx' });
  console.info('Initialized private lab state on an explicit local Docker endpoint');
  process.exit(0);
}
const runtime = privateJson('environment.json');
if (
  identity.project !== project ||
  identity.checkout !== checkout ||
  (identity.revision !== revision && command !== 'pin') ||
  identity.database !== 'chimedeck_lab' ||
  runtime.LAB_CHECKOUT !== checkout ||
  Object.keys(runtime).some(
    (key) =>
      !['LAB_CHECKOUT', 'LAB_DB_PASSWORD', 'LAB_JWT_PRIVATE_KEY', 'LAB_JWT_PUBLIC_KEY'].includes(
        key
      )
  ) ||
  !/^[a-f0-9]{48}$/.test(runtime.LAB_DB_PASSWORD) ||
  typeof runtime.LAB_JWT_PRIVATE_KEY !== 'string' ||
  typeof runtime.LAB_JWT_PUBLIC_KEY !== 'string'
)
  throw new Error('Lab ownership/configuration mismatch');
const env = { ...cleanEnv, ...runtime };
const compose = (...args) =>
  docker(['compose', '--project-name', project, '--file', composePath, ...args], { env });
function sql(text) {
  return docker([
    'exec',
    `${project}-postgres-1`,
    'psql',
    '-U',
    'chimedeck_lab',
    '-d',
    'chimedeck_lab',
    '-At',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    text,
  ]).trim();
}
function database(allowStart = false) {
  const found = resources(true, !cleanup);
  const postgres = found.container.find((container) => container.Name === `/${project}-postgres-1`);
  if (!postgres)
    throw new Error('Owned Postgres container missing; start the clean pinned lab before reset');
  if (!postgres.Running) {
    if (!allowStart) throw new Error('Owned Postgres is stopped');
    docker(['start', `${project}-postgres-1`]);
    // SQL availability, not an assumption that docker start means ready.
    for (let attempt = 0; attempt < 30; attempt++) {
      const ready = spawnSync(
        'docker',
        [
          '--host',
          dockerHost,
          'exec',
          `${project}-postgres-1`,
          'pg_isready',
          '-U',
          'chimedeck_lab',
          '-d',
          'chimedeck_lab',
        ],
        { env: cleanEnv, stdio: 'ignore' }
      );
      if (ready.status === 0) break;
      if (attempt === 29) throw new Error('Owned Postgres failed readiness');
      run('node', ['-e', 'setTimeout(()=>{},200)']);
    }
  }
  if (
    sql("SELECT current_database() || ':' || marker FROM local_lab_identity") !==
    `chimedeck_lab:${identity.marker}`
  )
    throw new Error('Connected database is not the owned lab');
  return found;
}
if (
  !cleanup &&
  !['pin', 'prepare'].includes(command) &&
  identity.dependency_digest !== dependencyDigest(checkout)
)
  throw new Error('Dependencies not prepared for this source; run prepare');
if (command === 'prepare') {
  resources();
  run('bun', ['install', '--frozen-lockfile']);
  guardSource(checkout, run, allowMcp);
  identity.dependency_digest = dependencyDigest(checkout);
  writeFileSync(resolve(state, 'identity.json'), JSON.stringify(identity), { mode: 0o600 });
  console.info('Prepared frozen dependencies for the selected source');
} else if (command === 'pin') {
  const changed = run('git', ['diff', '--name-only', identity.revision, revision])
    .trim()
    .split('\n')
    .filter(Boolean);
  if (
    changed.some(
      (path) =>
        !path.startsWith('server/extensions/mcp/') &&
        !path.startsWith('scripts/local-lab/') &&
        path !== 'README.md'
    )
  )
    throw new Error(
      'Pin only supports committed MCP/lab changes with unchanged application/schema/dependencies; choose a separate baseline'
    );
  database(true);
  identity.revision = revision;
  identity.docker_host = dockerHost;
  identity.docker_id = daemonId;
  identity.allow_mcp_dev = allowMcp;
  writeFileSync(resolve(state, 'identity.json'), JSON.stringify(identity), { mode: 0o600 });
  console.info('Pinned the unchanged-schema source and verified local Docker daemon');
} else if (command === 'start') {
  const found = resources();
  if (!found.container.some((container) => container.Running))
    for (const port of [33000, 35432, 36379, 34566])
      await new Promise((accept, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => server.close(accept));
      });
  compose('up', '-d', '--wait', 'postgres', 'redis', 'localstack');
  resources(true, true);
  const present = sql("SELECT to_regclass('public.local_lab_identity') IS NOT NULL");
  if (present === 'f') {
    if (sql("SELECT count(*) FROM information_schema.tables WHERE table_schema='public'") !== '0')
      throw new Error('Refusing to claim a populated unmarked database');
    sql(
      `CREATE TABLE local_lab_identity(marker text PRIMARY KEY); INSERT INTO local_lab_identity VALUES('${identity.marker}')`
    );
  }
  database();
  compose('run', '--rm', '--no-deps', 'app', 'bun', 'run', 'db:migrate');
  compose('up', '-d', '--wait', 'app');
  resources(true, true);
  console.info('Local API started on http://127.0.0.1:33000');
} else if (command === 'seed') {
  database();
  run('bun', ['scripts/local-lab/seed.ts'], {
    env: {
      ...cleanEnv,
      DATABASE_URL: `postgresql://chimedeck_lab:${runtime.LAB_DB_PASSWORD}@127.0.0.1:35432/chimedeck_lab`,
      LAB_MARKER: identity.marker,
      LAB_STATE: state,
    },
  });
  console.info('Synthetic fixtures seeded; credentials remain private');
} else if (command === 'reset') {
  database(true);
  const found = resources(true);
  for (const container of found.container)
    if (container.Running) docker(['stop', container.Name.slice(1)]);
  for (const container of found.container) docker(['rm', container.Name.slice(1)]);
  for (const network of found.network) docker(['network', 'rm', network.Name]);
  for (const volume of found.volume) docker(['volume', 'rm', volume.Name]);
  for (const name of [
    'credentials.json',
    'smoke-result.json',
    'browser-result.json',
    'smoke-attachment.txt',
    'browser-smoke.png',
  ]) {
    const file = resolve(state, name);
    if (existsSync(file)) unlinkSync(file);
  }
  console.info('Removed only verified owned lab resources and generated credentials');
} else if (command === 'stop') {
  const found = resources(true);
  for (const container of found.container)
    if (container.Running) docker(['stop', container.Name.slice(1)]);
  console.info('Stopped owned lab containers; resources retained for guarded reset/restart');
} else if (command === 'status') {
  const found = resources(true);
  if (
    found.container.some(
      (container) => container.Name === `/${project}-postgres-1` && container.Running
    )
  )
    database();
  else
    console.info(
      'Owned stopped resources validated; database marker is unverified while Postgres is stopped'
    );
  console.info(
    docker([
      'ps',
      '-a',
      '--filter',
      `label=com.docker.compose.project=${project}`,
      '--format',
      '{{.Names}} {{.Status}} {{.Ports}}',
    ])
  );
} else if (command === 'restart-app') {
  database();
  compose('up', '-d', '--wait', '--no-deps', '--force-recreate', 'app');
  resources(true, true);
  console.info('Restarted the API on the explicitly pinned revision');
} else if (command === 'test') {
  database();
  console.info(
    run('bun', ['scripts/local-lab/smoke.ts'], { env: { ...cleanEnv, LAB_STATE: state } })
  );
} else if (command === 'guards') {
  database();
  console.info(run('node', ['scripts/local-lab/guards.mjs', state, revision]));
} else if (command === 'browser') {
  database();
  const executable = process.argv[5];
  if (!executable || !existsSync(executable))
    throw new Error('Explicit existing browser executable required');
  console.info(run('node', ['scripts/local-lab/browser.mjs', state, executable]));
} else if (command === 'frontend') {
  database();
  for (const key of Object.keys(process.env)) if (!(key in cleanEnv)) delete process.env[key];
  const { createServer } = await import(resolve(checkout, 'node_modules/vite/dist/node/index.js'));
  const server = await createServer({
    root: checkout,
    server: {
      host: '127.0.0.1',
      port: 35173,
      strictPort: true,
      proxy: {
        '/api': { target: 'http://127.0.0.1:33000', ws: true, changeOrigin: true },
        '/trello': { target: 'http://127.0.0.1:33000', changeOrigin: true },
      },
    },
  });
  await server.listen();
  console.info('Local frontend on http://127.0.0.1:35173');
} else throw new Error('Unknown lab command');
