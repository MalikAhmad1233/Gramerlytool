/** Helpers shared by the trainer and the benchmarks. */
import { readFileSync } from 'node:fs';

export function detokenize(line: string): string {
  return line
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/ (n't|'s|'re|'ve|'ll|'d|'m)\b/gi, '$1')
    .replace(/ ([.,!?;:%)\]}])/g, '$1')
    .replace(/([(\[{$]) /g, '$1')
    .replace(/`` ?| ?''/g, '"')
    .replace(/ ' /g, "' ");
}

const TOKEN = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*|[^\s\p{L}\p{N}]/gu;
export const tokens = (s: string) => s.match(TOKEN) ?? [];

export interface Edit {
  start: number; // token index in source
  end: number;
  repl: string; // replacement tokens joined by space
}

/** Token-level diff (LCS) between source and target: the human's edits. */
export function diff(src: string[], tgt: string[]): Edit[] {
  const n = src.length;
  const m = tgt.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = src[i] === tgt[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const edits: Edit[] = [];
  let i = 0;
  let j = 0;
  let open: { i: number; j: number } | null = null;
  const close = () => {
    if (open) edits.push({ start: open.i, end: i, repl: tgt.slice(open.j, j).join(' ') });
    open = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && src[i] === tgt[j]) {
      close();
      i++;
      j++;
    } else {
      open ??= { i, j };
      if (j < m && (i === n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) j++;
      else i++;
    }
  }
  close();
  return edits;
}

export function readLines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').filter((l, i, a) => i < a.length - 1 || l.length > 0);
}

