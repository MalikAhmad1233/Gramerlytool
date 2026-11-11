/**
 * WriteMind built-in checker: works with no server. Grammar rules (shared/offline/rules.json),
 * a/an agreement, and Hunspell spelling. Produces the same CheckResponse shape as the API.
 */
import type { CheckResponse, RewriteAlternative, RewriteResponse, RewriteStyle, Style, Suggestion } from '../shared/types';
import { RULES, matchCase, overlapsAny, protectedSpans, ruleIssues, type OfflineIssue } from './ruleset';
import { confusionIssues } from './confusion';
import { spellingIssues, type Speller } from './speller';

export interface OfflineOptions {
  language: string;
  style: Style;
  app: string | null;
  mode: 'fast' | 'full';
  dictionary?: string[];
}

const SEVERITY_WEIGHT = { error: 4, warning: 2, suggestion: 1 } as const;

export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const CONSONANT_SOUND_PREFIXES = ['uni', 'use', 'usu', 'uti', 'ure', 'uro', 'eu', 'ewe', 'one', 'once', 'ufo', 'uk'];
const VOWEL_SOUND_UNI = ['unin', 'unim', 'unid'];
const SILENT_H = ['hour', 'honest', 'honor', 'honour', 'heir'];
const NOT_A_NOUN = new Set(['and', 'or', 'nor', 'but', 'is', 'are', 'was', 'of', 'to', 'in', 'on', 'at', 'the', 'a', 'an']);

function startsWithVowelSound(word: string, letterName = false): boolean {
  // Acronyms and single letters are read letter by letter: "an FBI agent", "an M.A.", "an F1 car".
  if ((word.length > 1 || letterName) && word === word.toUpperCase()) return 'AEFHILMNORSX'.includes(word[0]!);
  const w = word.toLowerCase();
  if (SILENT_H.some((p) => w.startsWith(p))) return true;
  if (VOWEL_SOUND_UNI.some((p) => w.startsWith(p))) return true;
  if (CONSONANT_SOUND_PREFIXES.some((p) => w.startsWith(p))) return false;
  return 'aeiou'.includes(w[0]!);
}

function articleIssues(text: string): OfflineIssue[] {
  const issues: OfflineIssue[] = [];
  const re = /\b(a|an|A|An)\s+([A-Za-z][A-Za-z'’-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const article = m[1]!;
    const next = m[2]!;
    re.lastIndex = m.index + article.length; // allow "a a" chains to be examined word by word
    if (NOT_A_NOUN.has(next.toLowerCase())) continue;
    if (article[0] === 'A') {
      const before = text.slice(0, m.index).replace(/[\s"'“(]+$/, '');
      if (before.length && !/[.!?]$/.test(before) && !/\n\s*$/.test(text.slice(0, m.index))) continue; // "Plan A"
    }
    const letterName = next.length === 1 && /^[.\d-]/.test(text.slice(m.index + m[0].length, m.index + m[0].length + 1));
    const expected = startsWithVowelSound(next, letterName) ? 'an' : 'a';
    if (article.toLowerCase() === expected) continue;
    const replacement = matchCase(article, expected);
    issues.push({
      start: m.index,
      end: m.index + article.length,
      original: article,
      replacements: [replacement],
      category: 'grammar',
      severity: 'error',
      title: 'Article',
      message:
        expected === 'an'
          ? `Use “an” before words that start with a vowel sound: “an ${next}”.`
          : `Use “a” before words that start with a consonant sound: “a ${next}”.`,
      ruleId: 'WM_A_AN',
      confidence: 0.9,
      fromRule: true,
    });
  }
  return issues;
}

function resolveOverlaps(issues: OfflineIssue[]): OfflineIssue[] {
  const priority = (i: OfflineIssue) => i.confidence + (i.fromRule ? 0.05 : 0);
  const ordered = [...issues].sort((a, b) => priority(b) - priority(a) || a.start - b.start);
  const kept: OfflineIssue[] = [];
  for (const issue of ordered) {
    const e = Math.max(issue.end, issue.start + 1);
    if (kept.some((k) => issue.start < Math.max(k.end, k.start + 1) && k.start < e)) continue;
    kept.push(issue);
  }
  return kept.sort((a, b) => a.start - b.start);
}

export function isCasual(style: Style, app: string | null): boolean {
  if (style === 'professional' || style === 'formal') return false;
  return style === 'casual' || (app !== null && RULES.chatApps.includes(app));
}

export function findIssues(text: string, opts: OfflineOptions, speller: Speller | null): OfflineIssue[] {
  const english = opts.language.toLowerCase().startsWith('en');
  if (!english || !text.trim()) return [];
  const protectedRanges = protectedSpans(text);
  const all = [
    ...ruleIssues(text, { style: opts.style, casual: isCasual(opts.style, opts.app) }),
    ...articleIssues(text),
    ...(speller ? spellingIssues(text, speller, new Set((opts.dictionary ?? []).map((w) => w.toLowerCase()))) : []),
    ...(speller?.model ? confusionIssues(text, speller.model) : []),
  ].filter((i) => !overlapsAny(i.start, i.end, protectedRanges));
  return resolveOverlaps(all);
}

export function checkOffline(text: string, opts: OfflineOptions, speller: Speller | null): CheckResponse {
  const started = Date.now();
  const issues = findIssues(text, opts, speller);
  const suggestions: Suggestion[] = issues.map((i) => ({
    id: `o_${fnv1a(`${i.ruleId}|${i.start}|${i.original}|${i.replacements[0] ?? ''}`)}`,
    fingerprint: fnv1a(`${i.ruleId}|${i.original}|${text.slice(Math.max(0, i.start - 12), i.start)}|${text.slice(i.end, i.end + 12)}`) +
      fnv1a(i.original),
    offset: i.start,
    length: i.end - i.start,
    original: i.original,
    replacements: i.replacements,
    category: i.category,
    severity: i.severity,
    title: i.title,
    message: i.message,
    rule_id: i.ruleId,
    source: 'writemind',
    confidence: i.confidence,
  }));
  const words = (text.match(/[\p{L}\p{N}'’-]+/gu) ?? []).length;
  const issuesByCategory = { grammar: 0, spelling: 0, punctuation: 0, style: 0, clarity: 0 };
  let weighted = 0;
  for (const s of suggestions) {
    issuesByCategory[s.category]++;
    weighted += SEVERITY_WEIGHT[s.severity];
  }
  const per100 = (weighted * 100) / Math.max(words, 50);
  return {
    text_hash: fnv1a(text),
    language: opts.language,
    style: opts.style,
    mode: opts.mode,
    suggestions,
    stats: {
      characters: text.length,
      words,
      sentences: text.split(/(?<=[.!?])\s+|\n+/).filter((s) => /\w/.test(s)).length,
      issues: issuesByCategory,
      score: words ? Math.max(0, Math.min(100, Math.round(100 * Math.exp(-per100 / 30)))) : 100,
    },
    engine: { languagetool: 'builtin', ai: 'unavailable', paragraphs_checked: 1, paragraphs_cached: 0, latency_ms: Date.now() - started },
  };
}

// ------------------------------------------------------------------------------------- rewrite

const RW = RULES.rewrite;
const APOS = "['’]";

function subPreservingCase(pattern: string, replacement: string, text: string): string {
  return text.replace(new RegExp(pattern, 'gi'), (found: string, ...args: unknown[]) => {
    const offset = args[args.length - 2] as number;
    const whole = args[args.length - 1] as string;
    if (replacement && found[0] && found[0] !== found[0].toLowerCase()) return replacement[0]!.toUpperCase() + replacement.slice(1);
    if (replacement && found[0] && found[0] === found[0].toLowerCase() && replacement[0] !== replacement[0]!.toLowerCase() && replacement !== 'I') {
      if (!/(^|[.!?]\s+)$/.test(whole.slice(0, offset))) return replacement[0]!.toLowerCase() + replacement.slice(1);
    }
    return replacement;
  });
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function firstOf(v: string | string[]): string {
  return Array.isArray(v) ? v[0]! : v;
}

export function expandContractions(text: string): string {
  const map = RULES.maps.formalContractions!;
  return text.replace(/(?<![\w'’])[A-Za-z]+['’][a-z]+(?![\w'’])/g, (word) => {
    const expanded = map[word.toLowerCase().replace(/’/g, "'")];
    if (!expanded) return word;
    const e = firstOf(expanded);
    return word[0] !== word[0]!.toLowerCase() ? e[0]!.toUpperCase() + e.slice(1) : e;
  });
}

export function contract(text: string): string {
  for (const [full, short] of RW.contract) text = subPreservingCase(`\\b${escapeRe(full)}\\b`, short, text);
  return text;
}

function replaceInformal(text: string, formal: boolean): string {
  const entries: Array<[string, string | string[]]> = [
    ...Object.entries(RULES.maps.informal!),
    ...(formal ? Object.entries(RULES.maps.informalFormal!) : []),
  ];
  for (const [word, value] of entries) {
    const list = Array.isArray(value) ? value : [value];
    const choice = formal && list.length > 1 && ['thx', 'thanx', 'dunno'].includes(word) ? list[list.length - 1]! : list[0]!;
    const pattern = `(?<![\\w'’@#])${escapeRe(word).replace(/'/g, APOS)}(?![\\w'’])`;
    text = subPreservingCase(pattern, choice, text);
  }
  return text;
}

export function tidy(text: string): string {
  text = text.replace(/(?<![\w'’])i(?![\w'’])/g, 'I');
  text = text.replace(/\bi(['’](?:m|ve|ll|d))\b/g, 'I$1');
  text = text.replace(/([!?])\1+/g, '$1');
  text = text.replace(/[ \t]{2,}/g, ' ');
  text = text.replace(/\s+([,.;:!?])/g, '$1');
  text = text.replace(
    /^(\s*(?:[Hh]ello|[Hh]i|[Hh]ey|[Gg]reetings|[Gg]ood (?:morning|afternoon|evening)))(?=\s+(?:I\b|[a-z]))/,
    '$1,',
  );
  text = text.replace(/(^\s*|[.!?]\s+)([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase());
  const stripped = text.trimEnd();
  const last = stripped[stripped.length - 1];
  if (last && /[\p{L}\p{N}]/u.test(last)) {
    const lastSentence = stripped.split(/(?<=[.!?])\s+/).pop() ?? '';
    const mark = new RegExp(RW.questionStart, 'i').test(lastSentence) ? '?' : '.';
    text = stripped + mark + text.slice(stripped.length);
  }
  return text;
}

export function transform(text: string, style: RewriteStyle): string {
  let out = text;
  if (style === 'professional' || style === 'formal') {
    out = replaceInformal(out, style === 'formal');
    out = out.replace(new RegExp(RW.fillersProfessional, 'gi'), '');
    if (style === 'formal') {
      out = expandContractions(out);
      for (const [p, r] of RW.formalPhrases) out = subPreservingCase(p, r, out);
    }
  } else if (style === 'casual' || style === 'friendly') {
    out = contract(out);
    for (const [p, r] of RW.casualPhrases) out = subPreservingCase(p, r, out);
    if (style === 'friendly') out = replaceInformal(out, false);
  } else if (style === 'concise') {
    for (const [p, r] of RW.concisePhrases) out = subPreservingCase(p, r, out);
    out = out.replace(new RegExp(RW.fillersConcise, 'gi'), '');
    out = replaceInformal(out, false);
  }
  return tidy(out);
}

const normalise = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

export function rewriteOffline(text: string, style: RewriteStyle, count: number, language: string, speller: Speller | null): RewriteResponse {
  const started = Date.now();
  const source = text.trim();
  const fixes = findIssues(source, { language, style: 'neutral', app: null, mode: 'fast' }, speller).filter(
    (i) => i.category !== 'style' && i.category !== 'clarity' && i.replacements.length && i.confidence >= 0.85,
  );
  let corrected = source;
  for (const f of [...fixes].sort((a, b) => b.start - a.start)) {
    corrected = corrected.slice(0, f.start) + f.replacements[0] + corrected.slice(f.end);
  }
  const candidates: Array<[string, string[]]> = [];
  if (language.toLowerCase().startsWith('en')) {
    const notes = [`Adjusted for a ${style} tone`];
    if (fixes.length) notes.unshift(`${fixes.length} correction(s) applied`);
    candidates.push([transform(corrected, style).trim(), notes]);
  }
  if (fixes.length) candidates.push([corrected.trim(), [`${fixes.length} correction(s) applied only`]]);
  const seen = new Set([normalise(source)]);
  const alternatives: RewriteAlternative[] = [];
  for (const [candidate, notes] of candidates) {
    if (!candidate || seen.has(normalise(candidate))) continue;
    seen.add(normalise(candidate));
    alternatives.push({ text: candidate, source: 'rules', meaning_preserved: true, notes });
    if (alternatives.length >= count) break;
  }
  return { style, alternatives, engine: 'rules', latency_ms: Date.now() - started };
}
