import { diffRegion, rebaseSuggestions } from '../src/core/rebase';
import { CheckScheduler } from '../src/core/scheduler';
import { SuggestionStore } from '../src/core/store';
import { sentenceAround } from '../src/content/assistant';
import type { CheckResponse, Suggestion } from '../src/shared/types';
import { CATEGORIES } from '../src/shared/types';

function sg(text: string, original: string, extra: Partial<Suggestion> = {}, from = 0): Suggestion {
  const offset = text.indexOf(original, from);
  if (offset < 0) throw new Error(`"${original}" not in text`);
  return {
    id: `s_${original}_${offset}`,
    fingerprint: `f_${original}`,
    offset,
    length: original.length,
    original,
    replacements: ['x'],
    category: 'grammar',
    severity: 'error',
    title: 't',
    message: 'm',
    rule_id: 'R',
    source: 'languagetool',
    confidence: 0.9,
    ...extra,
  };
}

function response(suggestions: Suggestion[], mode: 'fast' | 'full' = 'fast'): CheckResponse {
  return {
    text_hash: 'h',
    language: 'en-US',
    style: 'neutral',
    mode,
    suggestions,
    stats: { characters: 0, words: 0, sentences: 0, issues: { grammar: 0, spelling: 0, punctuation: 0, style: 0, clarity: 0 }, score: 90 },
    engine: { languagetool: 'ok', ai: 'skipped', paragraphs_checked: 1, paragraphs_cached: 0, latency_ms: 1 },
  };
}

describe('rebase', () => {
  const text = 'She go to school and I recieved teh files.';
  const list = [sg(text, 'go'), sg(text, 'recieved'), sg(text, 'teh')];

  it('finds the single edited region', () => {
    expect(diffRegion('abcdef', 'abXYef')).toEqual({ start: 2, oldEnd: 4, newEnd: 4 });
    expect(diffRegion('same', 'same')).toBeNull();
  });

  it('shifts suggestions after an edit and keeps those before it', () => {
    const next = text.replace('school', 'the big school');
    const out = rebaseSuggestions(list, text, next);
    expect(out.map((s) => [s.original, s.offset])).toEqual([
      ['go', 4],
      ['recieved', next.indexOf('recieved')],
      ['teh', next.indexOf('teh')],
    ]);
  });

  it('drops suggestions whose span was edited', () => {
    const next = text.replace('recieved', 'received');
    expect(rebaseSuggestions(list, text, next).map((s) => s.original)).toEqual(['go', 'teh']);
  });

  it('drops suggestions when a word is extended at its boundary', () => {
    const next = text.replace('teh files', 'tehr files');
    expect(rebaseSuggestions(list, text, next).map((s) => s.original)).toEqual(['go', 'recieved']);
    const prefixed = text.replace(' go ', ' ago ');
    expect(rebaseSuggestions(list, text, prefixed).map((s) => s.original)).toEqual(['recieved', 'teh']);
  });

  it('keeps suggestions when a space or punctuation is typed at the boundary', () => {
    const next = text.replace('teh files.', 'teh files. Thanks');
    expect(rebaseSuggestions(list, text, next)).toHaveLength(3);
  });
});

describe('SuggestionStore', () => {
  const filters = () => ({ dictionary: new Set<string>(), ignoredRules: new Set<string>(), categories: new Set(CATEGORIES) });

  it('rebases a response computed for older text', () => {
    const store = new SuggestionStore(filters);
    const sent = 'I recieved it.';
    store.setText(sent + ' More words');
    store.applyResponse(sent, response([sg(sent, 'recieved')]));
    expect(store.visible().map((s) => s.offset)).toEqual([2]);
    store.setText('Yes, ' + store.currentText);
    expect(store.visible().map((s) => s.offset)).toEqual([7]);
  });

  it('keeps AI suggestions across fast responses until overlapped', () => {
    const store = new SuggestionStore(filters);
    const text = 'The weather are nice and she go home.';
    store.setText(text);
    store.applyResponse(text, response([sg(text, 'are', { source: 'ai', id: 'ai1' }), sg(text, 'go')], 'full'));
    store.applyResponse(text, response([sg(text, 'go')], 'fast'));
    expect(store.visible().map((s) => s.original)).toEqual(['are', 'go']);
    store.applyResponse(text, response([sg(text, 'are', { id: 'lt-are' })], 'fast'));
    expect(store.visible().map((s) => s.id)).toEqual(['lt-are']);
  });

  it('filters ignored fingerprints, rules, categories and dictionary words', () => {
    const dictionary = new Set(['kubectl']);
    const ignoredRules = new Set(['NOISY']);
    const categories = new Set(CATEGORIES.filter((c) => c !== 'style'));
    const store = new SuggestionStore(() => ({ dictionary, ignoredRules, categories }));
    const text = 'Run kubectl now gonna go teh';
    store.setText(text);
    store.applyResponse(
      text,
      response([
        sg(text, 'kubectl', { category: 'spelling' }),
        sg(text, 'now', { rule_id: 'NOISY' }),
        sg(text, 'gonna', { category: 'style' }),
        sg(text, 'go'),
        sg(text, 'teh', { category: 'spelling' }),
      ]),
    );
    expect(store.visible().map((s) => s.original)).toEqual(['go', 'teh']);
    store.ignore(store.visible()[0]!);
    expect(store.visible().map((s) => s.original)).toEqual(['teh']);
  });

  it('clears everything when the field is emptied', () => {
    const store = new SuggestionStore(filters);
    store.setText('teh');
    store.applyResponse('teh', response([sg('teh', 'teh')]));
    store.setText('   ');
    expect(store.visible()).toEqual([]);
    expect(store.score).toBeNull();
  });
});

describe('CheckScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces fast and full checks', () => {
    const runs: string[] = [];
    const scheduler = new CheckScheduler((m) => runs.push(m), { fastDelay: 300, fullDelay: 1000, fullEnabled: () => true });
    scheduler.poke();
    vi.advanceTimersByTime(200);
    scheduler.poke(); // typing continues
    vi.advanceTimersByTime(299);
    expect(runs).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(runs).toEqual(['fast']);
    vi.advanceTimersByTime(700);
    expect(runs).toEqual(['fast', 'full']);
  });

  it('skips full checks when AI is off', () => {
    const runs: string[] = [];
    const scheduler = new CheckScheduler((m) => runs.push(m), { fastDelay: 10, fullDelay: 20, fullEnabled: () => false });
    scheduler.poke(true);
    vi.advanceTimersByTime(100);
    expect(runs).toEqual(['fast']);
  });
});

describe('sentenceAround', () => {
  const text = 'First sentence. The second one is here! Third?';
  it.each([
    [3, 'First sentence.'],
    [20, 'The second one is here!'],
    [text.length, 'Third?'],
  ])('caret %d → %s', (caret, expected) => {
    const { start, end } = sentenceAround(text, caret);
    expect(text.slice(start, end)).toBe(expected);
  });
});

describe('spanStillValid', () => {
  it('requires equality and intact word boundaries', async () => {
    const { spanStillValid } = await import('../src/core/rebase');
    expect(spanStillValid('She go home', 4, 6, 'go')).toBe(true);
    expect(spanStillValid('She goes home', 4, 6, 'go')).toBe(false);
    expect(spanStillValid('She ago home', 5, 7, 'go')).toBe(false);
    expect(spanStillValid('Send the the report', 5, 9, 'the ')).toBe(true);
    expect(spanStillValid('Hi , there', 2, 4, ' ,')).toBe(true);
    expect(spanStillValid('漢字テスト', 1, 3, '字テ')).toBe(true); // no word-boundary rule for CJK
  });
});

describe('Assistant actions', () => {
  it('can be passed around as bare callbacks (bound to the instance)', async () => {
    const { Assistant } = await import('../src/content/assistant');
    const assistant = new Assistant(document);
    const { closePanel, dismissToast, closeCard } = assistant;
    assistant.view.set({ panel: { open: true, tab: 'issues' }, toast: 'hi' });
    closePanel();
    dismissToast();
    closeCard();
    expect(assistant.view.get().panel.open).toBe(false);
    expect(assistant.view.get().toast).toBeNull();
  });
});
