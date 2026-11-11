/**
 * WriteMind language model: the trained part of the built-in checker.
 *
 *  - Word statistics (how common each word is, and which words follow which) from the Google Books
 *    n-gram corpus, via the SymSpell frequency lists.
 *  - A typing-error model learned from tens of thousands of real misspellings: how likely each
 *    substitution, missing, extra, doubled or swapped letter is.
 *  - Context models for commonly confused real words (then/than, form/from, …).
 *
 * The model file is produced by training/train.ts (shared/model/en.model.txt). Every score is an
 * integer cost (−1000 × ln p), so the Windows app (WriteMind.Core/Offline/LanguageModel.cs)
 * computes exactly the same numbers and makes exactly the same choices.
 */

export const US = 1;
export const GB = 2;

export interface ConfusionSet {
  words: string[];
  /** Extra cost an alternative must overcome before we call the written word a mistake. */
  margin: number;
  title: string;
}

interface Weights {
  edit: number; // per-mille weight of the typing-error cost
  next: number; // per-mille weight of the right-context cost
  backoff: number; // cost added when a word pair was never seen
  maxCost: number; // candidates scoring worse than (best + maxCost) are dropped
  unknown: number; // cost of a word that is not in the vocabulary
  maxEdit: number; // corrections needing more (weighted) typing errors than this are not offered
  compound: number; // both halves of an unknown compound ("shockwaves") must be this common
  compoundEdit: number; // …and it is only left alone when no correction is closer than this
  cutoff: number; // cost of the rarest word pair in the list (pairs seen fewer times are not listed)
}

const A = 97;

function letter(ch: string | undefined): number {
  if (!ch) return -1;
  const c = ch.charCodeAt(0) - A;
  return c >= 0 && c < 26 ? c : -1;
}

export class LanguageModel {
  /** word → id; ids index `words`, `costs`, `flags` and the letter histograms. */
  private readonly ids = new Map<string, number>();
  private readonly words: string[] = [];
  private costs = new Int32Array(0);
  private flags = new Uint8Array(0);
  private hist = new Uint8Array(0);
  private readonly bigrams = new Map<string, number>();
  private readonly byLength: number[][] = [];
  readonly confusions: ConfusionSet[] = [];
  private readonly confusionIndex = new Map<string, ConfusionSet>();
  private readonly sub = new Int32Array(27 * 27);
  private readonly ins = new Int32Array(27);
  private readonly del = new Int32Array(27);
  private trans = 3000;
  private insDouble = 2000;
  private delDouble = 2000;
  weights: Weights = { edit: 1000, next: 1000, backoff: 2300, maxCost: 9000, unknown: 18000, maxEdit: 25000, compound: 12000, compoundEdit: 12000, cutoff: 8000 };

  static parse(text: string): LanguageModel {
    const m = new LanguageModel();
    let section = '';
    m.sub.fill(9000);
    m.ins.fill(9000);
    m.del.fill(9000);
    for (const raw of text.split('\n')) {
      const line = raw.replace(/\r$/, '');
      if (!line || line.startsWith('#')) continue;
      if (line.startsWith('@')) {
        const [name, ...rest] = line.split('\t');
        section = name!.slice(1);
        if (section === 'weights') {
          for (const kv of rest) {
            const [k, v] = kv.split('=');
            (m.weights as unknown as Record<string, number>)[k!] = Number(v);
          }
        }
        continue;
      }
      const f = line.split('\t');
      switch (section) {
        case 'edits': {
          const idx = (s: string) => (s === '*' ? 26 : letter(s));
          if (f[0] === 'sub') m.sub[idx(f[1]!) * 27 + idx(f[2]!)] = Number(f[3]);
          else if (f[0] === 'ins') m.ins[idx(f[1]!)] = Number(f[2]);
          else if (f[0] === 'del') m.del[idx(f[1]!)] = Number(f[2]);
          else if (f[0] === 'trans') m.trans = Number(f[1]);
          else if (f[0] === 'insdouble') m.insDouble = Number(f[1]);
          else if (f[0] === 'deldouble') m.delDouble = Number(f[1]);
          break;
        }
        case 'unigrams': {
          const id = m.words.length;
          if (id >= m.costs.length) m.grow(Math.max(1024, id * 2));
          const word = f[0]!;
          m.words.push(word);
          m.ids.set(word, id);
          m.costs[id] = Number(f[1]);
          m.flags[id] = Number(f[2]);
          for (let i = 0; i < word.length; i++) {
            const c = letter(word[i]);
            m.hist[id * 27 + (c < 0 ? 26 : c)]!++;
          }
          (m.byLength[word.length] ??= []).push(id);
          break;
        }
        case 'bigrams':
          m.bigrams.set(f[0]!, Number(f[1]));
          break;
        case 'confusion': {
          const set: ConfusionSet = { words: f[0]!.split('|'), margin: Number(f[1]), title: f[2] ?? 'Word choice' };
          m.confusions.push(set);
          for (const w of set.words) m.confusionIndex.set(w, set);
          break;
        }
      }
    }
    return m;
  }

  private grow(size: number): void {
    const costs = new Int32Array(size);
    costs.set(this.costs);
    const flags = new Uint8Array(size);
    flags.set(this.flags);
    const hist = new Uint8Array(size * 27);
    hist.set(this.hist);
    this.costs = costs;
    this.flags = flags;
    this.hist = hist;
  }

  get size(): number {
    return this.words.length;
  }

  /** −1000·ln P(word); words outside the vocabulary get a large fixed cost. */
  unigram(word: string): number {
    const id = this.ids.get(word);
    return id === undefined ? this.weights.unknown : this.costs[id]!;
  }

  /** Dictionary flags of a known word (US = 1, GB = 2, proper noun = 4), or 0. */
  wordFlags(word: string): number {
    const id = this.ids.get(word);
    return id === undefined ? 0 : this.flags[id]!;
  }

  /** Cost of seeing `second` right after `first` (stupid back-off to the unigram). */
  follow(first: string | null, second: string): number {
    if (first) {
      const c = this.bigrams.get(`${first} ${second}`);
      if (c !== undefined) return c;
      return this.weights.backoff + this.unigram(second);
    }
    return this.unigram(second);
  }

  /** How well `word` fits between `prev` and `next` (lower is better). */
  contextCost(word: string, prev: string | null, next: string | null): number {
    let cost = this.follow(prev, word);
    if (next) cost += Math.trunc((this.follow(word, next) * this.weights.next) / 1000);
    return cost;
  }

  /**
   * True for an unknown word made of two common words ("shockwaves", "frontline"): usually a valid
   * compound the dictionary doesn't list, so it is not flagged.
   */
  isCompound(word: string, variant: number): boolean {
    if (word.length < 6) return false;
    const ok = (part: string) => {
      const id = this.ids.get(part);
      return id !== undefined && (this.flags[id]! & variant) !== 0 && (this.flags[id]! & 4) === 0 && this.costs[id]! <= this.weights.compound;
    };
    for (let i = 3; i <= word.length - 3; i++) if (ok(word.slice(0, i)) && ok(word.slice(i))) return true;
    return false;
  }

  hasBigram(first: string, second: string): boolean {
    return this.bigrams.has(`${first} ${second}`);
  }

  confusionSet(word: string): ConfusionSet | undefined {
    return this.confusionIndex.get(word);
  }

  /** Adds or replaces a confused-word set (used while training margins). */
  setConfusion(set: ConfusionSet): void {
    for (const w of set.words) this.confusionIndex.set(w, set);
  }

  /**
   * For a word from a confused-word set: the alternative that fits the neighbouring words best, and by how
   * much (cost of the written word minus cost of the alternative). Only alternatives that were actually
   * seen next to one of the neighbours compete, so rare contexts never produce a suggestion.
   */
  confusionGain(word: string, prev: string | null, next: string | null): { alternative: string; gain: number } | null {
    const set = this.confusionIndex.get(word);
    if (!set || (!prev && !next)) return null;
    let best: string | null = null;
    let bestGain = 0;
    for (const alt of set.words) {
      if (alt === word) continue;
      // Only the sides where at least one of the two words was seen next to the neighbour count, so a
      // rare context never turns into "use the more common word".
      let gain = 0;
      let evidence = false;
      // A pair missing from the list was seen fewer than `cutoff` times, which bounds how likely it can be;
      // otherwise the usual back-off estimate applies. Every neighbour must have been seen with one of the
      // two words, and a neighbour that prefers the written word (or was only seen with it) vetoes the change.
      let veto = false;
      if (prev) {
        const own = this.bigrams.get(`${prev} ${word}`);
        const other = this.bigrams.get(`${prev} ${alt}`);
        if (other !== undefined) {
          evidence = true;
          const ownCost = own ?? Math.max(this.weights.cutoff - this.unigram(prev), this.weights.backoff + this.unigram(word));
          if (ownCost < other) veto = true;
          else gain += ownCost - other;
        } else veto = true;
      }
      if (next) {
        const own = this.bigrams.get(`${word} ${next}`);
        const other = this.bigrams.get(`${alt} ${next}`);
        if (other !== undefined) {
          evidence = true;
          const ownCost = own ?? Math.max(this.weights.cutoff - this.unigram(word), this.weights.backoff + this.unigram(next));
          if (ownCost < other) veto = true;
          else gain += Math.trunc(((ownCost - other) * this.weights.next) / 1000);
        } else veto = true;
      }
      if (veto) continue;
      if (evidence && (best === null || gain > bestGain)) {
        best = alt;
        bestGain = gain;
      }
    }
    return best === null ? null : { alternative: best, gain: bestGain };
  }

  /** The likely intended word if the written one is a confused-word mistake, else null. */
  confusionCheck(word: string, prev: string | null, next: string | null): string | null {
    const r = this.confusionGain(word, prev, next);
    if (!r) return null;
    return r.gain > this.confusionIndex.get(word)!.margin ? r.alternative : null;
  }

  /** Learned cost of typing `typo` when `word` was meant (weighted Damerau–Levenshtein, OSA). */
  editCost(typo: string, word: string): number {
    const n = typo.length;
    const m = word.length;
    const w = m + 1;
    const d = new Int32Array((n + 1) * w);
    const code = (s: string, i: number) => {
      const c = letter(s[i]);
      return c < 0 ? 26 : c;
    };
    for (let j = 1; j <= m; j++) d[j] = d[j - 1]! + this.delCost(word, j - 1, code);
    for (let i = 1; i <= n; i++) {
      d[i * w] = d[(i - 1) * w]! + this.insCost(typo, i - 1, code);
      for (let j = 1; j <= m; j++) {
        const a = typo[i - 1];
        const b = word[j - 1];
        let best = d[(i - 1) * w + j - 1]! + (a === b ? 0 : this.sub[code(word, j - 1) * 27 + code(typo, i - 1)]!);
        const insertion = d[(i - 1) * w + j]! + this.insCost(typo, i - 1, code);
        if (insertion < best) best = insertion;
        const deletion = d[i * w + j - 1]! + this.delCost(word, j - 1, code);
        if (deletion < best) best = deletion;
        if (i > 1 && j > 1 && a === word[j - 2] && typo[i - 2] === b && a !== b) {
          const t = d[(i - 2) * w + j - 2]! + this.trans;
          if (t < best) best = t;
        }
        d[i * w + j] = best;
      }
    }
    return d[n * w + m]!;
  }

  private insCost(typo: string, i: number, code: (s: string, i: number) => number): number {
    // An extra letter that repeats its neighbour ("acccess") is a very common slip.
    if (i > 0 && typo[i] === typo[i - 1]) return this.insDouble;
    return this.ins[code(typo, i)]!;
  }

  private delCost(word: string, j: number, code: (s: string, i: number) => number): number {
    // Writing one letter of a double ("ocurred", "acommodate").
    if (j > 0 && word[j] === word[j - 1]) return this.delDouble;
    return this.del[code(word, j)]!;
  }

  /**
   * Ranked corrections for a misspelled (lower-case) word. `variant` restricts candidates to words that
   * are correct in American (US) or British (GB) English. Context words make the choice smarter:
   * "I live in a hous" → "house", "the hous of" → "house"/"hour" ranked by what usually follows.
   */
  suggest(typo: string, variant: number, prev: string | null, next: string | null, limit = 4): string[] {
    const n = typo.length;
    if (n < 2 || n > 30) return [];
    const maxEdits = n <= 4 ? 1 : n <= 7 ? 2 : 3;
    const th = new Int32Array(27);
    for (let i = 0; i < n; i++) {
      const c = letter(typo[i]);
      th[c < 0 ? 26 : c]!++;
    }
    const hist = this.hist;
    const scored: Array<{ word: string; score: number }> = [];
    for (let len = Math.max(1, n - maxEdits); len <= n + maxEdits; len++) {
      const bucket = this.byLength[len];
      if (!bucket) continue;
      for (const id of bucket) {
        if ((this.flags[id]! & variant) === 0) continue;
        // Bag distance is a cheap lower bound on the number of edits.
        let more = 0;
        let less = 0;
        const base = id * 27;
        for (let k = 0; k < 27; k++) {
          const diff = th[k]! - hist[base + k]!;
          if (diff > 0) more += diff;
          else less -= diff;
        }
        if ((more > less ? more : less) > maxEdits) continue;
        const word = this.words[id]!;
        if (osaWithin(typo, word, maxEdits) < 0) continue;
        const edit = Math.trunc((this.editCost(typo, word) * this.weights.edit) / 1000);
        if (edit > this.weights.maxEdit) continue;
        scored.push({ word, score: edit + this.contextCost(word, prev, next) });
      }
    }
    scored.sort((a, b) => a.score - b.score || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));
    if (!scored.length) return [];
    const cutoff = scored[0]!.score + this.weights.maxCost;
    return scored.filter((s) => s.score <= cutoff).slice(0, limit).map((s) => s.word);
  }
}

/** Unit-cost OSA distance, or −1 when it exceeds `max` (banded, early exit). */
export function osaWithin(a: string, b: string, max: number): number {
  const n = a.length;
  const m = b.length;
  if (Math.abs(n - m) > max) return -1;
  const w = m + 1;
  const big = max + 1;
  const d = new Int32Array((n + 1) * w).fill(big);
  for (let j = 0; j <= Math.min(m, max); j++) d[j] = j;
  for (let i = 1; i <= n; i++) {
    if (i <= max) d[i * w] = i;
    let rowMin = i <= max ? i : big;
    const lo = Math.max(1, i - max);
    const hi = Math.min(m, i + max);
    for (let j = lo; j <= hi; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = d[(i - 1) * w + j - 1]! + cost;
      const up = d[(i - 1) * w + j]! + 1;
      if (up < v) v = up;
      const left = d[i * w + j - 1]! + 1;
      if (left < v) v = left;
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        const t = d[(i - 2) * w + j - 2]! + 1;
        if (t < v) v = t;
      }
      if (v > big) v = big;
      d[i * w + j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return -1;
  }
  const r = d[n * w + m]!;
  return r > max ? -1 : r;
}
