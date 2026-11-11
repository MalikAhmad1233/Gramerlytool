import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { send } from '../../src/shared/client';
import type { Category, Suggestion } from '../../src/shared/types';
import { useSettings } from '../../src/ui/useSettings';

const SAMPLE = 'Myself Ahmed form Lahore. I recieved the informations yesterday and we will discuss about it today morning.';

const CATEGORY_LABEL: Record<Category, string> = {
  grammar: 'Grammar',
  spelling: 'Spelling',
  punctuation: 'Punctuation',
  style: 'Style',
  clarity: 'Clarity',
};

/** First-run page: choose American or British English and try WriteMind on a sample — nothing to sign up for. */
export function Welcome() {
  const [settings, update] = useSettings();
  const [text, setText] = useState(SAMPLE);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [ignored, setIgnored] = useState<Set<string>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const british = /^en-(GB|AU|NZ|ZA)$/i.test(settings.language);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void send({
        type: 'check',
        fieldKey: 'welcome-demo',
        payload: { text, language: settings.language, style: settings.style, mode: 'fast', client: { kind: 'chrome-extension', app: null }, dictionary: settings.dictionary },
      })
        .then((r) => setSuggestions(r.suggestions))
        .catch(() => setSuggestions(null));
    }, 250);
  }, [text, settings.language, settings.style, settings.dictionary]);

  // Applies one suggestion — only because the user clicked it, and only if that exact text is still there.
  const accept = (s: Suggestion, replacement: string) => {
    if (text.slice(s.offset, s.offset + s.length) !== s.original) return;
    setText(text.slice(0, s.offset) + replacement + text.slice(s.offset + s.length));
  };

  const visible = (suggestions ?? []).filter((s) => !ignored.has(s.id));

  return (
    <div className="welcome">
      <header className="hero">
        <img src="/icon/128.png" alt="" width={72} height={72} />
        <h1>Welcome to WriteMind AI</h1>
        <p>Detect Instantly. Suggest Intelligently. Let Users Decide.</p>
        <span className="pill">Ready to use · no account needed · works offline</span>
      </header>

      <main>
        <section className="step">
          <div className="num">1</div>
          <div className="grow">
            <h2>Which English do you write?</h2>
            <p className="muted">WriteMind will follow the spelling you choose. You can change it any time in Settings.</p>
            <div className="choices">
              <button className={`choice${!british ? ' active' : ''}`} onClick={() => void update({ language: 'en-US' })} data-testid="choose-us">
                <b>American English</b>
                <span>color · organize · center</span>
              </button>
              <button className={`choice${british ? ' active' : ''}`} onClick={() => void update({ language: 'en-GB' })} data-testid="choose-gb">
                <b>British English</b>
                <span>colour · organise · centre</span>
              </button>
            </div>
          </div>
        </section>

        <section className="step">
          <div className="num">2</div>
          <div className="grow">
            <h2>Try it</h2>
            <p className="muted">Edit the text below. Click a suggestion to apply it — nothing changes until you do.</p>
            <textarea className="input demo" rows={4} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} data-testid="demo-text" />
            <div className="results" data-testid="demo-results">
              {suggestions === null ? (
                <p className="muted">Checking…</p>
              ) : visible.length === 0 ? (
                <p className="success">✓ Looks great — no issues found.</p>
              ) : (
                visible.map((s) => (
                  <div key={s.id} className="result">
                    <span className={`sev ${s.severity}`} />
                    <div className="grow">
                      <div className="kind">
                        {CATEGORY_LABEL[s.category]} · {s.title}
                      </div>
                      <div className="msg">{s.message}</div>
                    </div>
                    <div className="fixes">
                      {s.replacements.slice(0, 2).map((r) => (
                        <button key={r} className="fix" onClick={() => accept(s, r)} title={`Replace “${s.original}” with “${r}”`}>
                          <del>{s.original}</del> <b>{r || '(remove)'}</b>
                        </button>
                      ))}
                      <button className="btn ghost" onClick={() => setIgnored(new Set([...ignored, s.id]))}>
                        Ignore
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>

        <section className="step">
          <div className="num">3</div>
          <div className="grow">
            <h2>Write anywhere</h2>
            <div className="tiles">
              <div className="tile">
                <b>Underlines as you type</b>
                <span>In Gmail, WhatsApp Web, LinkedIn, Outlook and any text box.</span>
              </div>
              <div className="tile">
                <b>Click to see the fix</b>
                <span>Each suggestion explains why, with one-click Accept.</span>
              </div>
              <div className="tile">
                <b>You stay in control</b>
                <span>WriteMind never changes your text unless you click.</span>
              </div>
            </div>
            <p className="muted tip">
              Tip: click the puzzle-piece icon in Chrome’s toolbar and <b>pin WriteMind</b> to reach its switch and writing style quickly.
            </p>
          </div>
        </section>

        <footer className="row spread">
          <span className="muted">🔒 Your text is checked on your computer. Passwords and payment fields are never read.</span>
          <span className="row">
            <button className="btn" onClick={() => void browser.runtime.openOptionsPage()}>
              Settings
            </button>
            <button className="btn primary" onClick={() => window.close()} data-testid="start-writing">
              Start writing
            </button>
          </span>
        </footer>
      </main>
    </div>
  );
}
