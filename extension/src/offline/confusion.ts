/**
 * Confused real words ("I am form Pakistan", "more then you"): both spellings are dictionary words, so
 * the trained word-pair model decides which one fits between the neighbouring words.
 */
import type { LanguageModel } from './model';
import { RULES, matchCase, type OfflineIssue } from './ruleset';

const WORD = /[\p{L}'’]+/gu;

function sentenceStart(text: string, start: number): boolean {
  const before = text.slice(Math.max(0, start - 40), start);
  if (/\n[\s"'“‘(\[]*$/.test(before)) return true;
  const trimmed = before.replace(/[\s"'“‘(\[]+$/, '');
  if (!trimmed.length) return start - before.length === 0;
  return /[.!?]$/.test(trimmed);
}

export function confusionIssues(text: string, model: LanguageModel): OfflineIssue[] {
  const help = (RULES.maps.confusionHelp ?? {}) as Record<string, string>;
  const words: Array<{ w: string; start: number; end: number }> = [];
  WORD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD.exec(text))) words.push({ w: m[0], start: m.index, end: m.index + m[0].length });
  const issues: OfflineIssue[] = [];
  words.forEach((t, i) => {
    const lower = t.w.toLowerCase();
    if (!model.confusionSet(lower)) return;
    if (t.w !== lower && !(t.w[0] !== lower[0] && t.w.slice(1) === lower.slice(1) && sentenceStart(text, t.start))) return;
    const p = words[i - 1];
    const n = words[i + 1];
    const prev = p && /^[ \t]+$/.test(text.slice(p.end, t.start)) ? p.w.toLowerCase().replace(/’/g, "'") : null;
    const next = n && /^[ \t]+$/.test(text.slice(t.end, n.start)) ? n.w.toLowerCase().replace(/’/g, "'") : null;
    const alt = model.confusionCheck(lower, prev, next);
    if (!alt) return;
    const replacement = matchCase(t.w, alt);
    issues.push({
      start: t.start,
      end: t.end,
      original: t.w,
      replacements: [replacement],
      category: 'grammar',
      severity: 'warning',
      title: 'Word choice',
      message: help[alt] ? `Did you mean “${replacement}”? ${help[alt]}` : `Did you mean “${replacement}”?`,
      ruleId: 'WM_CONFUSED_WORD',
      confidence: 0.8,
      fromRule: false,
    });
  });
  return issues;
}
