// POST /api/v1/auth/change-password
// A signed-in user replaces their own password. The current password is the
// re-authentication factor. On success every session of the user ends: all
// refresh tokens are deleted, open WebSockets close with 4001, and this
// response clears the caller's auth cookies so they sign in with the new one.
// API tokens (hf_) are integrations, not sessions: they may not call this
// endpoint and are not revoked by it.
import { db } from '../../../common/db';
import { authenticate, parseBearerToken, parseCookieToken } from '../middlewares/authentication';
import type { AuthenticatedRequest } from '../middlewares/authentication';
import { hashPassword } from '../mods/password/hash';
import { verifyPassword } from '../mods/password/verify';
import { isPasswordStrongEnough, MAX_PASSWORD_LENGTH } from '../mods/password/policy';
import { memCache } from '../../../mods/cache';
import { pubsub } from '../../../mods/pubsub/index';

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_SECONDS = 15 * 60;

type ErrorCode =
  | 'bad-request'
  | 'unauthorized'
  | 'session-required'
  | 'rate-limit-exceeded'
  | 'password-not-set'
  | 'credentials-invalid'
  | 'password-too-weak'
  | 'password-unchanged';

function fail(status: number, code: ErrorCode, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}

// [why] Bun.password.verify throws on a malformed stored hash; treat that as a
// failed verification instead of a 500 that would distinguish the account.
async function matches(password: string, hash: string): Promise<boolean> {
  try {
    return await verifyPassword({ password, hash });
  } catch {
    return false;
  }
}

type Outcome = { ok: true } | { ok: false; status: number; code: ErrorCode; message: string };

export async function handleChangePassword(req: Request): Promise<Response> {
  const authReq = req as AuthenticatedRequest;
  const authError = await authenticate(authReq);
  if (authError) return authError;

  const userId = authReq.currentUser?.id;
  if (!userId) return fail(401, 'unauthorized', 'Unauthorized');

  // Same credential precedence as authenticate(): header first, then cookie.
  const credential = parseBearerToken(req.headers.get('Authorization')) ?? parseCookieToken(req);
  if (credential?.startsWith('hf_')) {
    return fail(403, 'session-required', 'Sign in to change your password');
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'bad-request', 'Invalid JSON body');
  }
  if (typeof body !== 'object' || body === null) {
    return fail(400, 'bad-request', 'currentPassword and newPassword are required');
  }

  const { currentPassword, newPassword } = body as {
    currentPassword?: unknown;
    newPassword?: unknown;
  };
  if (
    typeof currentPassword !== 'string' ||
    typeof newPassword !== 'string' ||
    currentPassword.length === 0 ||
    newPassword.length === 0
  ) {
    return fail(400, 'bad-request', 'currentPassword and newPassword are required');
  }
  if (currentPassword.length > MAX_PASSWORD_LENGTH || newPassword.length > MAX_PASSWORD_LENGTH) {
    return fail(400, 'bad-request', 'Password is too long');
  }
  if (!isPasswordStrongEnough(newPassword)) {
    return fail(
      422,
      'password-too-weak',
      'Password must be at least 8 characters and contain a letter and a number'
    );
  }

  // [why] Counted only once the request will test the current password: that
  // is the guessing surface, and malformed input must not lock the user out.
  const count = memCache.incr(`rl:change-password:${userId}`, RATE_LIMIT_WINDOW_SECONDS);
  if (count > RATE_LIMIT_MAX) {
    return fail(429, 'rate-limit-exceeded', 'Too many password change attempts. Try again later.');
  }

  // Hash before taking the row lock so the lock is held for verification only.
  const newHash = await hashPassword({ password: newPassword });

  // [why] The row lock makes verify-then-write atomic: a concurrent change or
  // reset that commits first is re-read here, so the stale password fails.
  const outcome = await db.transaction(async (trx): Promise<Outcome> => {
    const user: { id: string; password_hash: string | null } | undefined = await trx('users')
      .where({ id: userId })
      .forUpdate()
      .first('id', 'password_hash');

    if (!user) return { ok: false, status: 401, code: 'unauthorized', message: 'Unauthorized' };
    if (!user.password_hash) {
      return {
        ok: false,
        status: 409,
        code: 'password-not-set',
        message: 'This account has no password. Use "Forgot password" to set one.',
      };
    }
    if (!(await matches(currentPassword, user.password_hash))) {
      return {
        ok: false,
        status: 401,
        code: 'credentials-invalid',
        message: 'Current password is incorrect',
      };
    }
    if (await matches(newPassword, user.password_hash)) {
      return {
        ok: false,
        status: 422,
        code: 'password-unchanged',
        message: 'New password must be different from the current password',
      };
    }

    await trx('users').where({ id: userId }).update({
      password_hash: newHash,
      // A pending emailed reset link must not outlive the password it was for.
      password_reset_token: null,
      password_reset_token_expires_at: null,
    });
    await trx('refresh_tokens').where({ user_id: userId }).delete();
    return { ok: true };
  });

  if (!outcome.ok) return fail(outcome.status, outcome.code, outcome.message);

  // Close every open WebSocket of this user (code 4001), as reset-password does.
  await pubsub.publish(`session:${userId}`, JSON.stringify({ type: 'session_revoked' }));

  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  headers.append(
    'Set-Cookie',
    'refresh_token=; HttpOnly; Path=/api/v1/auth/refresh; SameSite=Strict; Secure; Max-Age=0'
  );
  headers.append(
    'Set-Cookie',
    'access_token=; HttpOnly; Path=/; SameSite=Strict; Secure; Max-Age=0'
  );

  return new Response(JSON.stringify({ data: { changed: true } }), { status: 200, headers });
}
