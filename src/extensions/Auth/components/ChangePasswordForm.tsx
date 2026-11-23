// ChangePasswordForm — embedded in the profile settings page.
// Submits POST /api/v1/auth/change-password. Success ends every session of the
// user (including this one), so the page goes to the login screen with a notice.
import { useState } from 'react';
import { authApi } from '../api/auth';
import { clearAuth } from '../duck/authDuck';
import translations from '../translations/en.json';
import { cancelAuthRecovery, expectSessionEnd } from '~/common/api/client';
import { useAppDispatch } from '~/hooks/useAppDispatch';
import Button from '~/common/components/Button';
import Input from '~/common/components/Input';
import Spinner from '~/common/components/Spinner';

const t = translations.changePassword;

export const PASSWORD_CHANGED_REASON = 'password_changed';

// Mirrors the server rule (mods/password/policy.ts); the server stays authoritative.
function isStrongEnough(password: string): boolean {
  return password.length >= 8 && /[a-zA-Z]/.test(password) && /[0-9]/.test(password);
}

const ERROR_MESSAGES: Record<string, string> = {
  'credentials-invalid': t.incorrect,
  'password-too-weak': t.tooWeak,
  'password-unchanged': t.unchanged,
  'password-not-set': t.notSet,
  'rate-limit-exceeded': t.rateLimited,
};

export default function ChangePasswordForm() {
  const dispatch = useAppDispatch();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);

    if (newPassword !== confirmPassword) {
      setError(t.mismatch);
      return;
    }
    if (!isStrongEnough(newPassword)) {
      setError(t.tooWeak);
      return;
    }
    if (newPassword === currentPassword) {
      setError(t.unchanged);
      return;
    }

    setSubmitting(true);
    // [why] The server closes this tab's WebSocket (4001) as part of success;
    // whichever arrives first must land on the same "password changed" notice.
    expectSessionEnd(PASSWORD_CHANGED_REASON);
    try {
      await authApi.changePassword({ currentPassword, newPassword });
    } catch (err: unknown) {
      expectSessionEnd(null);
      const code = apiErrorCode(err);
      setError((code && ERROR_MESSAGES[code]) ?? t.failed);
      setSubmitting(false);
      return;
    }

    cancelAuthRecovery();
    dispatch(clearAuth());
    // Full navigation: drops the realtime socket and all in-memory state.
    window.location.assign(`/login?reason=${PASSWORD_CHANGED_REASON}`);
  };

  return (
    <form
      onSubmit={(e) => {
        void handleSubmit(e);
      }}
      className="space-y-4"
      noValidate
    >
      <h2 className="text-lg font-semibold text-base">{t.title}</h2>
      <p className="text-sm text-muted">{t.hint}</p>

      <Input
        id="currentPasswordChange"
        label={t.currentPassword}
        type="password"
        autoComplete="current-password"
        required
        value={currentPassword}
        onChange={(e) => {
          setCurrentPassword(e.target.value);
        }}
        className="w-full"
      />

      <Input
        id="newPassword"
        label={t.newPassword}
        type="password"
        autoComplete="new-password"
        required
        minLength={8}
        value={newPassword}
        onChange={(e) => {
          setNewPassword(e.target.value);
        }}
        className="w-full"
      />

      <Input
        id="confirmNewPassword"
        label={t.confirmPassword}
        type="password"
        autoComplete="new-password"
        required
        value={confirmPassword}
        onChange={(e) => {
          setConfirmPassword(e.target.value);
        }}
        className="w-full"
      />

      {error && (
        <p role="alert" className="text-danger text-sm">
          {error}
        </p>
      )}

      <Button
        type="submit"
        disabled={submitting || !currentPassword || !newPassword || !confirmPassword}
        className="gap-2"
      >
        {submitting && <Spinner size="sm" className="text-white" />}
        {submitting ? t.submitting : t.submit}
      </Button>
    </form>
  );
}

// ---------- Helpers ----------

function apiErrorCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null || !('response' in err)) return null;
  const response = (err as { response?: { data?: { error?: { code?: unknown } } } }).response;
  const code = response?.data?.error?.code;
  return typeof code === 'string' ? code : null;
}
