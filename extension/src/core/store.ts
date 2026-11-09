import type { Category, CheckResponse, Suggestion } from '../shared/types';
import { overlaps, rebaseSuggestions } from './rebase';

export interface StoreFilters {
  dictionary: Set<string>;
  ignoredRules: Set<string>;
  categories: Set<Category>;
}

type Listener = () => void;

/**
 * Suggestion state for one editable field.
 *
 * - Local edits rebase existing suggestions immediately so underlines stay aligned while the
 *   next check is in flight.
 * - "fast" responses (LanguageTool + rules) are merged with the AI suggestions from the latest
 *   "full" response, so AI findings don't flicker away between full checks.
 * - Responses for an older text are rebased onto the current text, never applied blindly.
 */
export class SuggestionStore {
  private text = '';
  private list: Suggestion[] = [];
  private aiList: Suggestion[] = [];
  private ignored = new Set<string>();
  private listeners = new Set<Listener>();
  score: number | null = null;

  constructor(private readonly getFilters: () => StoreFilters) {}

  get currentText(): string {
    return this.text;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  setText(next: string): void {
    if (next === this.text) return;
    const previous = this.text;
    this.text = next;
    this.list = rebaseSuggestions(this.list, previous, next);
    this.aiList = rebaseSuggestions(this.aiList, previous, next);
    if (!next.trim()) {
      this.list = [];
      this.aiList = [];
      this.score = null;
    }
    this.emit();
  }

  applyResponse(sentText: string, response: CheckResponse): void {
    let incoming = response.suggestions;
    if (sentText !== this.text) incoming = rebaseSuggestions(incoming, sentText, this.text);
    if (response.mode === 'full') {
      this.aiList = incoming.filter((s) => s.source === 'ai');
      this.list = incoming;
    } else {
      const keptAi = this.aiList.filter((a) => !incoming.some((b) => overlaps(a, b)));
      this.list = [...incoming, ...keptAi].sort((a, b) => a.offset - b.offset);
    }
    this.score = response.stats.score;
    this.emit();
  }

  /** Suggestions after user preferences (ignored, dictionary, disabled rules, categories). */
  visible(): Suggestion[] {
    const { dictionary, ignoredRules, categories } = this.getFilters();
    return this.list.filter((s) => {
      if (this.ignored.has(s.fingerprint) || ignoredRules.has(s.rule_id) || !categories.has(s.category)) {
        return false;
      }
      if (s.category === 'spelling' && dictionary.has(s.original.trim().toLowerCase())) return false;
      return true;
    });
  }

  find(id: string): Suggestion | undefined {
    return this.list.find((s) => s.id === id);
  }

  ignore(s: Suggestion): void {
    this.ignored.add(s.fingerprint);
    this.emit();
  }

  remove(id: string): void {
    this.list = this.list.filter((s) => s.id !== id);
    this.aiList = this.aiList.filter((s) => s.id !== id);
    this.emit();
  }

  refresh(): void {
    this.emit();
  }
}
