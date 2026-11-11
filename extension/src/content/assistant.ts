import { CheckScheduler } from '../core/scheduler';
import { SuggestionStore } from '../core/store';
import { createAdapter, type EditorAdapter } from '../editors/adapters';
import type { Rect } from '../editors/mirror';
import { findEditableRoot, isSensitiveOrIneligible } from '../editors/sensitive';
import { send } from '../shared/client';
import { WriteMindError } from '../shared/messages';
import {
  DEFAULT_SETTINGS,
  getSettings,
  isSiteDisabled,
  settingsItem,
  updateSettings,
  type LocalSettings,
} from '../shared/settings';
import { CODE_EDITOR_SELECTOR, profileFor, type SiteProfile } from '../shared/sites';
import type { CheckMode, FeedbackAction, RewriteAlternative, RewriteStyle, Style, Suggestion } from '../shared/types';
import { EMPTY_VIEW, ViewStore, type Actions, type FieldStatus, type UnderlineView } from './view';

const MAX_CHARS = 20_000;
const MAX_UNDERLINES = 300;

class FieldSession {
  readonly adapter: EditorAdapter;
  readonly store: SuggestionStore;
  readonly scheduler: CheckScheduler;
  readonly key = Math.random().toString(36).slice(2);
  status: FieldStatus = 'idle';
  /** Set only when the last check failed — the badge must never claim "no issues" then. */
  error: string | null = null;
  /** True once a check has completed for the current text. */
  checked = false;
  words = 0;
  private cleanup: Array<() => void> = [];

  constructor(
    readonly element: HTMLElement,
    private readonly profile: SiteProfile,
    private readonly owner: Assistant,
  ) {
    this.adapter = createAdapter(element, profile.excludeSelector);
    this.store = new SuggestionStore(() => owner.filters());
    this.scheduler = new CheckScheduler((mode) => void this.run(mode), {
      fastDelay: 350,
      fullDelay: 1500,
      fullEnabled: () => owner.settings.aiEnabled,
    });
  }

  start(): void {
    const onChange = () => this.onChange();
    const onScroll = () => this.owner.queueRender();
    this.element.addEventListener('input', onChange);
    this.element.addEventListener('scroll', onScroll, { passive: true });
    this.cleanup.push(() => this.element.removeEventListener('input', onChange));
    this.cleanup.push(() => this.element.removeEventListener('scroll', onScroll));

    const win = this.element.ownerDocument.defaultView!;
    const resize = new win.ResizeObserver(() => this.owner.queueRender());
    resize.observe(this.element);
    this.cleanup.push(() => resize.disconnect());

    if (this.adapter.kind === 'contenteditable') {
      // Catches programmatic changes (e.g. a chat app clearing the box after sending).
      const mo = new win.MutationObserver(() => this.onChange());
      mo.observe(this.element, { childList: true, characterData: true, subtree: true });
      this.cleanup.push(() => mo.disconnect());
    } else {
      // Frameworks may set .value without events; compare cheaply once a second.
      const timer = win.setInterval(() => this.onChange(), 1000);
      this.cleanup.push(() => win.clearInterval(timer));
    }
    this.store.subscribe(() => this.owner.queueRender());
    this.store.setText(this.adapter.getText());
    this.scheduler.poke(true);
  }

  onChange(): void {
    const text = this.adapter.getText();
    if (text === this.store.currentText) return;
    this.store.setText(text);
    this.checked = false;
    this.scheduler.poke();
  }

  /** "No issues" may only be shown after a successful check of the current text. */
  get verifiedClean(): boolean {
    return this.checked && this.error === null && this.status === 'idle';
  }

  async run(mode: CheckMode): Promise<void> {
    const full = this.adapter.getText();
    this.store.setText(full);
    const text = full.length > MAX_CHARS ? full.slice(0, MAX_CHARS) : full;
    if (!text.trim()) {
      this.status = 'idle';
      this.owner.queueRender();
      return;
    }
    const s = this.owner.settings;
    if (mode === 'fast') this.status = 'busy';
    this.owner.queueRender();
    try {
      const response = await send({
        type: 'check',
        fieldKey: this.key,
        payload: {
          text,
          mode,
          language: s.language,
          style: s.style,
          client: { kind: 'chrome-extension', app: this.profile.app },
          dictionary: s.dictionary,
          disabled_rules: s.ignoredRules,
          ai: s.aiEnabled,
        },
      });
      this.store.applyResponse(text, response);
      this.words = response.stats.words;
      this.status = 'idle';
      this.error = null;
      this.checked = true;
    } catch (err) {
      if (err instanceof WriteMindError && err.code === 'aborted') return;
      if (err instanceof WriteMindError && err.code === 'extension_reloaded') {
        // This copy of WriteMind was replaced by an update: remove it instead of showing stale results.
        this.owner.orphaned();
        return;
      }
      this.status = 'error';
      this.error = err instanceof Error ? err.message : 'WriteMind could not check this text.';
    }
    this.owner.queueRender();
    this.owner.reportCount(this.store.visible().length);
  }

  dispose(): void {
    this.scheduler.cancel();
    for (const fn of this.cleanup) fn();
    this.adapter.dispose();
  }
}

export class Assistant implements Actions {
  settings: LocalSettings = DEFAULT_SETTINGS;
  readonly view = new ViewStore();
  private session: FieldSession | null = null;
  private renderQueued = false;
  private cardId: string | null = null;
  private underlineRects: Array<{ id: string; rects: Rect[] }> = [];
  private readonly profile: SiteProfile;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  uiHost: HTMLElement | null = null;
  /** Called when this copy of the content script is outdated (extension updated or removed). */
  onOrphaned: (() => void) | null = null;

  constructor(private readonly doc: Document) {
    this.profile = profileFor(doc.location?.hostname ?? '');
    // Actions are handed to React as bare callbacks (onClick={actions.closeCard}); bind them once.
    const actionNames: Array<keyof Actions> = [
      'accept', 'ignore', 'addToDictionary', 'disableRule', 'closeCard', 'openCard', 'openPanel', 'closePanel',
      'setStyle', 'prepareRewrite', 'setRewriteStyle', 'generateRewrite', 'applyRewrite', 'copy', 'dismissToast',
    ];
    for (const name of actionNames) {
      const method = this[name] as (...args: never[]) => unknown;
      (this as unknown as Record<string, unknown>)[name] = method.bind(this);
    }
  }

  async start(): Promise<void> {
    this.settings = await getSettings();
    this.view.set({ style: this.settings.style });
    settingsItem.watch((value) => {
      this.settings = { ...DEFAULT_SETTINGS, ...(value ?? {}) };
      this.view.set({ style: this.settings.style });
      if (!this.enabledHere()) this.detach();
      else this.session?.store.refresh();
    });
    const win = this.doc.defaultView!;
    this.doc.addEventListener('focusin', this.onFocusIn, true);
    this.doc.addEventListener('mousemove', this.onMouseMove, { capture: true, passive: true });
    this.doc.addEventListener('click', this.onClick, true);
    this.doc.addEventListener('keydown', this.onKeyDown, true);
    win.addEventListener('scroll', this.queueRender, { capture: true, passive: true });
    win.addEventListener('resize', this.queueRender);
    const active = this.deepActiveElement();
    if (active) this.consider(active);
  }

  orphaned(): void {
    this.onOrphaned?.();
  }

  /** Removes every listener and the current session (used when a newer copy takes over). */
  stop(): void {
    const win = this.doc.defaultView;
    this.doc.removeEventListener('focusin', this.onFocusIn, true);
    this.doc.removeEventListener('mousemove', this.onMouseMove, { capture: true });
    this.doc.removeEventListener('click', this.onClick, true);
    this.doc.removeEventListener('keydown', this.onKeyDown, true);
    win?.removeEventListener('scroll', this.queueRender, { capture: true });
    win?.removeEventListener('resize', this.queueRender);
    this.session?.dispose();
    this.session = null;
  }

  enabledHere(): boolean {
    return this.settings.enabled && !isSiteDisabled(this.doc.location?.hostname ?? '', this.settings.disabledSites);
  }

  filters() {
    return {
      dictionary: new Set(this.settings.dictionary.map((w) => w.toLowerCase())),
      ignoredRules: new Set(this.settings.ignoredRules),
      categories: new Set(this.settings.categories),
    };
  }

  private deepActiveElement(): Element | null {
    let el: Element | null = this.doc.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  private isOwnUi(event: Event): boolean {
    return !!this.uiHost && event.composedPath().includes(this.uiHost);
  }

  private onFocusIn = (event: FocusEvent) => {
    if (this.isOwnUi(event)) return;
    const target = event.composedPath()[0] ?? event.target;
    this.consider(target as Element);
  };

  private consider(target: EventTarget): void {
    const root = findEditableRoot(target);
    if (!root || root === this.session?.element) return;
    if (!this.enabledHere()) return;
    // Privacy rule: sensitive fields are never read — not even once.
    if (isSensitiveOrIneligible(root, CODE_EDITOR_SELECTOR)) return;
    this.attach(root);
  }

  private attach(el: HTMLElement): void {
    this.detach();
    this.session = new FieldSession(el, this.profile, this);
    this.session.start();
    this.queueRender();
  }

  private detach(): void {
    this.session?.dispose();
    this.session = null;
    this.cardId = null;
    this.view.set({ ...EMPTY_VIEW, style: this.settings.style, toast: this.view.get().toast });
    this.reportCount(0);
  }

  reportCount(count: number): void {
    void send({ type: 'badge', count }).catch((err: unknown) => {
      if (err instanceof WriteMindError && err.code === 'extension_reloaded') this.orphaned();
    });
  }

  queueRender = (): void => {
    if (this.renderQueued) return;
    this.renderQueued = true;
    const raf = this.doc.defaultView?.requestAnimationFrame ?? ((cb: FrameRequestCallback) => setTimeout(cb, 16));
    raf(() => {
      this.renderQueued = false;
      this.render();
    });
  };

  private render(): void {
    const s = this.session;
    if (!s) return;
    if (!s.element.isConnected) {
      this.detach();
      return;
    }
    const win = this.doc.defaultView!;
    const bounds = s.adapter.getBounds();
    const hidden = bounds.width === 0 || bounds.height === 0;
    const clip = {
      left: Math.max(bounds.left, 0),
      top: Math.max(bounds.top, 0),
      right: Math.min(bounds.right, win.innerWidth),
      bottom: Math.min(bounds.bottom, win.innerHeight),
    };
    const suggestions = s.store.visible();
    const underlines: UnderlineView[] = [];
    this.underlineRects = [];
    if (!hidden) {
      for (const sg of suggestions.slice(0, MAX_UNDERLINES)) {
        const rects = s.adapter
          .getRects(sg.offset, sg.offset + sg.length)
          .filter((r) => r.top + r.height > clip.top && r.top < clip.bottom && r.left + r.width > clip.left && r.left < clip.right)
          .map((r) => {
            const left = Math.max(r.left, clip.left);
            return { left, top: r.top, width: Math.min(r.left + r.width, clip.right) - left, height: r.height };
          });
        if (!rects.length) continue;
        this.underlineRects.push({ id: sg.id, rects });
        underlines.push({ id: sg.id, severity: sg.severity, ai: sg.source === 'ai', rects });
      }
    }

    let card = this.view.get().card;
    if (this.cardId) {
      const sg = suggestions.find((x) => x.id === this.cardId);
      const anchor = this.underlineRects.find((u) => u.id === this.cardId)?.rects[0];
      if (!sg || !anchor) {
        this.cardId = null;
        card = null;
      } else {
        const width = Math.min(320, win.innerWidth - 16);
        const left = Math.min(Math.max(8, anchor.left), win.innerWidth - width - 8);
        const below = anchor.top + anchor.height + 8;
        const top = below + 220 > win.innerHeight ? Math.max(8, anchor.top - 228) : below;
        card = { suggestion: sg, left, top, canEdit: s.adapter.canEdit(sg.offset, sg.offset + sg.length) };
      }
    }

    const badge = hidden
      ? null
      : {
          left: Math.min(Math.max(clip.left, bounds.right - 44), win.innerWidth - 52),
          top: Math.min(Math.max(clip.top, bounds.bottom - 32), win.innerHeight - 32),
          count: suggestions.length,
          score: s.store.score,
          // While a check for the latest text is pending, show progress rather than a stale "all clear".
          status: s.status === 'idle' && suggestions.length === 0 && !s.verifiedClean ? 'busy' : s.status,
          error: s.error,
        };
    this.view.set({
      underlines,
      badge: s.store.currentText.trim() ? badge : null,
      card,
      suggestions,
      words: s.words,
      activeId: this.cardId,
    });
  }

  private hitTest(x: number, y: number): string | null {
    for (const u of this.underlineRects) {
      for (const r of u.rects) {
        if (x >= r.left && x <= r.left + r.width && y >= r.top - 1 && y <= r.top + r.height + 3) return u.id;
      }
    }
    return null;
  }

  private onMouseMove = (event: MouseEvent) => {
    if (!this.session || this.isOwnUi(event)) return;
    const id = this.hitTest(event.clientX, event.clientY);
    if (id !== this.view.get().hoveredId) this.view.set({ hoveredId: id });
  };

  private onClick = (event: MouseEvent) => {
    if (!this.session || this.isOwnUi(event)) return;
    const id = this.hitTest(event.clientX, event.clientY);
    if (id) {
      this.cardId = id;
      this.queueRender();
    } else if (this.cardId) {
      this.closeCard();
    }
  };

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      if (this.cardId) this.closeCard();
      else if (this.view.get().panel.open) this.closePanel();
    }
  };

  // ------------------------------------------------------------------------------- actions

  private feedback(s: Suggestion, action: FeedbackAction): void {
    void send({
      type: 'feedback',
      events: [{ rule_id: s.rule_id, category: s.category, source: s.source, action }],
    }).catch(() => undefined);
  }

  toast(message: string): void {
    this.view.set({ toast: message });
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.view.set({ toast: null }), 4500);
  }

  dismissToast(): void {
    this.view.set({ toast: null });
  }

  /** The only path that edits the user's text — always triggered by an explicit click. */
  accept(s: Suggestion, replacement: string): void {
    const session = this.session;
    if (!session) return;
    void (async () => {
      const result = await session.adapter.apply(s.offset, s.offset + s.length, s.original, replacement);
      if (result.ok) {
        this.feedback(s, 'accepted');
        session.store.remove(s.id);
        session.onChange();
        this.closeCard();
      } else if (result.reason === 'stale') {
        this.toast('The text changed — re-checking.');
        session.store.remove(s.id);
        session.scheduler.poke(true);
      } else if (result.copied) {
        this.toast(`This editor blocked the edit. “${replacement}” was copied — paste it over the highlighted text.`);
      } else {
        this.toast('This editor did not accept the change. Your text was left as it was.');
      }
    })();
  }

  ignore(s: Suggestion): void {
    this.session?.store.ignore(s);
    this.feedback(s, 'ignored');
    this.closeCard();
  }

  addToDictionary(s: Suggestion): void {
    const word = s.original.trim();
    this.settings = { ...this.settings, dictionary: [...this.settings.dictionary, word] };
    void send({ type: 'dictionary.add', word }).catch(() => undefined);
    this.feedback(s, 'added_to_dictionary');
    this.closeCard();
    this.session?.store.refresh();
    this.toast(`“${word}” added to your dictionary.`);
  }

  disableRule(s: Suggestion): void {
    this.settings = { ...this.settings, ignoredRules: [...this.settings.ignoredRules, s.rule_id] };
    void send({ type: 'rule.disable', ruleId: s.rule_id }).catch(() => undefined);
    this.feedback(s, 'rule_disabled');
    this.closeCard();
    this.session?.store.refresh();
    this.toast('Rule turned off. You can re-enable it in Settings.');
  }

  openCard(s: Suggestion): void {
    this.cardId = s.id;
    this.queueRender();
  }

  closeCard(): void {
    this.cardId = null;
    this.view.set({ card: null, activeId: null });
  }

  openPanel(tab: 'issues' | 'rewrite' = 'issues'): void {
    if (!this.session) {
      this.toast('Click into a text field first, then open WriteMind.');
      return;
    }
    this.closeCard();
    this.view.set({ panel: { open: true, tab } });
    if (tab === 'rewrite') this.prepareRewrite();
  }

  closePanel(): void {
    this.view.set({ panel: { ...this.view.get().panel, open: false } });
  }

  setStyle(style: Style): void {
    this.settings = { ...this.settings, style };
    this.view.set({ style });
    void updateSettings({ style });
    this.session?.scheduler.poke(true);
  }

  prepareRewrite(): void {
    const s = this.session;
    if (!s) return;
    const text = s.adapter.getText();
    let sel = s.adapter.getSelection();
    if (!sel || sel.start === sel.end) {
      const caret = sel?.start ?? text.length;
      sel = sentenceAround(text, caret);
    }
    const source = text.slice(sel.start, sel.end);
    const previous = this.view.get().rewrite;
    this.view.set({
      panel: { open: true, tab: 'rewrite' },
      rewrite: {
        source,
        start: sel.start,
        end: sel.end,
        style: previous?.style ?? (this.settings.style === 'neutral' ? 'professional' : (this.settings.style as RewriteStyle)),
        loading: false,
        alternatives: [],
        engine: null,
        error: source.trim() ? null : 'Select a sentence in the field (or place the cursor in one) to rewrite it.',
      },
    });
  }

  setRewriteStyle(style: RewriteStyle): void {
    const r = this.view.get().rewrite;
    if (r) this.view.set({ rewrite: { ...r, style, alternatives: [], engine: null } });
  }

  generateRewrite(): void {
    const r = this.view.get().rewrite;
    if (!r || !r.source.trim()) return;
    this.view.set({ rewrite: { ...r, loading: true, error: null } });
    void (async () => {
      try {
        const res = await send({
          type: 'rewrite',
          payload: {
            text: r.source,
            style: r.style,
            count: 3,
            language: this.settings.language,
            client: { kind: 'chrome-extension', app: this.profile.app },
            ai: this.settings.aiEnabled,
          },
        });
        const current = this.view.get().rewrite;
        if (!current) return;
        this.view.set({
          rewrite: {
            ...current,
            loading: false,
            alternatives: res.alternatives,
            engine: res.engine,
            error: res.alternatives.length ? null : 'Your text already reads well in this style.',
          },
        });
      } catch (err) {
        const current = this.view.get().rewrite;
        if (current) {
          this.view.set({
            rewrite: { ...current, loading: false, error: err instanceof Error ? err.message : 'Rewrite failed.' },
          });
        }
      }
    })();
  }

  applyRewrite(alt: RewriteAlternative): void {
    const s = this.session;
    const r = this.view.get().rewrite;
    if (!s || !r) return;
    void (async () => {
      const result = await s.adapter.apply(r.start, r.end, r.source, alt.text, false);
      if (result.ok) {
        s.onChange();
        this.view.set({ rewrite: null, panel: { open: false, tab: 'issues' } });
        this.toast('Rewrite applied. Press Ctrl+Z to undo.');
      } else if (result.reason === 'stale') {
        this.toast('The text changed since you selected it. Select it again to rewrite.');
        this.prepareRewrite();
      } else {
        this.toast(result.copied ? 'This editor blocked the edit — the rewrite was copied to your clipboard.' : 'Could not apply the rewrite.');
      }
    })();
  }

  copy(text: string): void {
    void this.doc.defaultView?.navigator.clipboard.writeText(text).then(
      () => this.toast('Copied to clipboard.'),
      () => this.toast('Copy failed.'),
    );
  }
}

/** The sentence containing `caret` (used when nothing is selected). */
export function sentenceAround(text: string, caret: number): { start: number; end: number } {
  const boundary = /[.!?…]\s|\n/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(text)) && match.index + match[0].length <= caret) start = match.index + match[0].length;
  boundary.lastIndex = Math.max(caret, start);
  const next = boundary.exec(text);
  let end = next ? next.index + (next[0].trimEnd().length) : text.length;
  if (end < start) end = text.length;
  while (start < end && /\s/.test(text[start]!)) start++;
  while (end > start && /\s/.test(text[end - 1]!)) end--;
  return { start, end };
}
