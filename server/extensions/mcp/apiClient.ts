import { config } from './config';

// Thin fetch wrapper: injects Authorization header and normalises error shapes.
// token param is optional — stdio mode omits it and falls back to config.token;
// HTTP mode always passes the authenticated user's token from the request.
// Legacy callers supply their response type; schema-checked tools use unknown.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export async function apiCall<T>({
  method,
  path,
  body,
  token,
}: {
  method: string;
  path: string;
  body?: unknown;
  token?: string;
}): Promise<
  | { data: T }
  | {
      error: {
        name: string;
        data?: unknown;
        status?: number;
        phase: 'transport' | 'response' | 'http';
      };
    }
> {
  const url = `${config.apiUrl}${path}`;
  const authToken = token ?? config.token;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(config.timeoutMs ?? 30_000),
      redirect: 'manual',
    });
  } catch (error) {
    return {
      error: {
        name:
          error instanceof DOMException && error.name === 'TimeoutError' ? 'timeout' : 'network',
        phase: 'transport',
      },
    };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    if (res.ok)
      return { error: { name: 'invalid-response', status: res.status, phase: 'response' } };
    payload = null;
  }

  if (!res.ok) {
    const errPayload = payload as {
      name?: unknown;
      data?: unknown;
      error?: { code?: unknown; message?: unknown };
    } | null;
    const name = errPayload?.name ?? errPayload?.error?.code ?? `http-${String(res.status)}`;
    return {
      error: {
        name:
          typeof name === 'string' &&
          /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) &&
          !(authToken && name.includes(authToken))
            ? name
            : 'api-error',
        data: errPayload?.data ?? errPayload?.error ?? payload,
        status: res.status,
        phase: 'http',
      },
    };
  }

  if (!res.headers.get('content-type')?.toLowerCase().includes('application/json'))
    return { error: { name: 'invalid-response', status: res.status, phase: 'response' } };
  return { data: payload as T };
}
