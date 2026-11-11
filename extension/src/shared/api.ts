import { getSettings } from './settings';
import { WriteMindError } from './messages';
import type { ApiErrorBody } from './types';

/** Minimal client for an optional WriteMind server. No accounts: every request is anonymous. */
export async function apiRequest<T>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const { apiBaseUrl } = await getSettings();
  const signals = [AbortSignal.timeout(init.timeoutMs ?? 10_000)];
  if (init.signal) signals.push(init.signal);
  let res: Response;
  try {
    res = await fetch(new URL(path, apiBaseUrl), {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        'X-WriteMind-Client': 'chrome-extension',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.any(signals),
    });
  } catch (err) {
    if (init.signal?.aborted) throw new WriteMindError('aborted', 'Request cancelled.');
    if (err instanceof DOMException && err.name === 'TimeoutError') throw new WriteMindError('timeout', 'The WriteMind server took too long.');
    throw new WriteMindError('offline', 'The WriteMind server is not reachable.');
  }
  if (res.status === 204) return null as T;
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const body = data as ApiErrorBody | null;
    const code = res.status >= 500 ? 'offline' : (body?.error?.code ?? `http_${res.status}`);
    throw new WriteMindError(code, body?.error?.message ?? `Request failed (${res.status}).`);
  }
  return data as T;
}
