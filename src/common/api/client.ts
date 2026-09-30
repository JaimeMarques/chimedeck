import axios, { isAxiosError, type InternalAxiosRequestConfig } from 'axios';
import { shouldAttachAccessToken, shouldAttemptAuthRecovery } from './requestPolicy';
import type { AuthResponse } from '~/extensions/Auth/api/auth';
import { isRetryableRequestError, RetryableRecoveryError } from './recoveryErrors';

// Token getter is set lazily from main.tsx after the store is created.
// This avoids a circular dependency between the API client and the Redux store.
let tokenGetter: (() => string | null) | null = null;
let clearAuthCallback: (() => void) | null = null;
let refreshRequestPromise: Promise<string> | null = null;
let credentialsCallback: ((credentials: AuthResponse) => void) | null = null;
let authGeneration = 0;
let authRecoveryBlocked = false;
let didHandleSessionExpiry = false;
let authRecoveryCallbacks: {
  onSuspend: () => void;
  canResume: () => boolean;
  onResume: () => void;
} | null = null;
let logoutRequest: { token: string | null; generation: number; promise: Promise<unknown> } | null = null;

export const setTokenGetter = (fn: () => string | null) => {
  tokenGetter = fn;
};

// clearAuth callback is set lazily from main.tsx to avoid circular deps with store.
export const setClearAuthCallback = (fn: () => void) => {
  clearAuthCallback = fn;
};

export const setCredentialsCallback = (fn: (credentials: AuthResponse) => void) => {
  credentialsCallback = fn;
};

export class AuthRecoveryCancelledError extends Error {}

export function setAuthRecoveryCallbacks(callbacks: NonNullable<typeof authRecoveryCallbacks>) {
  authRecoveryCallbacks = callbacks;
}

export function cancelAuthRecovery() {
  const previousToken = tokenGetter?.() ?? null;
  const previouslyBlocked = authRecoveryBlocked;
  authRecoveryBlocked = true;
  authGeneration++;
  const generation = authGeneration;
  refreshRequestPromise = null;
  authRecoveryCallbacks?.onSuspend();
  // [why] A failed logout can restore its unchanged session, never its old refresh.
  return () => {
    if (previouslyBlocked || !previousToken || generation !== authGeneration
      || tokenGetter?.() !== previousToken || authRecoveryCallbacks?.canResume() === false) return;
    authRecoveryBlocked = false;
    authRecoveryCallbacks?.onResume();
  };
}

/** Only a newly established validated session can undo explicit logout/revocation. */
export function allowAuthRecovery() {
  if (authRecoveryBlocked) authGeneration++;
  authRecoveryBlocked = false;
  didHandleSessionExpiry = false;
}

/** A same-session double click shares one cancellation and one DELETE. */
export function logoutCurrentSession(): Promise<unknown> {
  const token = tokenGetter?.() ?? null;
  if (logoutRequest?.token === token && logoutRequest.generation === authGeneration) return logoutRequest.promise;
  const restoreAfterFailure = cancelAuthRecovery();
  const generation = authGeneration;
  const promise = apiClient.delete('/auth/session').catch((error: unknown) => {
    // [why] The logout thunk retains auth only for an explicit non-401 response.
    // Network/no-response failures intentionally complete local logout.
    if (isAxiosError(error) && error.response && error.response.status !== 401) restoreAfterFailure();
    throw error;
  }).finally(() => {
    if (logoutRequest?.promise === promise) logoutRequest = null;
  });
  logoutRequest = { token, generation, promise };
  return promise;
}

/** Shared renewal for HTTP expiry and WebSocket expiry; never changes auth to loading. */
export function renewAccessToken(): Promise<string> {
  if (refreshRequestPromise) return refreshRequestPromise;
  const generation = authGeneration;
  const previousToken = tokenGetter?.() ?? null;
  if (authRecoveryBlocked) return Promise.reject(new AuthRecoveryCancelledError('Session already ended'));
  const request = apiClient.post<unknown, { data: unknown }>('/auth/refresh')
    .then((response) => {
      if (generation !== authGeneration || authRecoveryBlocked || (tokenGetter?.() ?? null) !== previousToken) {
        throw new AuthRecoveryCancelledError('Session changed during renewal');
      }
      const credentials = response.data;
      if (!isAuthResponse(credentials)) {
        throw new Error('Invalid session renewal response');
      }
      credentialsCallback?.(credentials);
      didHandleSessionExpiry = false;
      return credentials.accessToken;
    }).catch((error: unknown) => {
      if (generation !== authGeneration || authRecoveryBlocked || (tokenGetter?.() ?? null) !== previousToken) {
        throw new AuthRecoveryCancelledError('Session changed during renewal');
      }
      if (isRetryableRequestError(error)) throw new RetryableRecoveryError('Session renewal temporarily unavailable');
      throw error;
    }).finally(() => {
      if (refreshRequestPromise === request) refreshRequestPromise = null;
    });
  refreshRequestPromise = request;
  return request;
}

// Single axios instance used by all extension API modules.
// baseURL uses the Vite proxy so /api/v1 routes resolve to the Bun server.
export const apiClient = axios.create({
  baseURL: '/api/v1',
  headers: { 'Content-Type': 'application/json' },
});

// Attach Bearer token from Redux on every request.
// [why] If a caller already sets Authorization (e.g. plugin JWT for plugin-data endpoints)
// we must not overwrite it — their explicitly-passed token takes precedence.
// Public endpoints must also stay header-free so stale client auth state does not
// make them behave like protected routes.
apiClient.interceptors.request.use((config) => {
  const token = tokenGetter?.() ?? null;
  if (token && !config.headers.Authorization && shouldAttachAccessToken({ url: config.url, method: config.method })) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Auto-unwrap axios response so callers receive the HTTP response body directly.
// This matches the declared API function signatures: Promise<T> not Promise<AxiosResponse<T>>.
// eslint-disable-next-line @typescript-eslint/no-unsafe-return
apiClient.interceptors.response.use((response) => response.data);

apiClient.interceptors.response.use(
  (response) => response,
  async (error: unknown) => {
    if (!isAxiosErrorLike(error)) {
      throw toError(error);
    }

    const originalRequest = error.config as (InternalAxiosRequestConfig & { _retry?: boolean }) | undefined;
    const shouldRecover = isExpiredAccessTokenError(error);

    if (
      !shouldRecover
      || !originalRequest
      || originalRequest._retry
      || !shouldAttemptAuthRecovery({ url: originalRequest.url, method: originalRequest.method })
    ) {
      throw toError(error);
    }

    originalRequest._retry = true;

    let token: string;
    try {
      const currentToken = tokenGetter?.();
      token = currentToken && originalRequest.headers.Authorization !== `Bearer ${currentToken}`
        ? currentToken : await renewAccessToken();
    } catch (renewalError) {
      if (renewalError instanceof AuthRecoveryCancelledError || renewalError instanceof RetryableRecoveryError) throw renewalError;
      if (!didHandleSessionExpiry) {
        didHandleSessionExpiry = true;
        cancelAuthRecovery();
        clearAuthCallback?.();
        globalThis.location.href = '/login?reason=session_expired';
      }

      throw toError(error);
    }
    originalRequest.headers.Authorization = `Bearer ${token}`;
    return apiClient(originalRequest);
  },
);

function isAuthResponse(value: unknown): value is AuthResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as { accessToken?: unknown; user?: unknown };
  if (typeof response.accessToken !== 'string' || !response.accessToken
    || !response.user || typeof response.user !== 'object') return false;
  const user = response.user as { id?: unknown; name?: unknown; email?: unknown };
  return typeof user.id === 'string' && typeof user.name === 'string' && typeof user.email === 'string';
}

function isAxiosErrorLike(
  err: unknown
): err is { response?: { status?: number; data?: unknown }; config?: unknown } {
  return typeof err === 'object' && err !== null && 'config' in err;
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function isExpiredAccessTokenError(err: {
  response?: { data?: unknown };
}): boolean {
  const message = getApiErrorMessage(err.response?.data);
  return message === 'Invalid or expired access token';
}

function getApiErrorMessage(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const maybeError = (data as { error?: unknown }).error;
  if (!maybeError || typeof maybeError !== 'object') return null;
  const message = (maybeError as { message?: unknown }).message;
  return typeof message === 'string' ? message : null;
}

export default apiClient;
