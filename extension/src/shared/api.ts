import { authItem, getSettings, type AuthState } from './settings';
import { WriteMindError } from './messages';
import type { ApiErrorBody, TokenPair } from './types';

const TIMEOUT_MS = 10_000;

export class ApiClient {
  private refreshing: Promise<AuthState | null> | null = null;

  async request<T>(
    path: string,
    init: { method?: string; body?: unknown; signal?: AbortSignal; auth?: 'optional' | 'required' | 'none' } = {},
  ): Promise<T> {
    const { apiBaseUrl } = await getSettings();
    const authMode = init.auth ?? 'optional';
    let auth = authMode === 'none' ? null : await authItem.getValue();
    if (authMode === 'required' && !auth) throw new WriteMindError('unauthorized', 'Sign in to use this feature.');
    if (auth && auth.expiresAt - Date.now() < 30_000) auth = await this.refresh(auth);

    const send = (token: string | null) => {
      const signals = [AbortSignal.timeout(TIMEOUT_MS)];
      if (init.signal) signals.push(init.signal);
      return fetch(new URL(path, apiBaseUrl), {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        headers: {
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          'X-WriteMind-Client': 'chrome-extension',
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.any(signals),
      });
    };

    let res: Response;
    try {
      res = await send(auth?.accessToken ?? null);
      if (res.status === 401 && auth) {
        const renewed = await this.refresh(auth);
        res = await send(renewed?.accessToken ?? null);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw new WriteMindError('aborted', 'Request cancelled.');
      if (err instanceof DOMException && err.name === 'TimeoutError') throw new WriteMindError('timeout', 'WriteMind took too long to respond.');
      throw new WriteMindError('offline', 'Cannot reach the WriteMind service.');
    }
    if (res.status === 204) return null as T;
    const data = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      const body = data as ApiErrorBody | null;
      throw new WriteMindError(body?.error?.code ?? `http_${res.status}`, body?.error?.message ?? `Request failed (${res.status}).`);
    }
    return data as T;
  }

  /** Single-flight refresh; on failure the user is signed out and continues as a guest. */
  private async refresh(auth: AuthState): Promise<AuthState | null> {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        try {
          const { apiBaseUrl } = await getSettings();
          const res = await fetch(new URL('/v1/auth/refresh', apiBaseUrl), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: auth.refreshToken }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          if (!res.ok) {
            if (res.status === 401) await authItem.setValue(null);
            return res.status === 401 ? null : auth;
          }
          return await storeTokens((await res.json()) as TokenPair);
        } catch {
          return auth; // network problem: keep the session, try again later
        } finally {
          this.refreshing = null;
        }
      })();
    }
    return this.refreshing;
  }
}

export async function storeTokens(pair: TokenPair): Promise<AuthState> {
  const state: AuthState = {
    accessToken: pair.access_token,
    refreshToken: pair.refresh_token,
    expiresAt: Date.now() + pair.expires_in * 1000,
    user: pair.user,
  };
  await authItem.setValue(state);
  return state;
}
