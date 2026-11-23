## New

- Signed-in users can change their own password from **Settings → Profile → Change password** (current password, new password, confirmation). New endpoint `POST /api/v1/auth/change-password`.
- The current password is re-verified under a row lock, so two racing changes cannot both succeed. The new password follows the reset-password rule (at least 8 characters, a letter and a digit) and must differ from the current one.
- Success ends every session of the user: all refresh tokens are deleted, open WebSockets close with 4001, the caller's auth cookies are cleared and any pending emailed reset link is invalidated. The browser lands on the login page with a "password changed" notice.
- The login page now shows the notice passed by reset-password and confirm-email-change (previously dropped) and a neutral notice after a forced sign-out.

## Security notes

- API tokens (`hf_…`) cannot call the endpoint (403 `session-required`) and are not revoked by it; they are integrations, not sessions.
- Attempts that test the current password are limited to 5 per user per 15 minutes (in-process counter, like the other auth limits). Malformed requests do not consume the budget.
- Access JWTs already issued to other devices are stateless and remain valid until they expire (`ACCESS_TOKEN_TTL_SECONDS`), the same as after reset-password. Their refresh tokens are gone and their realtime connection is closed immediately.

## Tests

- `tests/db/changePassword.ts` (real PostgreSQL, run in the `board-members` CI job): authentication boundaries, validation, success side effects, login with old/new password, router mounting, password-less accounts, a concurrent-change race and the rate limit.
