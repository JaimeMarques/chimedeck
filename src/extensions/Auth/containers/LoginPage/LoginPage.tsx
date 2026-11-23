import { useEffect } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useAppDispatch } from '~/hooks/useAppDispatch';
import { useAppSelector } from '~/hooks/useAppSelector';
import { loginThunk, selectAuthStatus, selectAuthError } from '../../duck/authDuck';
import LoginForm from '../../components/LoginForm';
import config from '~/config';
import translations from '../../translations/en.json';

// Notices for sessions the server ended; unknown reasons show nothing.
const REASON_NOTICES: Record<string, { text: string; tone: 'success' | 'info' }> = {
  password_changed: { text: translations.loginPage.passwordChanged, tone: 'success' },
  session_expired: { text: translations.loginPage.sessionEnded, tone: 'info' },
};

export default function LoginPage() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const status = useAppSelector(selectAuthStatus);
  const apiError = useAppSelector(selectAuthError);

  // [why] Reset-password and confirm-email-change navigate here with a toast in
  // router state; password change and forced logouts arrive with ?reason=.
  const stateToast = (location.state as { toast?: unknown } | null)?.toast;
  const reason = searchParams.get('reason');
  const notice =
    typeof stateToast === 'string'
      ? { text: stateToast, tone: 'success' as const }
      : reason
        ? REASON_NOTICES[reason]
        : undefined;

  // Redirect on successful login
  useEffect(() => {
    if (status === 'authenticated') {
      navigate('/workspaces', { replace: true });
    }
  }, [status, navigate]);

  const handleSubmit = async (email: string, password: string) => {
    await dispatch(loginThunk({ email, password }));
  };

  return (
    <main className="min-h-screen bg-bg-base flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-bg-surface border border-border rounded-2xl shadow-2xl p-8">
        {/* Logo */}
        <div className="flex items-center gap-2 mb-8">
          <img
            src="/apple-touch-icon.png"
            alt={translations.appName}
            className="h-7 w-7 rounded-sm object-contain"
          />
          <span className="text-xl font-bold text-base">{translations.appName}</span>
        </div>

        <h1 className="text-2xl font-bold text-base mb-1">{translations.login.title}</h1>
        <p className="text-subtle text-sm mb-6">{translations.login.subtitle}</p>

        {notice && (
          <p
            role="status"
            className={`text-sm mb-6 ${notice.tone === 'success' ? 'text-success' : 'text-muted'}`}
          >
            {notice.text}
          </p>
        )}

        <LoginForm onSubmit={handleSubmit} isLoading={status === 'loading'} apiError={apiError} />

        <p className="text-muted text-sm text-center mt-4">
          <Link to="/forgot-password" className="text-indigo-400 hover:text-indigo-300 font-medium">
            {translations.loginPage.forgotPassword}
          </Link>
        </p>

        <p className="text-muted text-sm text-center mt-4">
          {config.allowPublicAccess ? translations.login.noAccount : 'Belongs to our company?'}{' '}
          <Link to="/signup" className="text-indigo-400 hover:text-indigo-300 font-medium">
            {translations.login.signUp}
          </Link>
        </p>
      </div>
    </main>
  );
}
