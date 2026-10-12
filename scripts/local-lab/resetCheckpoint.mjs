import {
  openSync,
  closeSync,
  fsyncSync,
  writeFileSync,
  linkSync,
  unlinkSync,
  renameSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const generatedFiles = Object.freeze([
  'credentials.json',
  'smoke-result.json',
  'browser-result.json',
  'smoke-attachment.txt',
  'browser-smoke.png',
  'app-start.json',
  'migration-pending.json',
]);
const id = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) =>
  object(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : object(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])])
        )
      : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const labels = (value, project) =>
  object(value) &&
  value['com.docker.compose.project'] === project &&
  Object.values(value).every((entry) => typeof entry === 'string');
export function volumeSnapshot(volume) {
  return {
    Name: volume.Name,
    CreatedAt: volume.CreatedAt,
    Labels: volume.Labels,
    Driver: volume.Driver,
    Options: volume.Options ?? {},
  };
}
export function checkpointFor(binding, resources) {
  const checkpoint = {
    version: 1,
    binding,
    containers: resources.container.map(({ Id, Name }) => ({ Id, Name })),
    networks: resources.network.map(({ Id, Name }) => ({ Id, Name })),
    volumes: resources.volume.map(volumeSnapshot),
    generated: [...generatedFiles],
  };
  validateCheckpoint(checkpoint, binding);
  return checkpoint;
}
export function validateCheckpoint(value, binding) {
  const project = binding.project;
  const containerNames = ['app', 'postgres', 'redis', 'localstack', 'migrate'].map(
    (name) => `/${project}-${name}-1`
  );
  if (
    !keys(value, ['version', 'binding', 'containers', 'networks', 'volumes', 'generated']) ||
    value.version !== 1 ||
    !keys(value.binding, Object.keys(binding)) ||
    !equal(value.binding, binding) ||
    !equal(value.generated, generatedFiles) ||
    !Array.isArray(value.containers) ||
    value.containers.length > 5 ||
    !Array.isArray(value.networks) ||
    value.networks.length !== 1 ||
    !Array.isArray(value.volumes) ||
    value.volumes.length < 1 ||
    value.volumes.length > 3
  )
    throw new Error('Invalid or unbound reset checkpoint');
  for (const [entries, names] of [
    [value.containers, containerNames],
    [value.networks, [`${project}_default`]],
  ]) {
    if (
      entries.some(
        (entry) => !keys(entry, ['Id', 'Name']) || !id(entry.Id) || !names.includes(entry.Name)
      ) ||
      new Set(entries.map((entry) => entry.Id)).size !== entries.length ||
      new Set(entries.map((entry) => entry.Name)).size !== entries.length
    )
      throw new Error('Invalid reset resource identities');
  }
  if (!value.containers.some((entry) => entry.Name === `/${project}-postgres-1`))
    throw new Error('Reset checkpoint lacks marker-verified Postgres');
  const volumeNames = ['postgres', 'redis', 's3'].map((name) => `${project}_${name}`);
  if (
    !value.volumes.some((entry) => entry.Name === `${project}_postgres`) ||
    new Set(value.volumes.map((entry) => entry.Name)).size !== value.volumes.length ||
    value.volumes.some(
      (entry) =>
        !keys(entry, ['Name', 'CreatedAt', 'Labels', 'Driver', 'Options']) ||
        !volumeNames.includes(entry.Name) ||
        typeof entry.CreatedAt !== 'string' ||
        !Number.isFinite(Date.parse(entry.CreatedAt)) ||
        !labels(entry.Labels, project) ||
        entry.Driver !== 'local' ||
        !object(entry.Options) ||
        Object.keys(entry.Options).length
    )
  )
    throw new Error('Invalid reset volume snapshot');
  return value;
}
export function validateSubset(checkpoint, resources) {
  for (const [kind, saved] of [
    ['container', checkpoint.containers],
    ['network', checkpoint.networks],
  ])
    for (const current of resources[kind])
      if (!saved.some((entry) => entry.Name === current.Name && entry.Id === current.Id))
        throw new Error('Reset resource replaced or outside authorized snapshot');
  for (const current of resources.volume) {
    const saved = checkpoint.volumes.find((entry) => entry.Name === current.Name);
    if (!saved || !equal(saved, volumeSnapshot(current)))
      throw new Error('Reset volume replaced or attributes changed');
  }
  return resources;
}
export function atomicPrivateJson(
  state,
  name,
  value,
  exclusive = false,
  discardPublishedOnFailure = false
) {
  const temporary = resolve(state, `.lab-${randomUUID()}.tmp`);
  const destination = resolve(state, name);
  let fd;
  let failure;
  let published = false;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (exclusive)
      linkSync(temporary, destination); // Atomic publication that cannot overwrite pending authority.
    else renameSync(temporary, destination);
    published = true;
    const directory = openSync(state, 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch (error) {
    failure = error;
    if (published && discardPublishedOnFailure && !exclusive) {
      try {
        unlinkSync(destination);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') failure = cleanupError;
      }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (error.code !== 'ENOENT') failure ??= error;
    }
  }
  if (failure) throw failure;
}
