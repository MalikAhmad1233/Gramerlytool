import nspell from 'nspell';
import { GB, LanguageModel, US } from './model';
import { RULES, matchCase, type OfflineIssue } from './ruleset';

const WORD = /[\p{L}\p{M}\p{N}_'’-]+/gu;
const PROPER = 4;
const EXTRA = 8;
/** Lower-case particles inside names: “de Gaulle”, “al Qaeda”, “van Gogh”. */
const PARTICLES = new Set(RULES.nameParticles ?? []);

/**
 * Spelling: Hunspell decides whether a word is correct; WriteMind's trained language model
 * (model.ts) decides what the writer most likely meant.
 */
export class Speller {
  private readonly spell: ReturnType<typeof nspell>;
  private readonly allow = new Set(RULES.allowWords.map((w) => w.toLowerCase()));
  private readonly cache = new Map<string, boolean>();
  private readonly suggestions = new Map<string, string[]>();

  /** `variant`: US (1) for American, GB (2) for British dictionaries. */
  constructor(
    aff: string | Uint8Array,
    dic: string | Uint8Array,
    readonly model: LanguageModel | null = null,
    readonly variant: number = US,
  ) {
    this.spell = nspell(aff as never, dic as never);
  }

  /** A valid-looking compound of two common words that the dictionary doesn't list. */
  isCompound(word: string): boolean {
    if (RULES.typos[word.toLowerCase()]) return false;
    return this.model?.isCompound(word.toLowerCase(), this.variant) ?? false;
  }

  isProperNoun(word: string): boolean {
    return ((this.model?.wordFlags(word.toLowerCase()) ?? 0) & PROPER) !== 0;
  }

  /** True if `correction` is only a slip or two away from `word` (by the learned typing-error model). */
  isCloseCorrection(word: string, correction: string | undefined): boolean {
    if (!correction || !this.model) return false;
    const cost = Math.trunc((this.model.editCost(word.toLowerCase(), correction.toLowerCase()) * this.model.weights.edit) / 1000);
    return cost <= this.model.weights.compoundEdit;
  }

  /** True if the word is a correct spelling in the other variety of English (colour/color). */
  isOtherVariant(word: string): boolean {
    if (!this.model) return false;
    const flags = this.model.wordFlags(word.toLowerCase().replace(/’/g, "'"));
    const other = this.variant === US ? GB : US;
    return (flags & other) !== 0 && (flags & this.variant) === 0;
  }

  isCorrect(word: string): boolean {
    const cached = this.cache.get(word);
    if (cached !== undefined) return cached;
    const w = word.replace(/’/g, "'");
    const lower = w.toLowerCase();
    let ok = this.allow.has(lower) || this.spell.correct(w) || ((this.model?.wordFlags(lower) ?? 0) & EXTRA) !== 0;
    if (!ok && /['’]s$/i.test(w)) ok = this.spell.correct(w.slice(0, -2));
    if (!ok && w[0] && w[0] !== lower[0] && w.slice(1) === lower.slice(1)) ok = this.spell.correct(lower);
    this.cache.set(word, ok);
    return ok;
  }

  suggest(word: string, prev: string | null = null, next: string | null = null): string[] {
    const key = `${word}|${prev ?? ''}|${next ?? ''}`;
    const cached = this.suggestions.get(key);
    if (cached) return cached;
    const lower = word.toLowerCase().replace(/’/g, "'");
    let out: string[] = [];
    const typo = RULES.typos[lower];
    if (typo) {
      out = [typo];
    } else if (this.model) {
      out = this.model.suggest(lower, this.variant, prev, next).map((s) =>
        this.model!.wordFlags(s) & PROPER ? s[0]!.toUpperCase() + s.slice(1) : s,
      );
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
    this.suggestions.set(key, out);
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

/** The neighbouring word, if only spaces separate it from the span (the model's word-pair context). */
function neighbour(text: string, start: number, end: number, before: boolean): string | null {
  if (before) {
    const m = /([\p{L}'’]+)[ \t]+$/u.exec(text.slice(Math.max(0, start - 40), start));
    return m ? m[1]!.toLowerCase().replace(/’/g, "'") : null;
  }
  const m = /^[ \t]+([\p{L}'’]+)/u.exec(text.slice(end, end + 40));
  return m ? m[1]!.toLowerCase().replace(/’/g, "'") : null;
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
      // Letters outside English (ü, é, ñ…) mean a name or a foreign word, not a typo.
      if (/[^A-Za-z'’]/.test(word)) continue;
      // colour/color: a correct spelling in the other variety of English gets a gentle note, not an error.
      if (speller.isOtherVariant(word)) {
        const american = speller.variant === US;
        issues.push({
          start: s,
          end: s + word.length,
          original: word,
          replacements: speller.suggest(word).slice(0, 1),
          category: 'spelling',
          severity: 'suggestion',
          title: american ? 'American spelling' : 'British spelling',
          message: american
            ? `“${word}” is the British spelling. Your language is set to American English.`
            : `“${word}” is the American spelling. Your language is set to British English.`,
          ruleId: 'WM_SPELLING_VARIANT',
          confidence: 0.7,
          fromRule: false,
        });
        continue;
      }
      if (capitalised && looksLikeName(text, word.replace(/['’]s$/, ''), s)) continue;
      if (!capitalised && PARTICLES.has(word) && /^[ \t]+[A-Z]/.test(text.slice(s + word.length, s + word.length + 3))) continue;
      const suggestions = speller.suggest(word, neighbour(text, s, s + word.length, true), neighbour(text, s, s + word.length, false));
      // A capitalised unknown word (necessarily at the start of a sentence here) is usually a name; only
      // flag it when it is a slip or two away from an ordinary word.
      if (capitalised && !(suggestions[0] && !speller.isProperNoun(suggestions[0]) && speller.isCloseCorrection(word, suggestions[0]))) continue;
      if (!capitalised && speller.isCompound(word) && !speller.isCloseCorrection(word, suggestions[0])) continue;
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

/** A capitalised unknown word at the start of a sentence is usually a name if it is used as one elsewhere. */
function looksLikeName(text: string, word: string, start: number): boolean {
  // Part of a run of capitalised words ("Seagal Films said").
  if (/^[ \t]+\p{Lu}\p{Ll}/u.test(text.slice(start + word.length, start + word.length + 4))) return true;
  // Used capitalised mid-sentence somewhere else in the text.
  for (let i = text.indexOf(word); i >= 0; i = text.indexOf(word, i + 1)) {
    if (i === start) continue;
    const before = text[i - 1];
    const after = text[i + word.length];
    if ((before && /[\p{L}\p{N}]/u.test(before)) || (after && /[\p{L}\p{N}]/u.test(after))) continue;
    if (!isSentenceStart(text, i)) return true;
  }
  return false;
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
