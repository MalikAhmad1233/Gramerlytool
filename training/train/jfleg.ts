import { join } from 'node:path';
import { detokenize, diff, readLines, tokens } from '../lib';

export interface ContextTypo {
  typo: string;
  prev: string | null;
  next: string | null;
  answers: string[];
}

const WORDISH = /^[\p{L}'’]+$/u;

/** Misspelled words in JFLEG learner sentences with the single-word corrections people wrote. */
export function contextTypos(dir: string, split: string, isCorrect: (w: string) => boolean): ContextTypo[] {
  const src = readLines(join(dir, `${split}.src`));
  const refs = [0, 1, 2, 3].map((k) => readLines(join(dir, `${split}.ref${k}`)));
  const out: ContextTypo[] = [];
  src.forEach((line, idx) => {
    const srcTok = tokens(detokenize(line));
    const wanted = new Map<number, Set<string>>();
    for (const r of refs) {
      for (const e of diff(srcTok, tokens(detokenize(r[idx] ?? '')))) {
        const word = srcTok[e.start]!;
        if (e.end - e.start !== 1 || !/^[a-z]{3,}$/.test(word) || !/^[a-z]+$/i.test(e.repl)) continue;
        if (isCorrect(word) || word === e.repl.toLowerCase()) continue;
        (wanted.get(e.start) ?? wanted.set(e.start, new Set()).get(e.start)!).add(e.repl.toLowerCase());
      }
    }
    for (const [i, answers] of wanted) {
      const prev = i > 0 && WORDISH.test(srcTok[i - 1]!) ? srcTok[i - 1]!.toLowerCase() : null;
      const next = i + 1 < srcTok.length && WORDISH.test(srcTok[i + 1]!) ? srcTok[i + 1]!.toLowerCase() : null;
      out.push({ typo: srcTok[i]!, prev, next, answers: [...answers] });
    }
  });
  return out;
}
