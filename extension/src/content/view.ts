import type { Rect } from '../editors/mirror';
import type { RewriteAlternative, RewriteStyle, Severity, Style, Suggestion } from '../shared/types';

export interface UnderlineView {
  id: string;
  severity: Severity;
  ai: boolean;
  rects: Rect[];
}

export type FieldStatus = 'idle' | 'busy' | 'error';

export interface RewriteState {
  source: string;
  start: number;
  end: number;
  style: RewriteStyle;
  loading: boolean;
  alternatives: RewriteAlternative[];
  engine: 'ai' | 'rules' | null;
  error: string | null;
}

export interface ViewState {
  underlines: UnderlineView[];
  hoveredId: string | null;
  activeId: string | null;
  badge: { left: number; top: number; count: number; score: number | null; status: FieldStatus; error: string | null } | null;
  card: { suggestion: Suggestion; left: number; top: number; canEdit: boolean } | null;
  panel: { open: boolean; tab: 'issues' | 'rewrite' };
  suggestions: Suggestion[];
  words: number;
  style: Style;
  rewrite: RewriteState | null;
  toast: string | null;
}

export const EMPTY_VIEW: ViewState = {
  underlines: [],
  hoveredId: null,
  activeId: null,
  badge: null,
  card: null,
  panel: { open: false, tab: 'issues' },
  suggestions: [],
  words: 0,
  style: 'neutral',
  rewrite: null,
  toast: null,
};

export interface Actions {
  accept(s: Suggestion, replacement: string): void;
  ignore(s: Suggestion): void;
  addToDictionary(s: Suggestion): void;
  disableRule(s: Suggestion): void;
  closeCard(): void;
  openCard(s: Suggestion): void;
  openPanel(tab?: 'issues' | 'rewrite'): void;
  closePanel(): void;
  setStyle(style: Style): void;
  prepareRewrite(): void;
  setRewriteStyle(style: RewriteStyle): void;
  generateRewrite(): void;
  applyRewrite(alt: RewriteAlternative): void;
  copy(text: string): void;
  dismissToast(): void;
}

export class ViewStore {
  private state: ViewState = EMPTY_VIEW;
  private listeners = new Set<() => void>();

  get = (): ViewState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(patch: Partial<ViewState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
}
