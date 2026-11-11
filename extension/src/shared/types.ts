/**
 * WriteMind API contract (mirrors backend/app/schemas, see shared/openapi.json).
 * All offsets and lengths are UTF-16 code units — the same unit JavaScript strings use.
 */

export type Style = 'neutral' | 'professional' | 'casual' | 'formal';
export type RewriteStyle = 'professional' | 'casual' | 'formal' | 'friendly' | 'concise';
export type Category = 'grammar' | 'spelling' | 'punctuation' | 'style' | 'clarity';
export type Severity = 'error' | 'warning' | 'suggestion';
export type Source = 'languagetool' | 'ai' | 'writemind';
export type CheckMode = 'fast' | 'full';

export const CATEGORIES: Category[] = ['grammar', 'spelling', 'punctuation', 'style', 'clarity'];
export const STYLES: Style[] = ['neutral', 'professional', 'casual', 'formal'];
export const REWRITE_STYLES: RewriteStyle[] = ['professional', 'formal', 'casual', 'friendly', 'concise'];

export interface Suggestion {
  id: string;
  fingerprint: string;
  offset: number;
  length: number;
  original: string;
  replacements: string[];
  category: Category;
  severity: Severity;
  title: string;
  message: string;
  rule_id: string;
  source: Source;
  confidence: number;
}

export interface CheckRequest {
  text: string;
  language: string;
  style: Style;
  mode: CheckMode;
  client: { kind: 'chrome-extension'; app: string | null };
  categories?: Category[] | null;
  dictionary?: string[];
  disabled_rules?: string[];
  ai?: boolean;
}

export interface CheckResponse {
  text_hash: string;
  language: string;
  style: Style;
  mode: CheckMode;
  suggestions: Suggestion[];
  stats: {
    characters: number;
    words: number;
    sentences: number;
    issues: Record<Category, number>;
    score: number;
  };
  engine: {
    languagetool: 'ok' | 'error' | 'builtin';
    ai: 'used' | 'skipped' | 'disabled' | 'unavailable' | 'error';
    paragraphs_checked: number;
    paragraphs_cached: number;
    latency_ms: number;
  };
}

export interface RewriteRequest {
  text: string;
  style: RewriteStyle;
  count: number;
  language: string;
  client: { kind: 'chrome-extension'; app: string | null };
  ai?: boolean;
}

export interface RewriteAlternative {
  text: string;
  source: 'ai' | 'rules';
  meaning_preserved: boolean;
  notes: string[];
}

export interface RewriteResponse {
  style: RewriteStyle;
  alternatives: RewriteAlternative[];
  engine: 'ai' | 'rules';
  latency_ms: number;
}

export interface ApiErrorBody {
  error: { code: string; message: string; request_id?: string | null };
}

export type FeedbackAction = 'accepted' | 'ignored' | 'rule_disabled' | 'added_to_dictionary';

export interface FeedbackEvent {
  rule_id: string;
  category: Category;
  source: Source;
  action: FeedbackAction;
}
