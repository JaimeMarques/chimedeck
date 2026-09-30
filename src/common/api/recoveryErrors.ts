import { isAxiosError } from 'axios';

export class RetryableRecoveryError extends Error {}

/** Retry transport outages, never cancellation or terminal access/resource errors. */
export function isRetryableRequestError(error: unknown): boolean {
  if (error instanceof RetryableRecoveryError) return true;
  if (!isAxiosError(error) || error.code === 'ERR_CANCELED') return false;
  if (error.response) return error.response.status >= 500 && error.response.status < 600;
  return error.code === 'ERR_NETWORK' || error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT';
}
