import { describe, expect, test } from 'bun:test';
import { AxiosError, AxiosHeaders } from 'axios';
import { isRetryableRequestError } from './recoveryErrors';

describe('recovery error classification', () => {
  test('network and timeout failures are retryable but cancellation is terminal', () => {
    for (const code of ['ERR_NETWORK', 'ECONNABORTED', 'ETIMEDOUT']) {
      expect(isRetryableRequestError(new AxiosError('Unavailable', code))).toBe(true);
    }
    expect(isRetryableRequestError(new AxiosError('Cancelled', 'ERR_CANCELED'))).toBe(false);
    expect(isRetryableRequestError(new Error('Invalid renewal response'))).toBe(false);
  });

  test('only server failures are retryable HTTP statuses', () => {
    for (const status of [400, 401, 403, 404, 429, 500, 502, 503, 599]) {
      const error = new AxiosError('HTTP failure');
      error.response = { status, statusText: 'Failure', headers: {}, data: null, config: { headers: new AxiosHeaders() } };
      expect(isRetryableRequestError(error)).toBe(status >= 500);
    }
  });
});
