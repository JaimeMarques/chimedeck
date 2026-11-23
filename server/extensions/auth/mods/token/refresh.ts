// Rotates a refresh token: marks old token revoked, inserts a new one.
import { randomBytes } from 'crypto';
import { generateId } from '../../../../common/uuid';
import { db } from '../../../../common/db';
import { jwtConfig } from '../../common/config/jwt';

interface RotateResult {
  status: 200 | 401;
  token?: string;
  userId?: string;
  name?: string;
}

// Validates old refresh token, revokes it, and returns a fresh opaque token.
export async function rotateRefreshToken({ token }: { token: string }): Promise<RotateResult> {
  const now = new Date();

  return db.transaction(async (trx): Promise<RotateResult> => {
    const candidate: { user_id: string } | undefined = await trx('refresh_tokens')
      .where({ token })
      .whereNull('revoked_at')
      .where('expires_at', '>', now)
      .first('user_id');

    if (!candidate) {
      return { status: 401, name: 'refresh-token-invalid' };
    }

    // [why] Password change deletes every refresh token while holding this
    // row lock. Taking it here and re-reading the token stops a rotation that
    // read the token before that delete from minting a successor after it.
    // The re-read deliberately ignores revoked_at so two tabs rotating the
    // same cookie keep their previous behaviour.
    await trx('users').where({ id: candidate.user_id }).forUpdate().first('id');
    const row: { id: string; user_id: string } | undefined = await trx('refresh_tokens')
      .where({ token })
      .where('expires_at', '>', now)
      .first('id', 'user_id');

    if (!row) {
      return { status: 401, name: 'refresh-token-invalid' };
    }

    // Revoke the old token.
    await trx('refresh_tokens').where({ id: row.id }).update({ revoked_at: now });

    // Issue a new refresh token.
    const newToken = randomBytes(32).toString('hex');
    const expiresAt = new Date(now.getTime() + jwtConfig.refreshTokenTtlDays * 24 * 60 * 60 * 1000);

    await trx('refresh_tokens').insert({
      id: generateId(),
      user_id: row.user_id,
      token: newToken,
      expires_at: expiresAt,
      created_at: now,
    });

    return { status: 200, token: newToken, userId: row.user_id };
  });
}
