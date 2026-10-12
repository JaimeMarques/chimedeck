import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  guardEnvironment,
  guardSource,
  localDockerHost,
  inspectOwnedResources,
} from './labGuards.mjs';

test('all loader candidates refuse without deleting source files; templates stay allowed', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'chimedeck-env-guard-'));
  try {
    await writeFile(resolve(directory, '.env.example'), 'TEMPLATE=true');
    await writeFile(resolve(directory, '.env.production.example'), 'TEMPLATE=true');
    guardEnvironment(directory);
    for (const name of [
      '.env',
      '.env.local',
      '.env.development',
      '.env.development.local',
      '.env.production',
      '.env.test.local',
      '.env.custom',
    ]) {
      await writeFile(resolve(directory, name), 'SYNTHETIC=true');
      assert.throws(() => guardEnvironment(directory), /Loader environment file/);
      await rm(resolve(directory, name));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('remote Docker endpoints reject before any Docker invocation', () => {
  for (const value of [
    'tcp://remote.invalid:2375',
    'ssh://remote.invalid',
    'https://remote.invalid',
    'unix:///socket?context=remote',
  ])
    assert.throws(() => localDockerHost(value), /local Unix/);
});
test('protected working index untracked and rename paths refuse; MCP-only development remains allowed', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'chimedeck-source-guard-'));
  try {
    for (const record of [
      ' M package.json\0',
      'M  bun.lock\0',
      '?? db/migrations/new.ts\0',
      ' M server/config/env.ts\0',
      ' M vite.config.ts\0',
      '?? scripts/local-lab/compose.yml\0',
      'R  server/extensions/mcp/new.ts\0package.json\0',
    ])
      assert.throws(() => guardSource(directory, () => record), /Protected source/);
    assert.throws(
      () => guardSource(directory, () => ' M server/extensions/mcp/tools/getCard.ts\0'),
      /Protected source/
    );
    guardSource(
      directory,
      () => ' M server/extensions/mcp/tools/getCard.ts\0?? server/extensions/mcp/new.test.ts\0',
      true
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('exact expected-name foreign volumes networks and containers refuse independently of labels', () => {
  const project = 'chimedeck-compact-lab';
  for (const [kind, name] of [
    ['volume', `${project}_s3`],
    ['network', `${project}_default`],
    ['container', `${project}-postgres-1`],
  ]) {
    const calls = [];
    const docker = (args) => {
      calls.push(args);
      if (args.includes('inspect')) return JSON.stringify({ Name: name, Labels: {} });
      if (args.includes('--filter')) return '';
      if (kind === 'container' ? args[0] === 'ps' : args[0] === kind) return `${name}\n`;
      return '';
    };
    assert.throws(
      () =>
        inspectOwnedResources(
          docker,
          project,
          '/selected',
          '/selected/scripts/local-lab/compose.yml'
        ),
      /Foreign or unmarked/
    );
    assert.ok(calls.some((args) => args.includes('inspect')));
    assert.ok(
      calls.every(
        (args) =>
          !['up', 'down', 'rm', 'create', 'start', 'stop'].some((word) => args.includes(word))
      )
    );
  }
});
