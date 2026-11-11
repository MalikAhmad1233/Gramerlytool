import nspell from 'nspell';
import { RULES, matchCase, type OfflineIssue } from './ruleset';

const WORD = /[\p{L}\p{M}\p{N}_'’-]+/gu;

/** Hunspell-based spelling with WriteMind's typo table, allow-list and suggestion ranking. */
export class Speller {
  private readonly spell: ReturnType<typeof nspell>;
  private readonly allow = new Set(RULES.allowWords.map((w) => w.toLowerCase()));
  private readonly cache = new Map<string, boolean>();
  private readonly suggestions = new Map<string, string[]>();

  constructor(aff: string | Uint8Array, dic: string | Uint8Array) {
    this.spell = nspell(aff as never, dic as never);
  }

  isCorrect(word: string): boolean {
    const cached = this.cache.get(word);
    if (cached !== undefined) return cached;
    const w = word.replace(/’/g, "'");
    const lower = w.toLowerCase();
    let ok = this.allow.has(lower) || this.spell.correct(w);
    if (!ok && /['’]s$/i.test(w)) ok = this.spell.correct(w.slice(0, -2));
    if (!ok && w[0] && w[0] !== lower[0] && w.slice(1) === lower.slice(1)) ok = this.spell.correct(lower);
    this.cache.set(word, ok);
    return ok;
  }

  suggest(word: string): string[] {
    const cached = this.suggestions.get(word);
    if (cached) return cached;
    const lower = word.toLowerCase().replace(/’/g, "'");
    let out: string[] = [];
    const typo = RULES.typos[lower];
    if (typo) {
      out = [typo];
    } else if (word.length <= 20) {
      const transpositions: string[] = [];
      for (let i = 0; i < lower.length - 1; i++) {
        const swapped = lower.slice(0, i) + lower[i + 1] + lower[i] + lower.slice(i + 2);
        if (swapped !== lower && this.spell.correct(swapped)) transpositions.push(swapped);
      }
      const ranked = this.spell
        .suggest(lower)
        .map((s, index) => ({ s, index, d: osaDistance(lower, s.toLowerCase()) }))
        .sort((a, b) => a.d - b.d || a.index - b.index)
        .map((x) => x.s);
      out = [...new Set([...transpositions, ...ranked])].slice(0, 4);
    }
    out = out.map((s) => (s[0] && s[0] === s[0].toUpperCase() ? s : matchCase(word, s)));
    this.suggestions.set(word, out);
    return out;
  }
}

export function osaDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) d[i]![0] = i;
  for (let j = 0; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}

function isSentenceStart(text: string, start: number): boolean {
  const windowStart = Math.max(0, start - 40);
  const before = text.slice(windowStart, start);
  if (/\n[\s"'“‘(\[]*$/.test(before)) return true;
  const trimmed = before.replace(/[\s"'“‘(\[]+$/, '');
  if (trimmed.length === 0) return windowStart === 0;
  return /[.!?]$/.test(trimmed);
}

export function spellingIssues(text: string, speller: Speller, dictionary: Set<string>): OfflineIssue[] {
  const issues: OfflineIssue[] = [];
  WORD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD.exec(text))) {
    const raw = m[0];
    const lead = raw.length - raw.replace(/^['’-]+/, '').length;
    const token = raw.replace(/^['’-]+/, '').replace(/['’-]+$/, '');
    const start = m.index + lead;
    if (token.length < 2 || /[\d_]/.test(token)) continue;
    // Hyphenated words: check each part on its own.
    const parts = token.includes('-') && !speller.isCorrect(token) ? splitParts(token, start) : [{ word: token, start }];
    for (const { word, start: s } of parts) {
      if (word.length < 2) continue;
      if (word === word.toUpperCase()) continue; // acronyms
      if (/[a-z][A-Z]/.test(word) || /^[A-Z]{2,}[a-z]/.test(word)) continue; // camelCase / brand names
      if (dictionary.has(word.toLowerCase())) continue;
      const capitalised = word[0] !== word[0]!.toLowerCase();
      if (capitalised && !isSentenceStart(text, s)) continue; // probably a name
      if (speller.isCorrect(word)) continue;
      const suggestions = speller.suggest(word);
      issues.push({
        start: s,
        end: s + word.length,
        original: word,
        replacements: suggestions,
        category: 'spelling',
        severity: 'error',
        title: 'Spelling mistake',
        message: suggestions.length
          ? `“${word}” may be misspelled.`
          : `“${word}” isn't in the dictionary. If it's correct, add it to your dictionary.`,
        ruleId: 'WM_SPELLING',
        confidence: suggestions.length ? 0.88 : 0.6,
        fromRule: false,
      });
    }
  }
  return issues;
}

function splitParts(token: string, start: number): Array<{ word: string; start: number }> {
  const out: Array<{ word: string; start: number }> = [];
  let offset = 0;
  for (const part of token.split('-')) {
    out.push({ word: part, start: start + offset });
    offset += part.length + 1;
  }
  return out;
}
