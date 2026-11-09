import type {
  CheckRequest,
  CheckResponse,
  FeedbackEvent,
  RewriteRequest,
  RewriteResponse,
  UsageSummary,
  UserOut,
} from './types';

/** Messages from content scripts / popup / options to the background service worker. */
export type Request =
  | { type: 'check'; fieldKey: string; payload: CheckRequest }
  | { type: 'rewrite'; payload: RewriteRequest }
  | { type: 'feedback'; events: FeedbackEvent[] }
  | { type: 'dictionary.add'; word: string }
  | { type: 'dictionary.remove'; word: string }
  | { type: 'rule.disable'; ruleId: string }
  | { type: 'rule.enable'; ruleId: string }
  | { type: 'auth.login'; email: string; password: string }
  | { type: 'auth.register'; email: string; password: string; displayName?: string }
  | { type: 'auth.logout' }
  | { type: 'account.export' }
  | { type: 'account.delete'; password: string }
  | { type: 'sync' }
  | { type: 'status' }
  | { type: 'usage' }
  | { type: 'badge'; count: number };

export interface StatusResponse {
  backend: 'ok' | 'degraded' | 'offline';
  aiAvailable: boolean;
  user: UserOut | null;
}

export type ResponseFor<T extends Request['type']> = T extends 'check'
  ? CheckResponse
  : T extends 'rewrite'
    ? RewriteResponse
    : T extends 'status'
      ? StatusResponse
      : T extends 'usage'
        ? UsageSummary | null
        : T extends 'auth.login' | 'auth.register'
          ? UserOut
          : T extends 'account.export'
            ? unknown
            : null;

/** Envelope so errors survive the structured-clone boundary of runtime messaging. */
export type Envelope<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

export class WriteMindError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
