/**
 * Interpreter for the shared WriteMind rule set (shared/offline/rules.json).
 * The Windows app interprets the same file in C#, so both clients behave the same.
 */
import data from '../../../shared/offline/rules.json';
import type { Category, Severity } from '../shared/types';

export interface RuleDef {
  id: string;
  category: Category;
  severity: Severity;
  title: string;
  message: string;
  pattern: string;
  flags: string;
  group: number;
  replace?: string[];
  template?: string;
  map?: string;
  mapGroup?: number;
  unlessPrecededBy?: string;
  reverseIfFollowedBy?: string;
  exceptions?: string[];
  exceptGroup?: number;
  skipAllCaps?: boolean;
  skipInCasual?: boolean;
  styles?: string[];
  confidence: number;
}

export interface RuleData {
  chatApps: string[];
  protect: string[];
  allowWords: string[];
  nameParticles?: string[];
  typos: Record<string, string>;
  maps: Record<string, Record<string, string | string[]>>;
  rules: RuleDef[];
  rewrite: {
    formalPhrases: [string, string][];
    casualPhrases: [string, string][];
    concisePhrases: [string, string][];
    contract: [string, string][];
    fillersProfessional: string;
    fillersConcise: string;
    questionStart: string;
  };
}

export const RULES = data as unknown as RuleData;

/** An issue in UTF-16 offsets (JavaScript string indices). */
export interface OfflineIssue {
  start: number;
  end: number;
  original: string;
  replacements: string[];
  category: Category;
  severity: Severity;
  title: string;
  message: string;
  ruleId: string;
  confidence: number;
  fromRule: boolean;
}

interface Compiled {
  def: RuleDef;
  re: RegExp;
  preceded: RegExp | null;
  followed: RegExp | null;
}

let compiled: Compiled[] | null = null;

function compile(): Compiled[] {
  if (!compiled) {
    compiled = RULES.rules.map((def) => ({
      def,
      // "d" exposes group offsets (match.indices); "g" iterates all matches.
      re: new RegExp(def.pattern, `gd${def.flags.includes('i') ? 'i' : ''}`),
      preceded: def.unlessPrecededBy ? new RegExp(def.unlessPrecededBy, 'i') : null,
      followed: def.reverseIfFollowedBy ? new RegExp(def.reverseIfFollowedBy, 'i') : null,
    }));
  }
  return compiled;
}

export function matchCase(source: string, replacement: string): string {
  const first = source[0];
  const r0 = replacement[0];
  if (first && r0 && first === first.toUpperCase() && first !== first.toLowerCase() && r0 === r0.toLowerCase() && r0 !== r0.toUpperCase()) {
    return r0.toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

function fill(template: string, m: RegExpExecArray, mapped: string): string {
  return template.replace(/\{(=|\^?\d)\}/g, (_, token: string) => {
    if (token === '=') return mapped;
    if (token.startsWith('^')) {
      const g = m[Number(token.slice(1))] ?? '';
      return g.charAt(0).toUpperCase() + g.slice(1);
    }
    return m[Number(token)] ?? '';
  });
}

function asList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export interface RuleContext {
  style: string;
  casual: boolean;
}

export function ruleIssues(text: string, ctx: RuleContext): OfflineIssue[] {
  const issues: OfflineIssue[] = [];
  for (const { def, re, preceded, followed } of compile()) {
    if (def.styles && !def.styles.includes(ctx.style)) continue;
    if (def.skipInCasual && ctx.casual) continue;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m[0].length === 0) re.lastIndex++;
      const span = m.indices?.[def.group];
      const target = m[def.group];
      if (!span || target === undefined || target.length === 0) continue;
      if (def.skipAllCaps && target.length > 1 && target === target.toUpperCase()) continue;
      if (def.exceptions && def.exceptions.includes((m[def.exceptGroup ?? def.group] ?? '').toLowerCase())) continue;
      if (preceded && preceded.test(text.slice(Math.max(0, m.index - 40), m.index))) continue;

      let replacements: string[];
      if (def.map) {
        const key = (m[def.mapGroup ?? def.group] ?? '').toLowerCase().replace(/’/g, "'");
        const values = asList(RULES.maps[def.map]?.[key]);
        if (!values.length) continue;
        replacements = def.template ? values.map((v) => fill(def.template!, m!, v)) : [...values];
        if (followed && followed.test(text.slice(span[1]))) replacements.reverse();
      } else if (def.replace) {
        replacements = def.replace.map((t) => fill(t, m!, ''));
      } else {
        replacements = [fill(def.template ?? '', m, '')];
      }
      replacements = replacements.map((r) => matchCase(target, r)).filter((r) => r !== target);
      if (!replacements.length) continue;
      issues.push({
        start: span[0],
        end: span[1],
        original: target,
        replacements,
        category: def.category,
        severity: def.severity,
        title: def.title,
        message: fill(def.message, m, replacements[0]!),
        ruleId: def.id,
        confidence: def.confidence,
        fromRule: true,
      });
    }
  }
  return issues;
}

let protectRes: RegExp[] | null = null;

export function protectedSpans(text: string): Array<[number, number]> {
  protectRes ??= RULES.protect.map((p) => new RegExp(p, 'gi'));
  const spans: Array<[number, number]> = [];
  for (const re of protectRes) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      spans.push([m.index, m.index + m[0].length]);
    }
  }
  return spans;
}

export function overlapsAny(start: number, end: number, spans: Array<[number, number]>): boolean {
  const e = Math.max(end, start + 1);
  return spans.some(([s, f]) => start < f && s < e);
}
