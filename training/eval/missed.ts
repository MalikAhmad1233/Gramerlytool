// Most frequent human corrections in JFLEG dev (what to teach the checker next).
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detokenize, diff, readLines, tokens } from '../lib';
const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', '.data', 'jfleg');
const counts = new Map<string, number>();
for (const split of ['dev']) {
  const src = readLines(join(DATA, split, `${split}.src`));
  const refs = [0, 1, 2, 3].map((k) => readLines(join(DATA, split, `${split}.ref${k}`)));
  src.forEach((line, i) => {
    const s = tokens(detokenize(line));
    const seen = new Set<string>();
    for (const r of refs) for (const e of diff(s, tokens(detokenize(r[i]!)))) {
      const before = s.slice(Math.max(0, e.start - 1), e.start).join(' ');
      const k = `${s.slice(e.start, e.end).join(' ') || '∅'} → ${e.repl || '∅'}`;
      const key = e.end - e.start <= 2 && e.repl.split(' ').length <= 2 ? k : '';
      if (key && !seen.has(key)) { seen.add(key); counts.set(key, (counts.get(key) ?? 0) + 1); }
      void before;
    }
  });
}
console.log([...counts].sort((a, b) => b[1] - a[1]).slice(0, 150).map(([k, v]) => `${v} ${k}`).join(' | '));
