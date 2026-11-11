/**
 * Confused real words ("I am form Pakistan", "more then", "loose weight"): a dictionary can't catch
 * these because both spellings are words. For each set we measure how the n-gram model scores the
 * written word against its alternatives, on ~70,000 sentences of edited text, and pick the margin
 * that keeps false alarms on correct text rare while still catching most deliberate swaps.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LanguageModel } from '../../extension/src/offline/model';

export const CANDIDATE_SETS: Array<[string, string]> = [
  ['then|than', 'then/than'],
  ['there|their', 'there/their'],
  ['form|from', 'form/from'],
  ['of|off', 'of/off'],
  ['lose|loose', 'lose/loose'],
  ['loss|lose', 'loss/lose'],
  ['affect|effect', 'affect/effect'],
  ['accept|except', 'accept/except'],
  ['advice|advise', 'advice/advise'],
  ['weather|whether', 'weather/whether'],
  ['quiet|quite', 'quiet/quite'],
  ['were|where', 'were/where'],
  ['to|too', 'to/too'],
  ['know|now', 'know/now'],
  ['knew|new', 'knew/new'],
  ['no|know', 'no/know'],
  ['buy|by', 'buy/by'],
  ['write|right', 'write/right'],
  ['weak|week', 'weak/week'],
  ['here|hear', 'here/hear'],
  ['piece|peace', 'piece/peace'],
  ['brake|break', 'brake/break'],
  ['principal|principle', 'principal/principle'],
  ['past|passed', 'past/passed'],
  ['though|thought|through', 'though/thought/through'],
  ['breath|breathe', 'breath/breathe'],
  ['chose|choose', 'chose/choose'],
  ['lead|led', 'lead/led'],
  ['cloth|clothes', 'cloth/clothes'],
  ['desert|dessert', 'desert/dessert'],
  ['hole|whole', 'hole/whole'],
  ['meat|meet', 'meat/meet'],
  ['plain|plane', 'plain/plane'],
  ['role|roll', 'role/roll'],
  ['sight|site', 'sight/site'],
  ['wait|weight', 'wait/weight'],
  ['wear|where', 'wear/where'],
  ['our|are', 'our/are'],
  ['an|and', 'an/and'],
  ['the|they', 'the/they'],
  ['live|life', 'live/life'],
  ['success|succeed', 'success/succeed'],
  ['worst|worse', 'worst/worse'],
  ['felt|fell', 'felt/fell'],
  ['compliment|complement', 'compliment/complement'],
  ['stationary|stationery', 'stationary/stationery'],
  ['council|counsel', 'council/counsel'],
  ['began|begun', 'began/begun'],
  ['every|very', 'every/very'],
  ['want|went', 'want/went'],
  ['its|is', 'its/is'],
  ['if|of', 'if/of'],
  ['your|you', 'your/you'],
  ['beside|besides', 'beside/besides'],
  ['dose|does', 'dose/does'],
  ['much|many', 'much/many'],
];

const WORD = /[\p{L}'’]+/gu;

function detokenizeWiki(line: string): string {
  return line
    .replace(/ @(.)@ /g, '$1')
    .replace(/ ([.,;:!?%)'])/g, '$1')
    .replace(/\( /g, '(')
    .replace(/ n't/g, "n't")
    .trim();
}

export function cleanSentences(data: string): string[] {
  const out: string[] = [];
  for (const f of ['en_ewt-ud-train.conllu', 'en_gum-ud-train.conllu']) {
    for (const l of readFileSync(join(data, f), 'utf8').split('\n')) if (l.startsWith('# text = ')) out.push(l.slice(9).trim());
  }
  for (const l of readFileSync(join(data, 'wikitext-2-train.txt'), 'utf8').split('\n')) {
    if (!l.trim() || l.trim().startsWith('=') || l.includes('<unk>')) continue;
    out.push(...detokenizeWiki(l).split(/(?<=[.!?]) (?=[A-Z])/));
  }
  const big = readFileSync(join(data, 'big.txt'), 'utf8').replace(/\s+/g, ' ');
  out.push(...big.split(/(?<=[.!?]) (?=[A-Z"])/).filter((s) => s.length > 20 && s.length < 400));
  return out;
}

export interface Occurrence {
  word: string;
  prev: string | null;
  next: string | null;
}

/** Words of a sentence with their neighbours, using the same neighbour rule as the checker. */
export function occurrences(sentence: string, wanted: Set<string>): Occurrence[] {
  const out: Occurrence[] = [];
  const words: Array<{ w: string; start: number; end: number }> = [];
  WORD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD.exec(sentence))) words.push({ w: m[0], start: m.index, end: m.index + m[0].length });
  words.forEach((t, i) => {
    const lower = t.w.toLowerCase();
    if (!wanted.has(lower)) return;
    if (t.w !== lower && i > 0) return; // capitalised mid-sentence: a name or title
    const p = words[i - 1];
    const n = words[i + 1];
    const prev = p && /^[ \t]+$/.test(sentence.slice(p.end, t.start)) ? p.w.toLowerCase() : null;
    const next = n && /^[ \t]+$/.test(sentence.slice(t.end, n.start)) ? n.w.toLowerCase() : null;
    out.push({ word: lower, prev, next });
  });
  return out;
}

export function trainConfusions(model: LanguageModel, data: string, log: (...a: unknown[]) => void): string[] {
  const sentences = cleanSentences(data);
  log(`confused words: ${sentences.length} sentences of edited text`);
  const all = new Set(CANDIDATE_SETS.flatMap(([s]) => s.split('|')));
  // Even-numbered sentences tune the margins; odd-numbered ones are only used to report the result.
  const train: Occurrence[] = [];
  const test: Occurrence[] = [];
  let trainWords = 0;
  let testWords = 0;
  sentences.forEach((s, i) => {
    (i % 2 ? test : train).push(...occurrences(s, all));
    const n = s.split(/\s+/).length;
    if (i % 2) testWords += n;
    else trainWords += n;
  });
  log(`confused words: ${trainWords} words to tune on, ${testWords} words to test on`);
  // False-alarm budget per set: at most 1 per 100,000 words of ordinary text, and at most 1 in 200 uses
  // of the word itself (so frequent words like "the" get a much stricter margin than rare ones).
  const BUDGET = 1 / 150_000;
  const out: string[] = [];
  for (const [spec, title] of CANDIDATE_SETS) {
    const words = spec.split('|');
    if (!words.every((w) => model.unigram(w) < model.weights.unknown)) continue;
    model.setConfusion({ words, margin: 0, title });
    const inSet = (o: Occurrence) => words.includes(o.word);
    const evaluate = (occ: Occurrence[]) => {
      const natural: number[] = []; // gain on correct text: anything above the margin is a false alarm
      const swapped: number[] = []; // gain after replacing the word with an alternative: above margin = caught
      for (const o of occ.filter(inSet)) {
        const r = model.confusionGain(o.word, o.prev, o.next);
        natural.push(r ? r.gain : -Infinity);
        for (const alt of words) {
          if (alt === o.word) continue;
          const s = model.confusionGain(alt, o.prev, o.next);
          swapped.push(s && s.alternative === o.word ? s.gain : -Infinity);
        }
      }
      return { natural, swapped };
    };
    const { natural, swapped } = evaluate(train);
    if (natural.length < 40) {
      log(`  ${spec}: only ${natural.length} examples, skipped`);
      continue;
    }
    // Smallest margin within the false-alarm budget (and never below 1500, i.e. 4.5× more likely).
    const sorted = natural.filter((g) => g > -Infinity).sort((a, b) => b - a);
    const allowed = Math.min(Math.floor(trainWords * BUDGET), Math.floor(natural.length / 200));
    const margin = Math.max(1500, (sorted[allowed] ?? 0) + 1);
    const t = evaluate(test);
    const alarms = t.natural.filter((g) => g > margin).length;
    const per100k = (alarms / testWords) * 100_000;
    const recall = t.swapped.filter((g) => g > margin).length / Math.max(1, t.swapped.length);
    const keep = recall >= 0.2 && per100k <= 2.5 && alarms / Math.max(1, t.natural.length) <= 0.006;
    log(`  ${keep ? 'keep' : 'drop'} ${spec}: margin ${margin}, test: ${alarms} false alarms (${per100k.toFixed(1)} per 100k words, ${t.natural.length} uses), catches ${(recall * 100).toFixed(1)}% of swaps`);
    if (keep) out.push(`${spec}\t${margin}\t${title}`);
  }
  log(`confused words: kept ${out.length} of ${CANDIDATE_SETS.length} sets`);
  return out;
}
