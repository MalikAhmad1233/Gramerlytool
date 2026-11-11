/**
 * WriteMind quality benchmark for the built-in checker (the same code the extension and — via the
 * parity fixture — the Windows app run).
 *
 *   ./training/eval.sh            # all benchmarks
 *   ./training/eval.sh jfleg      # one benchmark
 *
 * Benchmarks (data fetched by training/fetch-data.sh, never committed):
 *   jfleg     JFLEG dev+test: 1,501 sentences written by English learners, each corrected by 4 people.
 *             A suggestion is "correct" if its edit appears in at least one human correction.
 *   spelling  Real misspellings held out from training (never seen by the trainer): is the right word
 *             the first suggestion? In the top 3?
 *   typos     Misspelled words inside the JFLEG sentences, scored against what the humans wrote.
 *   clean     Professionally edited sentences (UD English PUD) — every suggestion is a false alarm.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkOffline, type OfflineOptions } from '../../extension/src/offline/engine';
import { Speller } from '../../extension/src/offline/speller';
import { loadModelFromDisk } from './model-node';
import { detokenize, diff, readLines, tokens } from '../lib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = join(ROOT, 'training', '.data');
const DICT = join(ROOT, 'shared', 'dictionaries');

const model = loadModelFromDisk(ROOT);
const speller = new Speller(readFileSync(join(DICT, 'en-US.aff'), 'utf8'), readFileSync(join(DICT, 'en-US.dic'), 'utf8'), model);
const OPTS: OfflineOptions = { language: 'en-US', style: 'neutral', app: null, mode: 'fast' };

// ---------------------------------------------------------------- JFLEG
function jfleg() {
  let suggestions = 0;
  let correct = 0;
  let flagged = 0; // suggestion overlaps a human edit (a real problem was found, even if the fix differs)
  let humanEdits = 0;
  let found = 0;
  const byRule = new Map<string, { n: number; ok: number; flag: number }>();
  const misses: string[] = [];
  for (const split of ['dev', 'test']) {
    const src = readLines(join(DATA, 'jfleg', split, `${split}.src`));
    const refs = [0, 1, 2, 3].map((k) => readLines(join(DATA, 'jfleg', split, `${split}.ref${k}`)));
    src.forEach((line, idx) => {
      const text = detokenize(line);
      const srcTok = tokens(text);
      const refEdits = refs.map((r) => diff(srcTok, tokens(detokenize(r[idx] ?? ''))));
      const result = checkOffline(text, OPTS, speller);
      const matchedPerRef = refEdits.map(() => new Set<number>());
      for (const s of result.suggestions) {
        if (!s.replacements.length) continue;
        suggestions++;
        const fixed = text.slice(0, s.offset) + s.replacements[0] + text.slice(s.offset + s.length);
        const ours = diff(srcTok, tokens(fixed));
        const stat = byRule.get(s.rule_id) ?? { n: 0, ok: 0, flag: 0 };
        stat.n++;
        let ok = false;
        let overlap = false;
        refEdits.forEach((edits, r) => {
          for (const o of ours) {
            const k = edits.findIndex((e) => e.start === o.start && e.end === o.end && e.repl === o.repl);
            if (k >= 0) {
              ok = true;
              matchedPerRef[r]!.add(k);
            }
            if (edits.some((e) => (e.start < Math.max(o.end, o.start + 1) && Math.max(e.end, e.start + 1) > o.start))) overlap = true;
          }
          if (!ours.length) overlap = false;
        });
        if (ok) {
          correct++;
          stat.ok++;
        }
        if (ok || overlap) {
          flagged++;
          stat.flag++;
        } else if (misses.length < 400) {
          misses.push(`${s.rule_id}: “${s.original}”→“${s.replacements[0]}” in: ${text}`);
        }
        byRule.set(s.rule_id, stat);
      }
      // Recall against the reference we agree with most.
      let best = 0;
      matchedPerRef.forEach((set, r) => {
        if (set.size > matchedPerRef[best]!.size || (set.size === matchedPerRef[best]!.size && refEdits[r]!.length < refEdits[best]!.length)) best = r;
      });
      humanEdits += refEdits[best]!.length;
      found += matchedPerRef[best]!.size;
    });
  }
  return {
    sentences: 1501,
    suggestions,
    precision: +(correct / suggestions).toFixed(3),
    flag_precision: +(flagged / suggestions).toFixed(3),
    recall: +(found / humanEdits).toFixed(3),
    human_edits: humanEdits,
    corrected: found,
    by_rule: Object.fromEntries([...byRule].sort((a, b) => b[1].n - a[1].n).map(([k, v]) => [k, `${v.ok}/${v.n} exact, ${v.flag}/${v.n} flagged`])),
    _misses: misses,
  };
}

// ---------------------------------------------------------------- spelling (held-out real misspellings)
export function heldOutMisspellings(): Array<[string, string]> {
  const path = join(ROOT, 'training', '.build', 'spelling-heldout.tsv');
  if (!existsSync(path)) throw new Error('Run training/train.sh first (it writes the held-out split).');
  return readLines(path).map((l) => l.split('\t') as [string, string]);
}

function spelling() {
  const pairs = heldOutMisspellings();
  let top1 = 0;
  let top3 = 0;
  let none = 0;
  const misses: string[] = [];
  for (const [typo, right] of pairs) {
    const s = speller.suggest(typo);
    if (!s.length) none++;
    if (s[0] === right) top1++;
    else if (misses.length < 200) misses.push(`${typo} → ${right}: got ${s.slice(0, 3).join(', ')}`);
    if (s.slice(0, 3).includes(right)) top3++;
  }
  return { pairs: pairs.length, top1: +(top1 / pairs.length).toFixed(3), top3: +(top3 / pairs.length).toFixed(3), no_suggestion: none, _misses: misses };
}

// ---------------------------------------------------------------- typos in context (JFLEG)
function typos() {
  let n = 0;
  let detected = 0;
  let top1 = 0;
  const misses: string[] = [];
  for (const split of ['dev', 'test']) {
    const src = readLines(join(DATA, 'jfleg', split, `${split}.src`));
    const refs = [0, 1, 2, 3].map((k) => readLines(join(DATA, 'jfleg', split, `${split}.ref${k}`)));
    src.forEach((line, idx) => {
      const text = detokenize(line);
      const srcTok = tokens(text);
      // Single-word replacements of a non-word that all humans who changed it agree on.
      const wanted = new Map<number, Set<string>>();
      for (const r of refs) {
        for (const e of diff(srcTok, tokens(detokenize(r[idx] ?? '')))) {
          const word = srcTok[e.start]!;
          if (e.end - e.start !== 1 || !/^[a-z]{3,}$/.test(word) || !/^[a-z]+$/i.test(e.repl)) continue;
          if (speller.isCorrect(word) || word.toLowerCase() === e.repl.toLowerCase()) continue;
          (wanted.get(e.start) ?? wanted.set(e.start, new Set()).get(e.start)!).add(e.repl.toLowerCase());
        }
      }
      if (!wanted.size) return;
      const result = checkOffline(text, OPTS, speller);
      // token index → char offset
      let pos = 0;
      const offsets = srcTok.map((t) => {
        const at = text.indexOf(t, pos);
        pos = at + t.length;
        return at;
      });
      for (const [ti, answers] of wanted) {
        n++;
        const s = result.suggestions.find((x) => x.offset === offsets[ti]);
        if (s) detected++;
        if (s && s.replacements[0] && answers.has(s.replacements[0].toLowerCase())) top1++;
        else if (misses.length < 200) misses.push(`${srcTok[ti]} → ${[...answers].join('/')}: got ${s?.replacements.slice(0, 3).join(', ') ?? '(not flagged)'}`);
      }
    });
  }
  return { typos: n, detected: +(detected / n).toFixed(3), top1: +(top1 / n).toFixed(3), _misses: misses };
}

// ---------------------------------------------------------------- clean text (false alarms)
export function conlluSentences(file: string): string[] {
  return readFileSync(join(DATA, file), 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('# text = '))
    .map((l) => l.slice(9).trim());
}

function clean() {
  const sentences = conlluSentences('en_pud-ud-test.conllu');
  let alarms = 0;
  let withAlarm = 0;
  const byRule = new Map<string, number>();
  const examples: string[] = [];
  for (const text of sentences) {
    const r = checkOffline(text, OPTS, speller);
    if (r.suggestions.length) withAlarm++;
    for (const s of r.suggestions) {
      alarms++;
      byRule.set(s.rule_id, (byRule.get(s.rule_id) ?? 0) + 1);
      if (examples.length < 400) examples.push(`${s.rule_id}: “${s.original}”→“${s.replacements[0] ?? '-'}” in: ${text}`);
    }
  }
  return {
    sentences: sentences.length,
    false_alarms: alarms,
    per_100_sentences: +((alarms / sentences.length) * 100).toFixed(2),
    sentences_with_alarm: withAlarm,
    by_rule: Object.fromEntries([...byRule].sort((a, b) => b[1] - a[1])),
    _misses: examples,
  };
}

const benches: Record<string, () => Record<string, unknown>> = { jfleg, spelling, typos, clean };
const which = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const verbose = process.argv.includes('-v');
const out: Record<string, unknown> = {};
for (const name of which.length ? which : Object.keys(benches)) {
  const started = performance.now();
  const r = benches[name]!();
  const misses = r._misses as string[] | undefined;
  delete r._misses;
  r.seconds = +((performance.now() - started) / 1000).toFixed(1);
  out[name] = r;
  if (verbose && misses) console.error(`\n## ${name}\n` + misses.join('\n'));
}
console.log(JSON.stringify(out, null, 2));
