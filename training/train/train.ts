/**
 * Trains the WriteMind language model (shared/model/en.model.txt). Run with ./training/train.sh.
 *
 * 1. Vocabulary + word statistics: SymSpell's English frequency lists (from the Google Books n-gram
 *    corpus), checked against the American and British Hunspell dictionaries.
 * 2. Typing-error model: aligns ~42,000 real misspellings with their corrections and learns how
 *    likely every substitution, missing letter, extra letter, doubled letter and swap is
 *    (a Kernighan–Church–Gale style noisy channel).
 * 3. Weight tuning: grid search on a development split, never on the held-out test split.
 * 4. Confused-word models: see confusion.ts.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import nspell from 'nspell';
import { LanguageModel, US, GB } from '../../extension/src/offline/model';
import { CANDIDATE_SETS, trainConfusions } from './confusion';
import { contextTypos } from './jfleg';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = join(ROOT, 'training', '.data');
const BUILD = join(ROOT, 'training', '.build');
const OUT = join(ROOT, 'shared', 'model', 'en.model.txt');
const PROPER = 4;

const log = (...a: unknown[]) => console.error(...a);
const lines = (p: string) => readFileSync(p, 'utf8').split('\n').filter(Boolean);
const cost = (p: number) => Math.round(-1000 * Math.log(p));

// ------------------------------------------------------------------ 1. vocabulary
const dict = (lang: string) =>
  nspell(readFileSync(join(ROOT, 'shared', 'dictionaries', `${lang}.aff`), 'utf8'), readFileSync(join(ROOT, 'shared', 'dictionaries', `${lang}.dic`), 'utf8'));
const us = dict('en-US');
const gb = dict('en-GB');

const counts = new Map<string, number>();
let total = 0;
for (const l of lines(join(DATA, 'symspell', 'symspellpy', 'frequency_dictionary_en_82_765.txt'))) {
  const [w, c] = l.split(' ');
  counts.set(w!, Number(c));
  total += Number(c);
}
const vocab: Array<{ word: string; cost: number; flags: number }> = [];
for (const [word, c] of counts) {
  let flags = 0;
  const cap = word[0]!.toUpperCase() + word.slice(1);
  if (us.correct(word)) flags |= US;
  if (gb.correct(word)) flags |= GB;
  if (!flags && word.length > 1) {
    if (us.correct(cap)) flags |= US | PROPER;
    if (gb.correct(cap)) flags |= GB | PROPER;
  }
  if (word === 'i') flags = US | GB | PROPER;
  if (!flags) continue;
  // Contractions are listed with a placeholder count; keep them rare-ish but known.
  vocab.push({ word, cost: cost(c / total), flags });
}
log(`vocabulary: ${vocab.length} of ${counts.size} words are in the dictionaries`);

// Frequent words the dictionaries don't list (ebay, wifi, storyline, homeschool, biometric…) are accepted
// as correct — unless they are known misspellings — but never offered as corrections.
const EXTRA = 8;
const knownTypos = new Set(lines(join(DATA, 'codespell.txt')).map((l) => l.split('->')[0]!));
for (const k of Object.keys(JSON.parse(readFileSync(join(ROOT, 'shared', 'offline', 'rules.json'), 'utf8')).typos)) knownTypos.add(k);
let extra = 0;
for (const [word, c] of counts) {
  if (!/^[a-z]+$/.test(word) || knownTypos.has(word) || unknownToDictionaries(word) === false) continue;
  if ((word.length >= 5 && c >= 50_000) || (word.length >= 4 && c >= 1_000_000)) {
    vocab.push({ word, cost: cost(c / total), flags: EXTRA });
    extra++;
  }
}
log(`vocabulary: +${extra} frequent words the dictionaries don't list`);

function unknownToDictionaries(word: string): boolean {
  const cap = word[0]!.toUpperCase() + word.slice(1);
  return !(us.correct(word) || gb.correct(word) || us.correct(cap) || gb.correct(cap));
}

// ------------------------------------------------------------------ bigrams (pruned)
const BACKOFF = 2300;
const unigramCost = new Map(vocab.map((v) => [v.word, v.cost]));
const uni = (w: string) => unigramCost.get(w) ?? cost((counts.get(w) ?? 1) / total);
// To keep the model small, keep every pair that involves a commonly confused word (those decide
// real-word errors) plus the most frequent other pairs (context for spelling suggestions).
const confusable = new Set(CANDIDATE_SETS.flatMap(([s]) => s.split('|')));
const GENERAL_PAIRS = Number(process.env.WM_PAIRS ?? 40_000);
const bigramLines: string[] = [];
const general: Array<[number, string]> = [];
let seen = 0;
let rarest = Infinity;
for (const l of lines(join(DATA, 'symspell', 'symspellpy', 'frequency_bigramdictionary_en_243_342.txt'))) {
  const [a, b, c] = l.split(' ');
  seen++;
  rarest = Math.min(rarest, Number(c));
  const ca = counts.get(a!);
  if (!ca || !counts.has(b!)) continue;
  const conditional = cost(Math.min(1, Number(c) / ca));
  // A pair is only worth storing if it says more than the back-off estimate would.
  if (Math.abs(conditional - (BACKOFF + uni(b!))) < 250) continue;
  if (confusable.has(a!) || confusable.has(b!)) bigramLines.push(`${a} ${b}\t${conditional}`);
  else general.push([Number(c), `${a} ${b}\t${conditional}`]);
}
general.sort((x, y) => y[0] - x[0]);
bigramLines.push(...general.slice(0, GENERAL_PAIRS).map((g) => g[1]));
bigramLines.sort();
log(`bigrams: kept ${bigramLines.length} of ${seen} (all pairs with a commonly confused word + the ${GENERAL_PAIRS} most frequent others)`);

// ------------------------------------------------------------------ 2. error model
type Op = { kind: 'sub'; from: string; to: string } | { kind: 'del'; ch: string; double: boolean } | { kind: 'ins'; ch: string; double: boolean } | { kind: 'trans' };

/** Unit-cost OSA alignment of typo (a) against the intended word (b), as a list of edit operations. */
function align(a: string, b: string): Op[] {
  const n = a.length;
  const m = b.length;
  const d = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) {
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  const ops: Op[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1] && d[i]![j] === d[i - 1]![j - 1]) {
      i--;
      j--;
    } else if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1] && a[i - 1] !== b[j - 1] && d[i]![j] === d[i - 2]![j - 2]! + 1) {
      ops.push({ kind: 'trans' });
      i -= 2;
      j -= 2;
    } else if (i > 0 && j > 0 && d[i]![j] === d[i - 1]![j - 1]! + 1) {
      ops.push({ kind: 'sub', from: b[j - 1]!, to: a[i - 1]! });
      i--;
      j--;
    } else if (j > 0 && d[i]![j] === d[i]![j - 1]! + 1) {
      ops.push({ kind: 'del', ch: b[j - 1]!, double: j > 1 && b[j - 1] === b[j - 2] });
      j--;
    } else {
      ops.push({ kind: 'ins', ch: a[i - 1]!, double: i > 1 && a[i - 1] === a[i - 2] });
      i--;
    }
  }
  return ops;
}

const pairs = lines(join(BUILD, 'spelling-train.tsv')).map((l) => l.split('\t') as [string, string]);
// Every 8th training pair is kept aside to tune the weights.
const dev = pairs.filter((_, i) => i % 8 === 0);
const fit = pairs.filter((_, i) => i % 8 !== 0);

const sub = new Map<string, number>();
const del = new Map<string, number>();
const ins = new Map<string, number>();
const chars = new Map<string, number>();
let trans = 0;
let delDouble = 0;
let insDouble = 0;
let totalChars = 0;
let doubles = 0;
let used = 0;
for (const [typo, word] of fit) {
  const ops = align(typo, word);
  if (ops.length > 3) continue; // too garbled to say which letters were confused
  used++;
  for (let k = 0; k < word.length; k++) {
    chars.set(word[k]!, (chars.get(word[k]!) ?? 0) + 1);
    if (k > 0 && word[k] === word[k - 1]) doubles++;
  }
  totalChars += word.length + 1;
  for (const op of ops) {
    if (op.kind === 'sub') sub.set(op.from + op.to, (sub.get(op.from + op.to) ?? 0) + 1);
    else if (op.kind === 'trans') trans++;
    else if (op.kind === 'del') {
      if (op.double) delDouble++;
      else del.set(op.ch, (del.get(op.ch) ?? 0) + 1);
    } else if (op.double) insDouble++;
    else ins.set(op.ch, (ins.get(op.ch) ?? 0) + 1);
  }
}
log(`error model: learned from ${used} misspellings (${fit.length - used} too garbled to align)`);

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
function editLines(): string[] {
  const out: string[] = [];
  for (const x of LETTERS) {
    const cx = chars.get(x) ?? 1;
    for (const y of LETTERS) if (x !== y) out.push(`sub\t${x}\t${y}\t${cost(((sub.get(x + y) ?? 0) + 0.5) / (cx + 1))}`);
    out.push(`del\t${x}\t${cost(((del.get(x) ?? 0) + 0.5) / (cx + 1))}`);
    out.push(`ins\t${x}\t${cost(((ins.get(x) ?? 0) + 0.5) / (totalChars + 1))}`);
    out.push(`sub\t${x}\t*\t9000`, `sub\t*\t${x}\t9000`);
  }
  // Apostrophes and hyphens: a missing apostrophe ("dont") is a common, cheap slip.
  out.push('del\t*\t1200', 'ins\t*\t5000');
  out.push(`trans\t${cost((trans + 0.5) / (totalChars + 1))}`);
  out.push(`deldouble\t${cost((delDouble + 0.5) / (doubles + 1))}`);
  out.push(`insdouble\t${cost((insDouble + 0.5) / (totalChars + 1))}`);
  return out;
}

// ------------------------------------------------------------------ 3. assemble + tune
interface Weights {
  edit: number;
  next: number;
  backoff: number;
  maxCost: number;
  unknown: number;
  maxEdit: number;
}

function modelText(w: Weights, confusion: string[] = []): string {
  return [
    'writemind-model\t1',
    '# WriteMind built-in language model. Generated by training/train.ts — do not edit by hand.',
    '# Word and word-pair statistics: Google Books Ngram corpus (CC BY 3.0) via SymSpell frequency lists (MIT).',
    '# Typing-error model learned from public lists of real misspellings. See training/README.md.',
    `@weights\tedit=${w.edit}\tnext=${w.next}\tbackoff=${w.backoff}\tmaxCost=${w.maxCost}\tunknown=${w.unknown}\tmaxEdit=${w.maxEdit}\tcompound=12000\tcompoundEdit=12000\tcutoff=${cost(rarest / total)}`,
    '@edits',
    ...editLines(),
    `@unigrams\t${vocab.length}`,
    ...vocab.map((v) => `${v.word}\t${v.cost}\t${v.flags}`),
    `@bigrams\t${bigramLines.length}`,
    ...bigramLines,
    `@confusion\t${confusion.length}`,
    ...confusion,
    '',
  ].join('\n');
}

function top1(model: LanguageModel, sample: Array<[string, string]>): number {
  let ok = 0;
  for (const [typo, word] of sample) if (model.suggest(typo, US, null, null, 1)[0] === word) ok++;
  return ok / sample.length;
}

const sample = dev.filter((_, i) => i % 2 === 0); // ~2,600 pairs keeps the grid search quick
let best: Weights = { edit: 1000, next: 300, backoff: BACKOFF, maxCost: 9000, unknown: 18000, maxEdit: 1_000_000 };
const base = LanguageModel.parse(modelText(best));
let bestScore = -1;
for (const edit of (process.env.WM_QUICK ? [1500] : [600, 800, 1000, 1200, 1500, 2000, 2500])) {
  base.weights = { ...base.weights, edit };
  const s = top1(base, sample);
  log(`  edit weight ${edit}: top-1 ${(s * 100).toFixed(1)}%`);
  if (s > bestScore) {
    bestScore = s;
    best = { ...best, edit };
  }
}
log(`tuned edit weight ${best.edit} (dev top-1 ${(bestScore * 100).toFixed(1)}%)`);

// Context weight: tuned on the JFLEG development sentences (typos in real context).
const ctx = contextTypos(join(DATA, 'jfleg', 'dev'), 'dev', (w) => us.correct(w) || us.correct(w[0]!.toUpperCase() + w.slice(1)));
let bestCtx = -1;
for (const next of (process.env.WM_QUICK ? [400] : [0, 200, 400, 700, 1000])) {
  base.weights = { ...base.weights, edit: best.edit, next };
  let ok = 0;
  for (const t of ctx) if (t.answers.includes(base.suggest(t.typo, US, t.prev, t.next, 1)[0] ?? '')) ok++;
  log(`  next-word weight ${next}: JFLEG dev typos top-1 ${((ok / ctx.length) * 100).toFixed(1)}%`);
  if (ok > bestCtx) {
    bestCtx = ok;
    best = { ...best, next };
  }
}
base.weights = { ...base.weights, ...best };

// Corrections that need too many (or unusual) typing errors are not offered: "shockwaves" should not
// become "shortwave". The cap is the smallest that costs less than half a point of accuracy.
base.weights = { ...base.weights, maxEdit: 1_000_000 };
const uncapped = top1(base, sample);
for (const maxEdit of (process.env.WM_QUICK ? [25000] : [16000, 18000, 20000, 22000, 25000, 30000])) {
  base.weights = { ...base.weights, maxEdit };
  const s = top1(base, sample);
  log(`  max edit cost ${maxEdit}: top-1 ${(s * 100).toFixed(1)}% (uncapped ${(uncapped * 100).toFixed(1)}%)`);
  best = { ...best, maxEdit };
  if (s >= uncapped - 0.005) break;
}
base.weights = { ...base.weights, ...best };

// ------------------------------------------------------------------ 4. confused words
const confusion = trainConfusions(base, DATA, log);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, modelText(best, confusion));
log(`wrote ${OUT}`);
