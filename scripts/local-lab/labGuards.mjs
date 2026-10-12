import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function localDockerHost(value) {
  if (typeof value !== 'string' || !value.startsWith('unix:///') || /[?#]/.test(value))
    throw new Error('An explicit local Unix Docker endpoint is required');
  const path = value.slice('unix://'.length);
  if (!statSync(path).isSocket()) throw new Error('Docker endpoint is not a local Unix socket');
  return `unix://${realpathSync(path)}`;
}
export function guardEnvironment(checkout) {
  if (
    readdirSync(checkout).some(
      (name) => (name === '.env' || name.startsWith('.env.')) && !name.endsWith('.example')
    )
  )
    throw new Error('Loader environment file in selected checkout');
}
export function guardSource(checkout, run, allowMcp = false) {
  guardEnvironment(checkout);
  const records = run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all']).split(
    '\0'
  );
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    const status = record.slice(0, 2);
    const paths = [record.slice(3)];
    if (/[RC]/.test(status)) paths.push(records[++index]);
    if (
      paths.some(
        (path) =>
          typeof path !== 'string' ||
          (!(allowMcp && path.startsWith('server/extensions/mcp/')) && path !== 'README.md')
      )
    )
      throw new Error(
        'Protected source/index/untracked changes; freeze them before persistent lab operations'
      );
  }
}
export function dependencyDigest(checkout) {
  if (realpathSync(resolve(checkout, 'node_modules')) !== resolve(checkout, 'node_modules'))
    throw new Error('Dependencies must belong to the selected checkout');
  return createHash('sha256')
    .update(readFileSync(resolve(checkout, 'package.json')))
    .update('\0')
    .update(readFileSync(resolve(checkout, 'bun.lock')))
    .digest('hex');
}

const services = {
  postgres: {
    volume: 'postgres',
    destination: '/var/lib/postgresql/data',
    port: '5432/tcp',
    hostPort: '35432',
  },
  redis: { volume: 'redis', destination: '/data', port: '6379/tcp', hostPort: '36379' },
  localstack: {
    volume: 's3',
    destination: '/var/lib/localstack',
    port: '4566/tcp',
    hostPort: '34566',
  },
  app: { port: '3000/tcp', hostPort: '33000' },
};
export function inspectOwnedResources(docker, project, checkout, composePath) {
  const names = {
    container: [
      ...Object.keys(services).map((name) => `${project}-${name}-1`),
      `${project}-migrate-1`,
    ],
    volume: ['postgres', 'redis', 's3'].map((name) => `${project}_${name}`),
    network: [`${project}_default`],
  };
  const objects = { container: [], volume: [], network: [] };
  const formats = {
    container:
      '{"Id":{{json .Id}},"Name":{{json .Name}},"Command":{{json .Config.Cmd}},"Labels":{{json .Config.Labels}},"Mounts":{{json .Mounts}},"Networks":{{json .NetworkSettings.Networks}},"Ports":{{json .NetworkSettings.Ports}},"RequestedPorts":{{json .HostConfig.PortBindings}},"Running":{{json .State.Running}}}',
    volume:
      '{"Name":{{json .Name}},"Labels":{{json .Labels}},"Driver":{{json .Driver}},"Options":{{json .Options}}}',
    network:
      '{"Name":{{json .Name}},"Labels":{{json .Labels}},"Containers":{{json .Containers}},"Driver":{{json .Driver}},"Internal":{{json .Internal}},"Scope":{{json .Scope}}}',
  };
  for (const kind of Object.keys(names)) {
    const all = docker(
      kind === 'container'
        ? ['ps', '-a', '--format', '{{.Names}}']
        : [kind, 'ls', '--format', '{{.Name}}']
    )
      .trim()
      .split('\n')
      .filter(Boolean);
    const labelled = docker(
      kind === 'container'
        ? [
            'ps',
            '-a',
            '--filter',
            `label=com.docker.compose.project=${project}`,
            '--format',
            '{{.Names}}',
          ]
        : [
            kind,
            'ls',
            '--filter',
            `label=com.docker.compose.project=${project}`,
            '--format',
            '{{.Name}}',
          ]
    )
      .trim()
      .split('\n')
      .filter(Boolean);
    if (labelled.some((name) => !names[kind].includes(name)))
      throw new Error('Unexpected project-labelled lab resource');
    for (const name of names[kind].filter((name) => all.includes(name))) {
      const object = JSON.parse(docker([kind, 'inspect', '--format', formats[kind], name]));
      if (object.Labels?.['com.docker.compose.project'] !== project)
        throw new Error('Foreign or unmarked expected-name lab resource');
      objects[kind].push(object);
    }
  }
  const published = [];
  for (const container of objects.container) {
    const service = container.Labels['com.docker.compose.service'];
    const expected = services[service];
    const migration = container.Name === `/${project}-migrate-1`;
    if (
      !expected ||
      typeof container.Id !== 'string' ||
      !/^[a-f0-9]{64}$/.test(container.Id) ||
      (migration ? service !== 'app' : container.Name !== `/${project}-${service}-1`) ||
      container.Labels['com.docker.compose.project.config_files'] !== composePath ||
      container.Labels['com.docker.compose.project.working_dir'] !== dirname(composePath)
    )
      throw new Error('Foreign Compose container');
    if (migration) {
      if (
        container.Labels['com.docker.compose.oneoff'] !== 'True' ||
        JSON.stringify(container.Command) !== JSON.stringify(['bun', 'run', 'db:migrate']) ||
        Object.keys(container.RequestedPorts ?? {}).length ||
        Object.values(container.Ports ?? {}).some((bindings) => bindings?.length)
      )
        throw new Error('Foreign migration container');
    } else if (container.Labels['com.docker.compose.oneoff'] === 'True')
      throw new Error('Unexpected one-off service container');
    if (
      Object.keys(container.Networks ?? {}).some((name) => name !== `${project}_default`) ||
      Object.keys(container.Networks ?? {}).length !== 1 ||
      !objects.network.length
    )
      throw new Error('Container network is outside owned lab');
    if (container.Mounts.length !== 1) throw new Error('Unexpected container mounts');
    const mount = container.Mounts[0];
    if (service === 'app') {
      if (
        mount.Type !== 'bind' ||
        mount.Source !== checkout ||
        mount.Destination !== '/app' ||
        mount.RW
      )
        throw new Error('Wrong source mount');
    } else if (
      mount.Type !== 'volume' ||
      mount.Name !== `${project}_${expected.volume}` ||
      mount.Destination !== expected.destination ||
      !objects.volume.some((volume) => volume.Name === mount.Name)
    )
      throw new Error('Container volume is outside owned lab');
    if (migration) continue;
    const requested = container.RequestedPorts?.[expected.port];
    if (
      Object.keys(container.RequestedPorts ?? {}).length !== 1 ||
      requested?.length !== 1 ||
      requested[0].HostIp !== '127.0.0.1' ||
      requested[0].HostPort !== expected.hostPort
    )
      throw new Error('Unexpected lab publication');
    if (container.Running) {
      const effective = container.Ports?.[expected.port];
      if (
        effective?.length !== 1 ||
        effective[0].HostIp !== '127.0.0.1' ||
        effective[0].HostPort !== expected.hostPort
      )
        throw new Error('Requested loopback publication is not effective');
      published.push(Number(expected.hostPort));
    }
  }
  for (const volume of objects.volume)
    if (volume.Driver !== 'local' || Object.keys(volume.Options ?? {}).length)
      throw new Error('Unexpected lab volume driver/options');
  for (const network of objects.network) {
    if (network.Driver !== 'bridge' || network.Internal || network.Scope !== 'local')
      throw new Error('Lab network must be a dedicated local normal bridge');
    if (
      Object.values(network.Containers ?? {}).some(
        (container) => !names.container.includes(container.Name)
      )
    )
      throw new Error('Foreign container attached to lab network');
  }
  return { ...objects, published };
}
