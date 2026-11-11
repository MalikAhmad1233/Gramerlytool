import { useSyncExternalStore } from 'react';
import type { Actions, ViewState, ViewStore } from '../content/view';
import type { Category, RewriteStyle, Style, Suggestion } from '../shared/types';
import { REWRITE_STYLES, STYLES } from '../shared/types';

const CATEGORY_LABEL: Record<Category, string> = {
  grammar: 'Grammar',
  spelling: 'Spelling',
  punctuation: 'Punctuation',
  style: 'Style',
  clarity: 'Clarity',
};
const STYLE_LABEL: Record<Style | RewriteStyle, string> = {
  neutral: 'Neutral',
  professional: 'Professional',
  casual: 'Casual',
  formal: 'Formal',
  friendly: 'Friendly',
  concise: 'Concise',
};

export function App({ store, actions }: { store: ViewStore; actions: Actions }) {
  const view = useSyncExternalStore(store.subscribe, store.get);
  return (
    <div className="wm-root" data-testid="wm-root">
      <Underlines view={view} />
      {view.badge && <Badge view={view} actions={actions} />}
      {view.card && <Card view={view} actions={actions} />}
      {view.panel.open && <Panel view={view} actions={actions} />}
      {view.toast && (
        <div className="wm-toast" role="status" onClick={actions.dismissToast}>
          {view.toast}
        </div>
      )}
    </div>
  );
}

function Underlines({ view }: { view: ViewState }) {
  return (
    <>
      {view.underlines.flatMap((u) =>
        u.rects.map((r, i) => (
          <div
            key={`${u.id}:${i}`}
            data-testid="wm-underline"
            data-suggestion-id={u.id}
            className={`wm-underline ${u.ai ? 'ai' : u.severity}${view.hoveredId === u.id ? ' hover' : ''}${
              view.activeId === u.id ? ' active' : ''
            }`}
            style={{ left: r.left, top: r.top + r.height - 1, width: Math.max(r.width, 4) }}
          />
        )),
      )}
      {view.underlines
        .filter((u) => u.id === view.hoveredId || u.id === view.activeId)
        .flatMap((u) =>
          u.rects.map((r, i) => (
            <div key={`h:${u.id}:${i}`} className="wm-highlight" style={{ left: r.left, top: r.top, width: r.width, height: r.height }} />
          )),
        )}
    </>
  );
}

function Badge({ view, actions }: { view: ViewState; actions: Actions }) {
  const b = view.badge!;
  const state = b.status === 'error' ? 'offline' : b.status === 'busy' ? 'busy' : b.count === 0 ? 'clean' : '';
  const label =
    b.status === 'error'
      ? `WriteMind couldn't check this text${b.error ? `: ${b.error}` : ''}`
      : b.status === 'busy' && b.count === 0
        ? 'Checking…'
        : b.count === 0
          ? 'No issues found'
          : `${b.count} suggestion${b.count === 1 ? '' : 's'} — open WriteMind`;
  return (
    <button
      className={`wm-badge ${state}`}
      style={{ left: b.left, top: b.top }}
      title={label}
      aria-label={label}
      data-testid="wm-badge"
      data-state={state || 'issues'}
      onClick={() => (view.panel.open ? actions.closePanel() : actions.openPanel('issues'))}
    >
      <span className="dot">{b.status === 'error' ? '!' : b.count > 0 ? 'W' : b.status === 'busy' ? '…' : '✓'}</span>
      {b.count > 0 && <span data-testid="wm-count">{b.count}</span>}
    </button>
  );
}

function SeverityChip({ s }: { s: Suggestion }) {
  return (
    <span className="wm-chip">
      <i className={s.severity} />
      {CATEGORY_LABEL[s.category]}
    </span>
  );
}

function Diff({ s, replacement }: { s: Suggestion; replacement?: string }) {
  if (replacement === undefined) return null;
  return (
    <p className="wm-diff">
      <del>{s.original || '∅'}</del> → <b>{replacement || '(remove)'}</b>
    </p>
  );
}

function Card({ view, actions }: { view: ViewState; actions: Actions }) {
  const { suggestion: s, left, top, canEdit } = view.card!;
  return (
    <div className={`wm-card ${s.source === 'ai' ? 'ai' : s.severity}`} style={{ left, top }} role="dialog" aria-label={s.title} data-testid="wm-card">
      <header>
        <SeverityChip s={s} />
        {s.source === 'ai' && <span className="wm-ai-tag">AI</span>}
        <button className="wm-close" aria-label="Close" onClick={actions.closeCard}>
          ×
        </button>
      </header>
      <div className="wm-title">{s.title}</div>
      {s.replacements[0] !== undefined && <Diff s={s} replacement={s.replacements[0]} />}
      <p className="wm-message">{s.message}</p>
      {s.replacements.length > 0 && canEdit && (
        <div className="wm-replacements">
          {s.replacements.slice(0, 4).map((r, i) => (
            <button
              key={r + i}
              className={`wm-btn${i === 0 ? ' primary' : ''}`}
              data-testid="wm-accept"
              onClick={() => actions.accept(s, r)}
              title={`Replace “${s.original}” with “${r}”`}
            >
              {r === '' ? 'Remove' : r}
            </button>
          ))}
        </div>
      )}
      {!canEdit && <p className="wm-message">This part of the text can’t be edited automatically.</p>}
      <div className="wm-actions">
        <button className="wm-btn ghost" data-testid="wm-ignore" onClick={() => actions.ignore(s)}>
          Ignore
        </button>
        {s.category === 'spelling' && (
          <button className="wm-btn ghost" onClick={() => actions.addToDictionary(s)}>
            Add to dictionary
          </button>
        )}
        <button className="wm-btn ghost" onClick={() => actions.disableRule(s)} title={s.rule_id}>
          Turn off this rule
        </button>
      </div>
    </div>
  );
}

function Panel({ view, actions }: { view: ViewState; actions: Actions }) {
  const counts = view.suggestions.reduce<Record<string, number>>((acc, s) => {
    acc[s.category] = (acc[s.category] ?? 0) + 1;
    return acc;
  }, {});
  const score = view.badge?.score;
  return (
    <aside className="wm-panel" aria-label="WriteMind assistant" data-testid="wm-panel">
      <header>
        <div className="wm-brand">
          WriteMind AI<small>Detect Instantly. Suggest Intelligently. Let Users Decide.</small>
        </div>
        {score !== null && score !== undefined && (
          <div className="wm-score" title="Writing score">
            <b>{score}</b>
            <span>score</span>
          </div>
        )}
        <button className="wm-close" aria-label="Close assistant" onClick={actions.closePanel}>
          ×
        </button>
      </header>
      <div className="wm-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={view.panel.tab === 'issues'}
          className={`wm-tab${view.panel.tab === 'issues' ? ' active' : ''}`}
          onClick={() => actions.openPanel('issues')}
        >
          Suggestions ({view.suggestions.length})
        </button>
        <button
          role="tab"
          aria-selected={view.panel.tab === 'rewrite'}
          data-testid="wm-tab-rewrite"
          className={`wm-tab${view.panel.tab === 'rewrite' ? ' active' : ''}`}
          onClick={() => actions.openPanel('rewrite')}
        >
          Rewrite
        </button>
      </div>
      <div className="wm-body">{view.panel.tab === 'issues' ? <Issues view={view} actions={actions} counts={counts} /> : <Rewrite view={view} actions={actions} />}</div>
      <div className="wm-footer">
        <span>Writing style:</span>
        {STYLES.map((st) => (
          <button key={st} className={`wm-style${view.style === st ? ' active' : ''}`} onClick={() => actions.setStyle(st)}>
            {STYLE_LABEL[st]}
          </button>
        ))}
      </div>
    </aside>
  );
}

function Issues({ view, actions, counts }: { view: ViewState; actions: Actions; counts: Record<string, number> }) {
  if (!view.suggestions.length) {
    return (
      <div className="wm-empty">
        <b>Looking good ✨</b>
        No suggestions right now. Keep writing — WriteMind checks as you type.
      </div>
    );
  }
  return (
    <>
      <div className="wm-counts">
        {Object.entries(counts).map(([cat, n]) => (
          <span key={cat} className="wm-count">
            {CATEGORY_LABEL[cat as Category]} · {n}
          </span>
        ))}
        <span className="wm-count">{view.words} words</span>
      </div>
      {view.suggestions.map((s) => (
        <div key={s.id} className="wm-item" data-testid="wm-item">
          <header>
            <SeverityChip s={s} />
            {s.source === 'ai' && <span className="wm-ai-tag">AI</span>}
          </header>
          <div className="wm-title">{s.title}</div>
          <Diff s={s} replacement={s.replacements[0]} />
          <div className="row">
            {s.replacements.length > 0 && (
              <button className="wm-btn primary" onClick={() => actions.accept(s, s.replacements[0]!)}>
                Accept
              </button>
            )}
            <button className="wm-btn" onClick={() => actions.ignore(s)}>
              Ignore
            </button>
            <button className="wm-btn ghost" onClick={() => actions.openCard(s)}>
              Details
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

function Rewrite({ view, actions }: { view: ViewState; actions: Actions }) {
  const r = view.rewrite;
  if (!r) {
    return (
      <div className="wm-empty">
        <b>Rewrite a sentence</b>
        Select text in the field, then choose a style.
        <div style={{ marginTop: 12 }}>
          <button className="wm-btn primary" onClick={actions.prepareRewrite}>
            Use my selection
          </button>
        </div>
      </div>
    );
  }
  return (
    <>
      <div className="wm-quote" data-testid="wm-rewrite-source">
        {r.source || 'Nothing selected.'}
      </div>
      <div className="wm-styles" role="radiogroup" aria-label="Rewrite style">
        {REWRITE_STYLES.map((st) => (
          <button
            key={st}
            role="radio"
            aria-checked={r.style === st}
            className={`wm-style${r.style === st ? ' active' : ''}`}
            onClick={() => actions.setRewriteStyle(st)}
          >
            {STYLE_LABEL[st]}
          </button>
        ))}
      </div>
      <div className="row" style={{ display: 'flex', gap: 6 }}>
        <button className="wm-btn primary" disabled={r.loading || !r.source.trim()} onClick={actions.generateRewrite} data-testid="wm-generate">
          {r.loading ? <span className="wm-spinner" /> : 'Suggest alternatives'}
        </button>
        <button className="wm-btn ghost" onClick={actions.prepareRewrite}>
          Use new selection
        </button>
      </div>
      {r.error && <p className="wm-message" style={{ marginTop: 10 }}>{r.error}</p>}
      {r.alternatives.map((alt, i) => (
        <div key={i} className="wm-item" data-testid="wm-alternative">
          <div className="wm-alt">{alt.text}</div>
          <div className="wm-note">
            {alt.source === 'ai' ? 'AI suggestion' : 'WriteMind rules'} · meaning preserved
            {alt.notes.length ? ` · ${alt.notes.join(' · ')}` : ''}
          </div>
          <div className="row">
            <button className="wm-btn primary" data-testid="wm-replace" onClick={() => actions.applyRewrite(alt)}>
              Replace
            </button>
            <button className="wm-btn" onClick={() => actions.copy(alt.text)}>
              Copy
            </button>
          </div>
        </div>
      ))}
    </>
  );
}
