import type { CheckRequest, CheckResponse, FeedbackEvent, RewriteRequest, RewriteResponse } from './types';

/** Messages from content scripts / popup / options to the background service worker. */
export type Request =
  | { type: 'check'; fieldKey: string; payload: CheckRequest }
  | { type: 'rewrite'; payload: RewriteRequest }
  | { type: 'feedback'; events: FeedbackEvent[] }
  | { type: 'dictionary.add'; word: string }
  | { type: 'dictionary.remove'; word: string }
  | { type: 'rule.disable'; ruleId: string }
  | { type: 'rule.enable'; ruleId: string }
  | { type: 'status' }
  | { type: 'badge'; count: number };

/**
 * `server`: a WriteMind API is reachable (LanguageTool grammar engine, AI if configured).
 * `builtin`: no server — the built-in checker inside the extension is used. Both work without an account.
 */
export interface StatusResponse {
  engine: 'server' | 'builtin';
  aiAvailable: boolean;
}

export type ResponseFor<T extends Request['type']> = T extends 'check'
  ? CheckResponse
  : T extends 'rewrite'
    ? RewriteResponse
    : T extends 'status'
      ? StatusResponse
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
