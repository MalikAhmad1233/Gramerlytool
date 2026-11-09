import type { Suggestion } from '../shared/types';

/** One contiguous change: old[start, oldEnd) became new[start, newEnd). */
export interface Edit {
  start: number;
  oldEnd: number;
  newEnd: number;
}

export function diffRegion(oldText: string, newText: string): Edit | null {
  if (oldText === newText) return null;
  let start = 0;
  const minLen = Math.min(oldText.length, newText.length);
  while (start < minLen && oldText.charCodeAt(start) === newText.charCodeAt(start)) start++;
  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > start && newEnd > start && oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)) {
    oldEnd--;
    newEnd--;
  }
  return { start, oldEnd, newEnd };
}

const WORD = /[\p{L}\p{N}_'’]/u;

/**
 * Moves suggestions computed for `oldText` onto `newText`.
 * Suggestions whose span (or the word it belongs to) was edited are dropped, and every
 * survivor is verified: its span in the new text must still equal `original`.
 */
export function rebaseSuggestions(list: Suggestion[], oldText: string, newText: string): Suggestion[] {
  const edit = diffRegion(oldText, newText);
  if (!edit) return list;
  const delta = edit.newEnd - edit.oldEnd;
  const out: Suggestion[] = [];
  for (const s of list) {
    const end = s.offset + s.length;
    let offset: number;
    if (end < edit.start || (end === edit.start && !touchesWord(newText, edit.start, 'after', s))) {
      offset = s.offset;
    } else if (s.offset > edit.oldEnd || (s.offset === edit.oldEnd && !touchesWord(newText, edit.newEnd, 'before', s))) {
      offset = s.offset + delta;
    } else {
      continue; // the edit overlaps this suggestion
    }
    if (newText.slice(offset, offset + s.length) !== s.original) continue;
    out.push(offset === s.offset ? s : { ...s, offset });
  }
  return out;
}

/** True if the text right at the boundary now glues a word character onto the span. */
function touchesWord(text: string, boundary: number, side: 'after' | 'before', s: Suggestion): boolean {
  if (side === 'after') {
    const next = text[boundary];
    const last = s.original[s.original.length - 1];
    return next !== undefined && last !== undefined && WORD.test(next) && WORD.test(last);
  }
  const prev = text[boundary - 1];
  const first = s.original[0];
  return prev !== undefined && first !== undefined && WORD.test(prev) && WORD.test(first);
}

export function overlaps(a: { offset: number; length: number }, b: { offset: number; length: number }): boolean {
  const aEnd = a.offset + Math.max(a.length, 1);
  const bEnd = b.offset + Math.max(b.length, 1);
  return a.offset < bEnd && b.offset < aEnd;
}

const BOUNDARY_WORD = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}_'’]/u;

/**
 * True if `text[start, end)` still equals `expected` *and* still stands alone as the same token(s):
 * after "go" → "goes", the span 4..6 reads "go" but is now part of a longer word, so applying a
 * replacement there would corrupt the text.
 */
export function spanStillValid(text: string, start: number, end: number, expected: string): boolean {
  if (text.slice(start, end) !== expected) return false;
  const first = expected[0];
  const last = expected[expected.length - 1];
  const before = text[start - 1];
  const after = text[end];
  if (first && before && BOUNDARY_WORD.test(first) && BOUNDARY_WORD.test(before)) return false;
  if (last && after && BOUNDARY_WORD.test(last) && BOUNDARY_WORD.test(after)) return false;
  return true;
}
