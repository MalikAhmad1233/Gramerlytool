import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import accuracy from '../../shared/fixtures/accuracy-en.json';
import heldout from '../../shared/fixtures/offline-heldout.json';
import { checkOffline, expandContractions, contract, rewriteOffline, transform, type OfflineOptions } from '../src/offline/engine';
import { Speller } from '../src/offline/speller';

const DICT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'shared', 'dictionaries');
const load = (lang: string) =>
  new Speller(readFileSync(join(DICT_DIR, `${lang}.aff`), 'utf8'), readFileSync(join(DICT_DIR, `${lang}.dic`), 'utf8'));
const speller = load('en-US');
const NEUTRAL: OfflineOptions = { language: 'en-US', style: 'neutral', app: null, mode: 'fast' };

function check(text: string, opts: Partial<OfflineOptions> = {}) {
  return checkOffline(text, { ...NEUTRAL, ...opts }, speller);
}

/** True if applying one suggestion (any of its replacements) turns `bad` into `good`. */
function fixes(bad: string, good: string, opts: Partial<OfflineOptions> = {}): boolean {
  return check(bad, opts).suggestions.some((s) =>
    s.replacements.some((r) => bad.slice(0, s.offset) + r + bad.slice(s.offset + s.length) === good),
  );
}

function allTargets(text: string, original: string, replacement: string): string[] {
  const out: string[] = [];
  for (let i = text.indexOf(original); i >= 0; i = text.indexOf(original, i + 1)) {
    out.push(text.slice(0, i) + replacement + text.slice(i + original.length));
  }
  return out;
}

describe('built-in checker accuracy', () => {
  it.each(accuracy.errors.map((c) => [c.text, c] as const))('fixture error: %s', (_, c) => {
    const ok = allTargets(c.text, c.original, c.replacement).some((good) => fixes(c.text, good));
    expect(ok, JSON.stringify(check(c.text).suggestions.map((s) => [s.original, s.replacements]))).toBe(true);
  });

  it.each([...accuracy.clean, ...heldout.clean])('no false positives: %s', (text) => {
    expect(check(text).suggestions.map((s) => [s.original, s.rule_id])).toEqual([]);
  });

  it.each(heldout.chatClean)('chat messages are not nagged: %s', (text) => {
    expect(check(text, { app: 'whatsapp' }).suggestions.map((s) => [s.original, s.rule_id])).toEqual([]);
  });

  it.each(heldout.errors)('held-out error: %s', (bad, good) => {
    expect(fixes(bad!, good!), JSON.stringify(check(bad!).suggestions.map((s) => [s.original, s.replacements]))).toBe(true);
  });
});

describe('built-in checker behaviour', () => {
  it('offsets are UTF-16 and suggestions slice the text exactly', () => {
    const text = 'Great news 😀 — I recieved teh files and its a great day.';
    const r = check(text);
    for (const s of r.suggestions) expect(text.slice(s.offset, s.offset + s.length)).toBe(s.original);
    expect(r.suggestions.map((s) => s.original)).toEqual(['recieved', 'teh', 'its']);
    expect(r.suggestions[1]!.replacements[0]).toBe('the');
    expect(r.engine.languagetool).toBe('builtin');
  });

  it.each([
    ['This is a apple.', 'This is an apple.'],
    ['We need an new plan.', 'We need a new plan.'],
    ['It took a hour.', 'It took an hour.'],
    ['She is an university student.', 'She is a university student.'],
    ['He has an MBA and a FBI badge.', 'He has an MBA and an FBI badge.'],
  ])('a/an: %s', (bad, good) => expect(fixes(bad, good)).toBe(true));

  it.each(['Plan A and plan B.', 'a European trip', 'a one-time code', 'an honest answer', 'a user', 'a URL'])(
    'a/an leaves correct text alone: %s',
    (text) => expect(check(text).suggestions.filter((s) => s.rule_id === 'WM_A_AN')).toEqual([]),
  );

  it('ignores URLs, e-mails, mentions, code and identifiers', () => {
    const text = 'Mail teh.team@exmaple.com or see https://exmaple.com/teh, ping @johnsmyth, run `npm instal`, use WriteMind and the API.';
    expect(check(text).suggestions.map((s) => s.original)).toEqual([]);
  });

  it('respects the personal dictionary', () => {
    expect(check('Our Zorblax rollout is done, and zorblax works.', { dictionary: ['zorblax'] }).suggestions).toEqual([]);
  });

  it('applies register-specific rules', () => {
    const text = "Hey, I'm gonna send u the report asap!!!";
    const ids = (style: OfflineOptions['style']) => check(text, { style }).suggestions.map((s) => s.rule_id);
    expect(ids('formal')).toEqual(
      expect.arrayContaining(['WM_FORMAL_CONTRACTION', 'WM_INFORMAL_WORD', 'WM_INFORMAL_WORD_FORMAL', 'WM_MULTIPLE_PUNCTUATION']),
    );
    expect(ids('neutral')).not.toContain('WM_INFORMAL_WORD');
    expect(ids('casual')).not.toContain('WM_FORMAL_CONTRACTION');
  });

  it("orders ambiguous expansions by context (it's been → it has)", () => {
    const s = check("It's been great.", { style: 'formal' }).suggestions.find((x) => x.rule_id === 'WM_FORMAL_CONTRACTION');
    expect(s?.replacements).toEqual(['It has', 'It is']);
  });

  it('relaxes capitalisation for chat apps', () => {
    expect(check('hey are you coming tonight').suggestions.map((s) => s.rule_id)).toContain('WM_SENTENCE_START');
    expect(check('hey are you coming tonight', { app: 'whatsapp' }).suggestions).toEqual([]);
  });

  it('works with the British dictionary', () => {
    const gb = load('en-GB');
    expect(checkOffline('The colour of the organisation logo.', { ...NEUTRAL, language: 'en-GB' }, gb).suggestions).toEqual([]);
    expect(check('The colour of the logo.').suggestions.map((s) => s.original)).toEqual(['colour']);
  });

  it('is fast on long documents', () => {
    const text = 'She go to school and I recieved teh files. It seem fine. '.repeat(300);
    const started = performance.now();
    const r = check(text);
    expect(r.suggestions.length).toBe(1200); // go, recieved, teh, seem × 300
    expect(performance.now() - started).toBeLessThan(1500);
  });
});

describe('built-in rewrite', () => {
  it('matches the server-side offline transforms', () => {
    expect(expandContractions("I'm sure it's fine, don't worry")).toBe('I am sure it is fine, do not worry');
    expect(contract('I am sure that it is fine; do not worry')).toBe("I'm sure that it's fine; don't worry");
    expect(transform('hey i just wanted to say thanks', 'formal')).toBe('Hello, I just wanted to say thank you.');
    expect(transform('In order to make a decision, we are able to meet', 'concise')).toBe('To decide, we can meet.');
    expect(transform('I am sure we will assist you', 'casual')).toBe("I'm sure we'll help you.");
    expect(transform('Hi John, thanks', 'formal')).toBe('Hello John, thank you.');
    expect(transform('what time works for you', 'professional')).toBe('What time works for you?');
  });

  it('corrects then restyles', () => {
    const r = rewriteOffline('hey can u send me the report asap', 'formal', 2, 'en-US', speller);
    expect(r.alternatives[0]!.text).toBe('Hello, can you send me the report as soon as possible?');
    const fixed = rewriteOffline('She go to school every day', 'professional', 3, 'en-US', speller);
    expect(fixed.alternatives[0]!.text).toBe('She goes to school every day.');
    expect(fixed.alternatives[0]!.notes[0]).toBe('1 correction(s) applied');
  });
});
