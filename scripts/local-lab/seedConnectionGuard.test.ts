import { expect, test } from 'bun:test';
import Knex from 'knex';
import { Client } from 'pg';
import { fileURLToPath } from 'node:url';

const labUrl = 'postgresql://chimedeck_lab:synthetic-password@127.0.0.1:35432/chimedeck_lab';
const seedPath = fileURLToPath(new URL('./seed.ts', import.meta.url));

// Exercise the real seed entry point, but stop at Knex construction. The child
// process isolates the module mock from other tests and can never open a socket.
function seedGuard(databaseUrl: string) {
  const script = `
    import { mock } from 'bun:test';
    let knexCalls = 0;
    let connection;
    mock.module('knex', () => ({ default: (config) => {
      knexCalls++;
      connection = config.connection;
      throw new Error('Stopped before database access');
    } }));
    try {
      await import(${JSON.stringify(seedPath)});
      throw new Error('Seed unexpectedly completed');
    } catch (error) {
      console.log(JSON.stringify({ error: error.message, knexCalls, connection }));
    }
  `;
  const result = Bun.spawnSync([process.execPath, '--eval', script], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      LAB_MARKER: 'synthetic-test-marker',
      LAB_STATE: '/nonexistent-synthetic-seed-test-state',
    },
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe('');
  return JSON.parse(result.stdout.toString()) as {
    error: string;
    knexCalls: number;
    connection?: string;
  };
}

async function effectiveConnection(connection: string) {
  // Real Knex and pg parsing, with pooling disabled and no Client.connect().
  const db = Knex({ client: 'pg', connection, pool: { min: 0, max: 0 } });
  try {
    // pg does not publish this runtime property in its TypeScript declarations.
    return (
      new Client(db.client.connectionSettings) as Client & {
        connectionParameters: {
          host: string;
          port: number;
          user: string;
          database: string;
          password: string;
        };
      }
    ).connectionParameters;
  } finally {
    await db.destroy();
  }
}

test('refuses a host query override before Knex construction', async () => {
  const attack = `${labUrl}?host=remote.example.test`;
  expect(new URL(attack).hostname).toBe('127.0.0.1');
  expect((await effectiveConnection(attack)).host).toBe('remote.example.test');

  const result = seedGuard(attack);
  expect(result.error).toBe('Refusing non-lab seed');
  expect(result.knexCalls).toBe(0);
});

test('refuses a socket protocol deviation before Knex construction', async () => {
  const attack = labUrl.replace('postgresql:', 'socket:');
  expect(new URL(attack).hostname).toBe('127.0.0.1');
  expect((await effectiveConnection(attack)).host).toBe('127.0.0.1');

  const result = seedGuard(attack);
  expect(result.error).toBe('Refusing non-lab seed');
  expect(result.knexCalls).toBe(0);
});

for (const [query, expected] of [
  ['port=5432', { port: 5432 }],
  ['user=external_user', { user: 'external_user' }],
  ['host=%2Fsynthetic-socket', { host: '/synthetic-socket' }],
  [
    `connectionString=${encodeURIComponent('postgresql://external_user:synthetic@remote.example.test:5432/external_db')}`,
    { host: 'remote.example.test', port: 5432, user: 'external_user', database: 'external_db' },
  ],
] as const) {
  test(`refuses effective PostgreSQL override ${query}`, async () => {
    const attack = `${labUrl}?${query}`;
    expect(await effectiveConnection(attack)).toMatchObject(expected);
    const result = seedGuard(attack);
    expect(result.error).toBe('Refusing non-lab seed');
    expect(result.knexCalls).toBe(0);
  });
}

for (const query of ['database=external_db', 'sslmode=require', '%68ost=remote.example.test']) {
  test(`refuses any nonempty query ${query}`, () => {
    const result = seedGuard(`${labUrl}?${query}`);
    expect(result.error).toBe('Refusing non-lab seed');
    expect(result.knexCalls).toBe(0);
  });
}

for (const protocol of ['https:', 'mysql:']) {
  test(`refuses non-PostgreSQL protocol ${protocol}`, () => {
    const result = seedGuard(labUrl.replace('postgresql:', protocol));
    expect(result.error).toBe('Refusing non-lab seed');
    expect(result.knexCalls).toBe(0);
  });
}

for (const protocol of ['postgresql:', 'postgres:']) {
  test(`accepts the synthetic controller URL with ${protocol}`, async () => {
    const validUrl = labUrl.replace('postgresql:', protocol);
    const result = seedGuard(validUrl);
    expect(result.error).toBe('Stopped before database access');
    expect(result.knexCalls).toBe(1);
    expect(result.connection).toBe(validUrl);
    expect(await effectiveConnection(result.connection!)).toMatchObject({
      host: '127.0.0.1',
      port: 35432,
      user: 'chimedeck_lab',
      database: 'chimedeck_lab',
      password: 'synthetic-password',
    });
  });
}
