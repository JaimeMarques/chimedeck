import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  openSync,
  closeSync,
  fsyncSync,
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
  sourceSnapshot,
} from './labGuards.mjs';
import {
  checkpointFor,
  validateCheckpoint,
  validateSubset,
  atomicPrivateJson,
  generatedFiles,
} from './resetCheckpoint.mjs';
import { acquireLease } from './labLease.mjs';

const checkout = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
const [command, stateArg, revision] = process.argv.slice(2);
const markerProbe = process.argv[5] === '--nonstarting-marker-check';
if (markerProbe && command !== 'reset') throw new Error('Marker probe is only valid for reset');
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
function present(name) {
  try {
    lstatSync(resolve(state, name));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
function validRuntime(value) {
  return (
    value?.LAB_CHECKOUT === checkout &&
    Object.keys(value).length === 4 &&
    Object.keys(value).every((key) =>
      ['LAB_CHECKOUT', 'LAB_DB_PASSWORD', 'LAB_JWT_PRIVATE_KEY', 'LAB_JWT_PUBLIC_KEY'].includes(key)
    ) &&
    typeof value.LAB_DB_PASSWORD === 'string' &&
    /^[a-f0-9]{48}$/.test(value.LAB_DB_PASSWORD) &&
    typeof value.LAB_JWT_PRIVATE_KEY === 'string' &&
    typeof value.LAB_JWT_PUBLIC_KEY === 'string'
  );
}
const identity =
  command === 'init' && !present('identity.json') ? undefined : privateJson('identity.json');
const resetName = 'reset-checkpoint.json';
const migrationName = 'migration-pending.json';
if (present(resetName) && !cleanup)
  throw new Error('Pending reset blocks setup/proof commands; continue reset first');
if (present(migrationName) && !cleanup)
  throw new Error('Pending migration blocks setup/proof commands; owned reset required');
const allowMcp = process.env.LAB_ALLOW_MCP_DEV === '1';
if (allowMcp && !cleanup)
  console.info('MCP development allowance enabled for this invocation; source may be uncommitted');
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
  mkdirSync(state, { recursive: true, mode: 0o700 });
  if (realpathSync(state) !== state || (lstatSync(state).mode & 0o077) !== 0)
    throw new Error('Private initialization state path/mode mismatch');
  const releaseInit = await acquireLease(state, {
    state,
    checkout,
    project,
    marker: 'initialization',
    docker_host: dockerHost,
    docker_id: daemonId,
  });
  try {
    if (present(resetName) || present('migration-pending.json'))
      throw new Error('Pending authority blocks initialization');
    if (present('identity.json')) {
      const previous = privateJson('identity.json');
      const environment = privateJson('environment.json');
      if (
        previous.project !== project ||
        previous.checkout !== checkout ||
        previous.database !== 'chimedeck_lab' ||
        previous.docker_host !== dockerHost ||
        previous.docker_id !== daemonId ||
        !/^[a-f0-9-]{36}$/.test(previous.marker) ||
        !/^[a-f0-9]{40}$/.test(previous.revision) ||
        !validRuntime(environment)
      )
        throw new Error('Invalid existing initialization pair; no replacement');
      resources();
      console.info('Already initialized; valid private pair retained');
    } else {
      const existing = resources();
      if (existing.container.length || existing.volume.length || existing.network.length)
        throw new Error('Existing lab resources require their original state; no adoption');
      if (present('environment.json')) {
        if ((lstatSync(resolve(state, 'environment.json')).mode & 0o777) !== 0o600)
          throw new Error('Unknown orphan environment mode; recovery refused');
        if (!validRuntime(privateJson('environment.json')))
          throw new Error('Unknown orphan environment; recovery refused');
        if (present('identity.json'))
          throw new Error('Initialization ownership appeared; recovery refused');
        unlinkSync(resolve(state, 'environment.json'));
      }
      run('bun', ['install', '--frozen-lockfile']);
      guardSource(checkout, run, allowMcp);
      const keys = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      });
      const environment = {
        LAB_CHECKOUT: checkout,
        LAB_DB_PASSWORD: randomBytes(24).toString('hex'),
        LAB_JWT_PRIVATE_KEY: Buffer.from(keys.privateKey).toString('base64'),
        LAB_JWT_PUBLIC_KEY: Buffer.from(keys.publicKey).toString('base64'),
      };
      const owner = {
        project,
        checkout,
        revision,
        marker: randomUUID(),
        database: 'chimedeck_lab',
        docker_host: dockerHost,
        docker_id: daemonId,
        dependency_digest: dependencyDigest(checkout),
      };
      atomicPrivateJson(state, 'environment.json', environment, true);
      atomicPrivateJson(state, 'identity.json', owner, true);
      console.info('Initialized private lab state on an explicit local Docker endpoint');
    }
  } finally {
    await releaseInit();
  }
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
const resetBinding = {
  state,
  checkout,
  project,
  marker: identity.marker,
  docker_host: dockerHost,
  docker_id: daemonId,
  revision: identity.revision,
};
const { revision: bindingRevision, ...leaseBinding } = resetBinding;
void bindingRevision;
const assertJournal = (duringMigration = false) => {
  if (JSON.stringify(privateJson('identity.json')) !== JSON.stringify(identity))
    throw new Error('Lab identity changed across lifecycle lease boundary');
  if (present(resetName) && !cleanup)
    throw new Error('Pending reset blocks setup/proof commands; continue reset first');
  if (present(migrationName) && !cleanup && !duringMigration)
    throw new Error('Pending migration blocks setup/proof commands; owned reset required');
};
let pending = present(resetName)
  ? validateCheckpoint(privateJson(resetName), resetBinding)
  : undefined;
const resetResources = () => validateSubset(pending, resources());
const compose = (...args) =>
  docker(['compose', '--project-name', project, '--file', composePath, ...args], { env });
function sql(text, postgres) {
  if (!postgres?.Id || !/^[a-f0-9]{64}$/.test(postgres.Id))
    throw new Error('Validated Postgres snapshot ID required');
  return docker([
    'exec',
    postgres.Id,
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
    docker(['start', postgres.Id]);
    // SQL availability, not an assumption that docker start means ready.
    for (let attempt = 0; attempt < 30; attempt++) {
      const ready = spawnSync(
        'docker',
        [
          '--host',
          dockerHost,
          'exec',
          postgres.Id,
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
    sql("SELECT current_database() || ':' || marker FROM local_lab_identity", postgres) !==
    `chimedeck_lab:${identity.marker}`
  )
    throw new Error('Connected database is not the owned lab');
  return found;
}
function stopOrder(found) {
  return [...found.container].sort(
    (a, b) =>
      Number(![`${project}-migrate-1`, `${project}-app-1`].includes(a.Name.slice(1))) -
      Number(![`${project}-migrate-1`, `${project}-app-1`].includes(b.Name.slice(1)))
  );
}
function refreshApp() {
  if (present('app-start.json')) privateJson('app-start.json');
  const before = sourceSnapshot(checkout, run, revision, allowMcp);
  compose('up', '-d', '--wait', '--no-deps', '--force-recreate', 'app');
  const app = resources(true, true).container.find(
    (container) => container.Name === `/${project}-app-1`
  );
  if (!app?.Running || typeof app.Id !== 'string') throw new Error('Fresh owned app missing');
  const after = sourceSnapshot(checkout, run, revision, allowMcp);
  if (after !== before) throw new Error('Source content changed across app startup boundaries');
  atomicPrivateJson(
    state,
    'app-start.json',
    {
      container_id: app.Id,
      revision,
      development: allowMcp,
    },
    false,
    true
  );
}
async function proofApp(leaseHeld = false) {
  const found = database();
  if (allowMcp) {
    if (leaseHeld) {
      assertJournal();
      refreshApp();
    } else {
      const release = await acquireLease(state, leaseBinding);
      try {
        assertJournal();
        refreshApp();
      } finally {
        await release();
      }
    }
    return;
  }
  if (!present('app-start.json'))
    throw new Error('Loaded app provenance missing; run clean restart-app');
  const loaded = privateJson('app-start.json');
  const app = found.container.find((container) => container.Name === `/${project}-app-1`);
  if (
    !app?.Running ||
    loaded.container_id !== app.Id ||
    loaded.revision !== revision ||
    loaded.development !== false
  )
    throw new Error('Loaded app provenance is stale or development-started; run clean restart-app');
}
function containerAction(action, container) {
  // Snapshot IDs cannot select a replacement that reuses an owned name.
  try {
    docker(action === 'network' ? ['network', 'rm', container.Id] : [action, container.Id]);
  } catch (error) {
    const probe = spawnSync(
      'docker',
      [
        '--host',
        dockerHost,
        action === 'network' ? 'network' : 'container',
        'inspect',
        '--format',
        '{{.Id}}',
        container.Id,
      ],
      { env: cleanEnv, encoding: 'utf8' }
    );
    if (probe.status === 1 && /No such (object|container|network)/i.test(probe.stderr ?? ''))
      return;
    throw error;
  }
}
if (
  !cleanup &&
  !['pin', 'prepare'].includes(command) &&
  identity.dependency_digest !== dependencyDigest(checkout)
)
  throw new Error('Dependencies not prepared for this source; run prepare');
let release;
try {
  if (
    ['reset', 'start', 'restart-app', 'stop', 'pin', 'seed', 'prepare', 'guards'].includes(command)
  ) {
    release = await acquireLease(state, leaseBinding);
    assertJournal();
    pending = present(resetName)
      ? validateCheckpoint(privateJson(resetName), resetBinding)
      : undefined;
  }
  if (command === 'prepare') {
    resources();
    run('bun', ['install', '--frozen-lockfile']);
    guardSource(checkout, run, allowMcp);
    identity.dependency_digest = dependencyDigest(checkout);
    atomicPrivateJson(state, 'identity.json', identity);
    console.info('Prepared frozen dependencies for the selected source');
  } else if (command === 'pin') {
    const changed = run('git', ['diff', '--no-renames', '--name-only', identity.revision, revision])
      .trim()
      .split('\n')
      .filter(Boolean);
    if (
      changed.some(
        (path) =>
          !path.startsWith('server/extensions/mcp/') &&
          !path.startsWith('scripts/local-lab/') &&
          path !== 'README.md' &&
          path !== 'src/extensions/DeveloperDocs/containers/McpDocsPage/McpDocsPage.tsx' &&
          !/^specs\/changelog\/\d{8}_\d{6}\.md$/.test(path) &&
          path !== 'specs/tests/mcp/mcp-12-compact-lab.md' &&
          path !== 'specs/tests/mcp/mcp-10-discussion.md'
      )
    )
      throw new Error(
        'Pin only supports committed MCP/lab changes with unchanged application/schema/dependencies; choose a separate baseline'
      );
    database(true);
    identity.revision = revision;
    identity.docker_host = dockerHost;
    identity.docker_id = daemonId;
    delete identity.allow_mcp_dev;
    atomicPrivateJson(state, 'identity.json', identity);
    console.info('Pinned the unchanged-schema source and verified local Docker daemon');
  } else if (command === 'start') {
    const found = resources();
    const migration = found.container.find(
      (container) => container.Name === `/${project}-migrate-1`
    );
    if (migration?.Running)
      throw new Error('Owned migration is already running; stop it before start');
    if (!found.container.some((container) => container.Running))
      for (const port of [33000, 35432, 36379, 34566])
        await new Promise((accept, reject) => {
          const server = net.createServer();
          server.once('error', reject);
          server.listen(port, '127.0.0.1', () => server.close(accept));
        });
    compose('up', '-d', '--wait', 'postgres', 'redis', 'localstack');
    const infrastructure = resources(true, true);
    const postgres = infrastructure.container.find(
      (container) => container.Name === `/${project}-postgres-1`
    );
    const markerPresent = sql(
      "SELECT to_regclass('public.local_lab_identity') IS NOT NULL",
      postgres
    );
    if (markerPresent === 'f') {
      if (
        sql(
          "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'",
          postgres
        ) !== '0'
      )
        throw new Error('Refusing to claim a populated unmarked database');
      sql(
        `CREATE TABLE local_lab_identity(marker text PRIMARY KEY); INSERT INTO local_lab_identity VALUES('${identity.marker}')`,
        postgres
      );
    }
    database();
    if (migration) containerAction('rm', migration);
    assertJournal();
    if (docker(['info', '--format', '{{.ID}}']).trim() !== daemonId)
      throw new Error('Local daemon changed before migration');
    const migrationResources = checkpointFor(resetBinding, database());
    const beforeMigration = sourceSnapshot(checkout, run, revision, allowMcp);
    const migrationReceipt = {
      version: 1,
      binding: resetBinding,
      pre_source: beforeMigration,
      resources: migrationResources,
    };
    atomicPrivateJson(state, migrationName, migrationReceipt, true);
    compose(
      'run',
      '--name',
      `${project}-migrate-1`,
      '--rm',
      '--no-deps',
      'app',
      'bun',
      'run',
      'db:migrate'
    );
    const afterMigration = sourceSnapshot(checkout, run, revision, allowMcp);
    if (afterMigration !== beforeMigration)
      throw new Error('Source changed across migration boundaries; owned reset required');
    assertJournal(true);
    if (docker(['info', '--format', '{{.ID}}']).trim() !== daemonId)
      throw new Error('Local daemon changed after migration');
    validateSubset(migrationResources, database());
    if (JSON.stringify(privateJson(migrationName)) !== JSON.stringify(migrationReceipt))
      throw new Error('Migration receipt changed; owned reset required');
    try {
      unlinkSync(resolve(state, migrationName));
      const directory = openSync(state, 'r');
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } catch (error) {
      if (!present(migrationName)) atomicPrivateJson(state, migrationName, migrationReceipt, true);
      throw error;
    }
    refreshApp();
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
    if (markerProbe) {
      database(false);
      throw new Error('Nonstarting marker probe never authorizes reset mutation');
    }
    if (!pending) {
      const markerVerified = database(true);
      pending = checkpointFor(resetBinding, markerVerified);
      validateSubset(pending, resources(true));
      atomicPrivateJson(state, resetName, pending, true);
    }
    for (const container of stopOrder(resetResources())) {
      const current = resetResources().container.find((entry) => entry.Id === container.Id);
      if (current?.Running) containerAction('stop', current);
    }
    for (const saved of pending.containers) {
      const current = resetResources().container.find((entry) => entry.Id === saved.Id);
      if (current) containerAction('rm', current);
    }
    for (const saved of pending.networks) {
      const current = resetResources().network.find((entry) => entry.Id === saved.Id);
      if (current) containerAction('network', current);
    }
    for (const saved of pending.volumes) {
      const current = resetResources().volume.find((entry) => entry.Name === saved.Name);
      if (current) docker(['volume', 'rm', current.Name]);
    }
    const beforeGenerated = resetResources();
    if (
      beforeGenerated.container.length ||
      beforeGenerated.volume.length ||
      beforeGenerated.network.length
    )
      throw new Error('Reset resources remain; generated receipts retained');
    for (const name of generatedFiles) {
      const file = resolve(state, name);
      try {
        unlinkSync(file);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    const remaining = resetResources();
    if (remaining.container.length || remaining.volume.length || remaining.network.length)
      throw new Error('Reset resources remain; checkpoint retained');
    unlinkSync(resolve(state, resetName));
    console.info('Removed only verified owned lab resources and generated credentials');
  } else if (command === 'stop') {
    const found = pending ? resetResources() : resources(true);
    for (const container of stopOrder(found))
      if (container.Running) {
        if (pending) resetResources();
        containerAction('stop', container);
      }
    console.info('Stopped owned lab containers; resources retained for guarded reset/restart');
  } else if (command === 'status') {
    const found = pending ? resetResources() : resources(true);
    if (
      found.container.some(
        (container) => container.Name === `/${project}-postgres-1` && container.Running
      )
    ) {
      if (!pending) database();
    } else
      console.info(
        'Owned stopped resources validated; database marker is unverified while Postgres is stopped'
      );
    if (pending) console.info('Pending reset validated; only stop/status/reset are permitted');
    if (present(migrationName))
      console.info('Pending migration: schema is uncertified; owned reset required');
    if (present('app-start.json')) {
      const loaded = privateJson('app-start.json');
      console.info(
        `Loaded app revision=${String(loaded.revision)} development=${String(loaded.development)} container=${String(loaded.container_id)}`
      );
    } else console.info('Loaded app provenance missing; clean restart-app required before proof');
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
    refreshApp();
    console.info('Restarted the API on the explicitly pinned revision');
  } else if (command === 'test') {
    await proofApp();
    console.info(
      run('bun', ['scripts/local-lab/smoke.ts'], { env: { ...cleanEnv, LAB_STATE: state } })
    );
  } else if (command === 'guards') {
    await proofApp(true);
    assertJournal();
    if (docker(['info', '--format', '{{.ID}}']).trim() !== daemonId)
      throw new Error('Local daemon changed before guards');
    const guarded = database();
    const postgres = guarded.container.find(
      (container) => container.Name === `/${project}-postgres-1`
    );
    console.info(
      run('node', [
        'scripts/local-lab/guards.mjs',
        state,
        revision,
        dockerHost,
        daemonId,
        postgres.Id,
      ])
    );
    assertJournal();
    if (docker(['info', '--format', '{{.ID}}']).trim() !== daemonId)
      throw new Error('Local daemon changed after guards');
    validateSubset(checkpointFor(resetBinding, guarded), database());
  } else if (command === 'browser') {
    await proofApp();
    const executable = process.argv[5];
    if (!executable || !existsSync(executable))
      throw new Error('Explicit existing browser executable required');
    console.info(run('node', ['scripts/local-lab/browser.mjs', state, executable]));
  } else if (command === 'frontend') {
    database();
    for (const key of Object.keys(process.env)) if (!(key in cleanEnv)) delete process.env[key];
    const { createServer } = await import(
      resolve(checkout, 'node_modules/vite/dist/node/index.js')
    );
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
} finally {
  if (release) await release();
}
