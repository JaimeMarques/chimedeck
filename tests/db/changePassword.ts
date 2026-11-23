// Real PostgreSQL regression for POST /api/v1/auth/change-password.
// Run only against a disposable, fully migrated sandbox DB, with JWT keys set:
//   CHIMEDECK_TEST_SANDBOX=1 DATABASE_URL=postgres://.../chimedeck_test \
//   JWT_PRIVATE_KEY=... JWT_PUBLIC_KEY=... bun run tests/db/changePassword.ts
// Never import the app's shared DB before validating the target: this script writes fixtures.
// Every assertion reads state back out of the database or the real handlers.
import { strict as assert } from 'node:assert';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const databaseUrl = Bun.env.DATABASE_URL;
assert.equal(
  Bun.env.CHIMEDECK_TEST_SANDBOX,
  '1',
  'Explicit CHIMEDECK_TEST_SANDBOX=1 opt-in required'
);
assert.ok(databaseUrl, 'DATABASE_URL must point to a disposable PostgreSQL database');
const url = new URL(databaseUrl);
const databaseName = decodeURIComponent(url.pathname.slice(1));
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'PostgreSQL URL required');
assert.match(
  databaseName,
  /(?:^|[_-])(test|preflight|scratch|sandbox)(?:$|[_-])/i,
  'Refusing to write to a database without a test/preflight/scratch/sandbox name'
);
assert.ok(
  ['localhost', '127.0.0.1', 'postgres', 'db'].includes(url.hostname),
  'Refusing non-local PostgreSQL host'
);

const { db } = await import('../../server/common/db');
const { handleChangePassword } = await import('../../server/extensions/auth/api/changePassword');
const { handleLogin } = await import('../../server/extensions/auth/api/login');
const { authRouter } = await import('../../server/extensions/auth/api/index');
const { issueAccessToken } = await import('../../server/extensions/auth/mods/token/issue');
const { hashPassword } = await import('../../server/extensions/auth/mods/password/hash');
const { verifyPassword } = await import('../../server/extensions/auth/mods/password/verify');
const { pubsub } = await import('../../server/mods/pubsub/index');

const OLD = 'old-Password-1';
const NEW = 'new-Password-2';
const tag = randomUUID().slice(0, 8);
const createdUsers: string[] = [];

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.info(
    `${ok ? 'PASS' : 'FAIL'}  ${label} — got ${String(actual)}, want ${String(expected)}`
  );
}

async function createUser(
  name: string,
  password: string | null
): Promise<{ id: string; email: string }> {
  const id = `user-${randomUUID()}`;
  const email = `${name}-${tag}@example.test`;
  await db('users').insert({
    id,
    email,
    name,
    password_hash: password ? await hashPassword({ password }) : null,
    email_verified: true,
    password_reset_token: `reset-${randomUUID()}`,
    password_reset_token_expires_at: new Date(Date.now() + 3600_000),
  });
  createdUsers.push(id);
  return { id, email };
}

async function addRefreshTokens(userId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await db('refresh_tokens').insert({
      id: randomUUID(),
      user_id: userId,
      token: randomBytes(32).toString('hex'),
      expires_at: new Date(Date.now() + 86_400_000),
      created_at: new Date(),
    });
  }
}

async function refreshCount(userId: string): Promise<number> {
  const row = (await db('refresh_tokens').where({ user_id: userId }).count({ n: '*' }).first()) as {
    n: string | number;
  };
  return Number(row.n);
}

async function passwordHash(userId: string): Promise<string | null> {
  const row: { password_hash: string | null } = await db('users')
    .where({ id: userId })
    .first('password_hash');
  return row.password_hash;
}

async function bearer(user: { id: string; email: string }): Promise<string> {
  return `Bearer ${await issueAccessToken({ sub: user.id, email: user.email })}`;
}

function changeRequest(authorization: string | null, body: unknown): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (authorization) headers['Authorization'] = authorization;
  return new Request('https://example.test/api/v1/auth/change-password', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function code(res: Response): Promise<string> {
  const json = (await res.json()) as { error?: { code?: string } };
  return json.error?.code ?? '(none)';
}

async function outcome(res: Response): Promise<string> {
  return `${String(res.status)} ${await code(res)}`;
}

async function login(email: string, password: string): Promise<number> {
  const res = await handleLogin(
    new Request('https://example.test/api/v1/auth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.9.${tag}` },
      body: JSON.stringify({ email, password }),
    })
  );
  return res.status;
}

try {
  // --- Authentication boundaries -------------------------------------------
  const alice = await createUser('alice', OLD);
  await addRefreshTokens(alice.id, 2);
  const aliceHash = await passwordHash(alice.id);

  const anon = await handleChangePassword(
    changeRequest(null, { currentPassword: OLD, newPassword: NEW })
  );
  check('no credentials → 401', anon.status, 401);

  const rawApiToken = `hf_${randomBytes(24).toString('hex')}`;
  await db('api_tokens').insert({
    id: randomUUID(),
    user_id: alice.id,
    name: 'integration',
    token_hash: createHash('sha256').update(rawApiToken).digest('hex'),
    token_prefix: rawApiToken.slice(0, 10),
  });
  const viaApiToken = await handleChangePassword(
    changeRequest(`Bearer ${rawApiToken}`, { currentPassword: OLD, newPassword: NEW })
  );
  check('API token → 403', viaApiToken.status, 403);
  check('API token → session-required', await code(viaApiToken), 'session-required');
  check('API token attempt leaves hash', await passwordHash(alice.id), aliceHash);

  // --- Validation ------------------------------------------------------------
  const aliceAuth = await bearer(alice);
  const badJson = await handleChangePassword(changeRequest(aliceAuth, '{not json'));
  check('bad JSON → 400', badJson.status, 400);

  const missing = await handleChangePassword(changeRequest(aliceAuth, { currentPassword: OLD }));
  check('missing newPassword → 400', missing.status, 400);

  const wrong = await handleChangePassword(
    changeRequest(aliceAuth, { currentPassword: 'not-the-password-9', newPassword: NEW })
  );
  check('wrong current → 401', wrong.status, 401);
  check('wrong current → credentials-invalid', await code(wrong), 'credentials-invalid');
  check('wrong current leaves hash', await passwordHash(alice.id), aliceHash);
  check('wrong current keeps refresh tokens', await refreshCount(alice.id), 2);

  const weak = await handleChangePassword(
    changeRequest(aliceAuth, { currentPassword: OLD, newPassword: 'short1' })
  );
  check('weak new → 422 password-too-weak', await outcome(weak), '422 password-too-weak');

  const same = await handleChangePassword(
    changeRequest(aliceAuth, { currentPassword: OLD, newPassword: OLD })
  );
  check('same password → 422 password-unchanged', await outcome(same), '422 password-unchanged');
  check('rejections leave hash', await passwordHash(alice.id), aliceHash);

  // --- Success ---------------------------------------------------------------
  const bob = await createUser('bob', OLD);
  await addRefreshTokens(bob.id, 1);

  let revoked = 0;
  await pubsub.subscribe(`session:${alice.id}`, (msg) => {
    if ((JSON.parse(msg) as { type?: string }).type === 'session_revoked') revoked += 1;
  });

  const ok = await handleChangePassword(
    changeRequest(aliceAuth, { currentPassword: OLD, newPassword: NEW })
  );
  check('valid change → 200', ok.status, 200);
  const cookies = ok.headers.getSetCookie();
  check(
    'clears refresh cookie',
    cookies.some((c) => c.startsWith('refresh_token=;') && c.includes('Max-Age=0')),
    true
  );
  check(
    'clears access cookie',
    cookies.some((c) => c.startsWith('access_token=;') && c.includes('Max-Age=0')),
    true
  );
  check('no-store', ok.headers.get('Cache-Control'), 'no-store');
  check('session_revoked published once', revoked, 1);
  await pubsub.unsubscribe(`session:${alice.id}`);

  const newHash = await passwordHash(alice.id);
  check(
    'new password verifies',
    await verifyPassword({ password: NEW, hash: newHash ?? '' }),
    true
  );
  check(
    'old password no longer verifies',
    await verifyPassword({ password: OLD, hash: newHash ?? '' }),
    false
  );
  check('all refresh tokens of user deleted', await refreshCount(alice.id), 0);
  check('other user refresh tokens untouched', await refreshCount(bob.id), 1);
  const resetRow: { password_reset_token: string | null } = await db('users')
    .where({ id: alice.id })
    .first('password_reset_token');
  check('pending reset link invalidated', resetRow.password_reset_token, null);
  check(
    'API token survives',
    (await db('api_tokens').where({ user_id: alice.id }).first()) !== undefined,
    true
  );

  check('login with old password → 401', await login(alice.email, OLD), 401);
  check('login with new password → 200', await login(alice.email, NEW), 200);

  // --- Routed through the real auth router ------------------------------------
  const routed = await authRouter(
    changeRequest(await bearer(alice), { currentPassword: NEW, newPassword: 'third-Password-3' }),
    '/api/v1/auth/change-password'
  );
  check('router mounts POST /api/v1/auth/change-password', routed?.status, 200);
  const getRouted = await authRouter(
    new Request('https://example.test/api/v1/auth/change-password'),
    '/api/v1/auth/change-password'
  );
  check('router ignores GET', getRouted, null);

  // --- Account without a password ----------------------------------------------
  const oauth = await createUser('oauth', null);
  const noPw = await handleChangePassword(
    changeRequest(await bearer(oauth), { currentPassword: OLD, newPassword: NEW })
  );
  check('no password set → 409 password-not-set', await outcome(noPw), '409 password-not-set');
  check('no password set stays null', await passwordHash(oauth.id), null);

  // --- Concurrency: one current password, two racing changes ---------------------
  const carol = await createUser('carol', OLD);
  const carolAuth = await bearer(carol);
  const [r1, r2] = await Promise.all([
    handleChangePassword(
      changeRequest(carolAuth, { currentPassword: OLD, newPassword: 'race-Password-A1' })
    ),
    handleChangePassword(
      changeRequest(carolAuth, { currentPassword: OLD, newPassword: 'race-Password-B2' })
    ),
  ]);
  const statuses = [r1.status, r2.status].sort().join(',');
  check('racing changes → exactly one wins', statuses, '200,401');
  const carolHash = (await passwordHash(carol.id)) ?? '';
  const winner = r1.status === 200 ? 'race-Password-A1' : 'race-Password-B2';
  check(
    'stored hash is the winner',
    await verifyPassword({ password: winner, hash: carolHash }),
    true
  );

  // --- Rate limit -----------------------------------------------------------------
  const dave = await createUser('dave', OLD);
  const daveAuth = await bearer(dave);
  const attempts: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    const res = await handleChangePassword(
      changeRequest(daveAuth, { currentPassword: `wrong-guess-${String(i)}x`, newPassword: NEW })
    );
    attempts.push(res.status);
  }
  check(
    'attempts 1-5 evaluated',
    attempts.slice(0, 5).every((s) => s === 401),
    true
  );
  check('attempt 6 → 429', attempts[5], 429);
  check(
    'rate-limited user keeps hash',
    await verifyPassword({ password: OLD, hash: (await passwordHash(dave.id)) ?? '' }),
    true
  );
} finally {
  await db('api_tokens').whereIn('user_id', createdUsers).delete();
  await db('refresh_tokens').whereIn('user_id', createdUsers).delete();
  await db('users').whereIn('id', createdUsers).delete();
  await db.destroy();
}

if (failures > 0) {
  console.error(`${String(failures)} assertion(s) failed`);
  process.exit(1);
}
console.info('All change-password checks passed');
