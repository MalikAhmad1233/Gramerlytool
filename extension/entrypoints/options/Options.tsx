import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { send } from '../../src/shared/client';
import type { StatusResponse } from '../../src/shared/messages';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import type { Category, Style } from '../../src/shared/types';
import { CATEGORIES, STYLES } from '../../src/shared/types';
import { useSettings } from '../../src/ui/useSettings';

const LANGUAGES: Array<[string, string]> = [
  ['en-US', 'English (US)'],
  ['en-GB', 'English (UK)'],
  ['en-CA', 'English (Canada)'],
  ['en-AU', 'English (Australia)'],
  ['en-NZ', 'English (New Zealand)'],
  ['en-ZA', 'English (South Africa)'],
  ['de-DE', 'German (beta)'],
  ['fr', 'French (beta)'],
  ['es', 'Spanish (beta)'],
  ['it', 'Italian (beta)'],
  ['nl', 'Dutch (beta)'],
  ['pt-PT', 'Portuguese (beta)'],
  ['pt-BR', 'Portuguese, Brazil (beta)'],
];
const CATEGORY_LABEL: Record<Category, string> = {
  grammar: 'Grammar',
  spelling: 'Spelling',
  punctuation: 'Punctuation',
  style: 'Style',
  clarity: 'Clarity',
};
const STYLE_LABEL: Record<Style, string> = { neutral: 'Neutral', professional: 'Professional', casual: 'Casual', formal: 'Formal' };

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="card stack">
      <div>
        <h2 style={{ fontSize: 16 }}>{title}</h2>
        {description && <p className="muted" style={{ margin: '4px 0 0' }}>{description}</p>}
      </div>
      {children}
    </section>
  );
}

export function Options() {
  const [settings, update] = useSettings();
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const refreshStatus = () =>
    send({ type: 'status' }).then(setStatus).catch(() => setStatus({ backend: 'offline', aiAvailable: false, user: null }));
  useEffect(() => void refreshStatus(), []);

  const sync = () => void send({ type: 'sync' }).catch(() => undefined);
  const save = async (patch: Parameters<typeof update>[0]) => {
    await update(patch);
    sync();
  };

  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: '32px 20px 64px' }} className="stack">
      <div className="brand">
        <img src="/icon/128.png" alt="" style={{ width: 48, height: 48, borderRadius: 12 }} />
        <div>
          <h1 style={{ fontSize: 22 }}>WriteMind AI</h1>
          <p style={{ fontSize: 13 }}>Detect Instantly. Suggest Intelligently. Let Users Decide.</p>
        </div>
      </div>

      <Account status={status} onChange={refreshStatus} />

      <Section title="Writing" description="Applies everywhere WriteMind checks your text.">
        <label className="stack" style={{ gap: 4 }}>
          <span>Language</span>
          <select className="input" value={settings.language} onChange={(e) => void save({ language: e.target.value })}>
            {LANGUAGES.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <div className="stack" style={{ gap: 6 }}>
          <span>Default writing style</span>
          <div className="chips">
            {STYLES.map((s) => (
              <button key={s} className={`chip${settings.style === s ? ' active' : ''}`} onClick={() => void save({ style: s })}>
                {STYLE_LABEL[s]}
              </button>
            ))}
          </div>
          <span className="muted" style={{ fontSize: 12 }}>
            Formal flags contractions and informal words; Casual relaxes chat-style capitalisation. Messaging apps such as
            WhatsApp are always checked casually unless you pick Professional or Formal.
          </span>
        </div>
        <div className="stack" style={{ gap: 6 }}>
          <span>Check for</span>
          <div className="chips">
            {CATEGORIES.map((c) => {
              const on = settings.categories.includes(c);
              return (
                <button
                  key={c}
                  className={`chip${on ? ' active' : ''}`}
                  onClick={() =>
                    void save({ categories: on ? settings.categories.filter((x) => x !== c) : [...settings.categories, c] })
                  }
                >
                  {CATEGORY_LABEL[c]}
                </button>
              );
            })}
          </div>
        </div>
        <div className="row spread">
          <div>
            <div>AI contextual suggestions</div>
            <div className="muted" style={{ fontSize: 12 }}>
              Catches errors rule-based checking misses and powers rewrites. Personal data (e-mails, phone and card numbers,
              links) is masked before any text reaches the AI model.
            </div>
          </div>
          <label className="switch">
            <input type="checkbox" checked={settings.aiEnabled} onChange={(e) => void save({ aiEnabled: e.target.checked })} />
            <span />
          </label>
        </div>
      </Section>

      <WordList
        title="Personal dictionary"
        description="Words WriteMind should never flag as misspelled."
        items={settings.dictionary}
        placeholder="Add a word, e.g. Kubernetes"
        onAdd={(w) => void send({ type: 'dictionary.add', word: w })}
        onRemove={(w) => void send({ type: 'dictionary.remove', word: w })}
      />

      <WordList
        title="Turned-off rules"
        description="Rules you switched off from a suggestion card."
        items={settings.ignoredRules}
        onRemove={(r) => void send({ type: 'rule.enable', ruleId: r })}
      />

      <WordList
        title="Sites where WriteMind is off"
        description="Use a host name like mail.example.com, or *.example.com for all subdomains."
        items={settings.disabledSites}
        placeholder="example.com"
        onAdd={(h) => void save({ disabledSites: Array.from(new Set([...settings.disabledSites, h.toLowerCase()])) })}
        onRemove={(h) => void save({ disabledSites: settings.disabledSites.filter((x) => x !== h) })}
      />

      <Section title="Connection" description="Address of the WriteMind API used for checks.">
        <ApiUrl value={settings.apiBaseUrl} onSave={async (url) => { await update({ apiBaseUrl: url }); await refreshStatus(); }} />
        <div className="row" style={{ fontSize: 13 }}>
          <span className={`dot ${status ? (status.backend === 'ok' ? 'ok' : 'bad') : 'wait'}`} />
          <span className="muted">
            {status?.backend === 'ok' ? `Connected${status.aiAvailable ? ' · AI available' : ' · AI not configured on the server'}` : 'Not connected'}
          </span>
        </div>
      </Section>

      <Section title="Privacy">
        <ul style={{ margin: 0, paddingLeft: 18 }} className="muted">
          <li>WriteMind never changes your text unless you click Accept or Replace.</li>
          <li>Password, payment, one-time-code and similar sensitive fields are never read.</li>
          <li>No keystroke logging: WriteMind reads a field’s text only after you pause typing.</li>
          <li>The text you check is processed in memory and is not stored. Only anonymous counters are kept.</li>
          <li>
            Sites can opt out with <code>data-writemind="off"</code>; Grammarly’s <code>data-gramm="false"</code> is honoured too.
          </li>
        </ul>
        <div className="row">
          <button className="btn" onClick={() => void update({ ...DEFAULT_SETTINGS, apiBaseUrl: settings.apiBaseUrl })}>
            Reset settings
          </button>
        </div>
      </Section>
    </main>
  );
}

function ApiUrl({ value, onSave }: { value: string; onSave: (url: string) => Promise<void> }) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(value), [value]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    try {
      const url = new URL(draft.trim());
      if (!/^https?:$/.test(url.protocol)) throw new Error();
      if (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
        setError('Use https:// for remote servers so your text is encrypted in transit.');
        return;
      }
      setError(null);
      void onSave(url.origin);
    } catch {
      setError('Enter a valid URL, e.g. https://api.writemind.ai');
    }
  };
  return (
    <form className="row" onSubmit={submit}>
      <input className="input" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="API URL" />
      <button className="btn primary" type="submit">
        Save
      </button>
      {error && <span className="error">{error}</span>}
    </form>
  );
}

function WordList(props: {
  title: string;
  description: string;
  items: string[];
  placeholder?: string;
  onAdd?: (value: string) => void;
  onRemove: (value: string) => void;
}) {
  const [draft, setDraft] = useState('');
  return (
    <Section title={props.title} description={props.description}>
      {props.onAdd && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            const v = draft.trim();
            if (v && !/\s/.test(v)) {
              props.onAdd!(v);
              setDraft('');
            }
          }}
        >
          <input className="input" value={draft} placeholder={props.placeholder} onChange={(e) => setDraft(e.target.value)} />
          <button className="btn" type="submit">
            Add
          </button>
        </form>
      )}
      <div className="chips">
        {props.items.length === 0 && <span className="muted">Nothing here yet.</span>}
        {props.items.map((item) => (
          <span key={item} className="tag">
            {item}
            <button aria-label={`Remove ${item}`} onClick={() => props.onRemove(item)}>
              ×
            </button>
          </span>
        ))}
      </div>
    </Section>
  );
}

function Account({ status, onChange }: { status: StatusResponse | null; onChange: () => Promise<unknown> }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  const run = async (fn: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      if (success) setMessage({ kind: 'success', text: success });
      await onChange();
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Something went wrong.' });
    } finally {
      setBusy(false);
    }
  };

  if (status?.user) {
    const exportData = () =>
      run(async () => {
        const data = await send({ type: 'account.export' });
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'writemind-export.json';
        a.click();
      });
    const deleteAccount = () => {
      const pw = prompt('Delete your WriteMind account and all synced data? Enter your password to confirm.');
      if (pw) void run(() => send({ type: 'account.delete', password: pw }), 'Account deleted.');
    };
    return (
      <Section title="Account" description="Your settings and dictionary sync across Chrome and the Windows app.">
        <div className="row spread">
          <div>
            <b>{status.user.display_name ?? status.user.email}</b>
            <div className="muted" style={{ fontSize: 13 }}>
              {status.user.email} · {status.user.plan} plan
            </div>
          </div>
          <button className="btn" disabled={busy} onClick={() => void run(() => send({ type: 'auth.logout' }))}>
            Sign out
          </button>
        </div>
        <div className="row">
          <button className="btn" disabled={busy} onClick={() => void run(() => send({ type: 'sync' }), 'Synced.')}>
            Sync now
          </button>
          <button className="btn" disabled={busy} onClick={() => void exportData()}>
            Export my data
          </button>
          <button className="btn danger" disabled={busy} onClick={deleteAccount}>
            Delete account
          </button>
        </div>
        {message && <span className={message.kind}>{message.text}</span>}
      </Section>
    );
  }

  return (
    <Section
      title={mode === 'login' ? 'Sign in' : 'Create your account'}
      description="Optional. Sign in to sync your dictionary and preferences across devices. Checking works without an account."
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() =>
            mode === 'login'
              ? send({ type: 'auth.login', email, password })
              : send({ type: 'auth.register', email, password, displayName: name || undefined }),
          );
        }}
      >
        {mode === 'register' && <input className="input" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />}
        <input className="input" type="email" autoComplete="email" placeholder="you@example.com" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <input
          className="input"
          type="password"
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          placeholder={mode === 'login' ? 'Password' : 'Password (8+ characters, mix letters and numbers)'}
          required
          minLength={mode === 'register' ? 8 : 1}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="row">
          <button className="btn primary" type="submit" disabled={busy}>
            {mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
          <button type="button" className="btn" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
            {mode === 'login' ? 'Create an account' : 'I already have an account'}
          </button>
        </div>
        {message && <span className={message.kind}>{message.text}</span>}
      </form>
    </Section>
  );
}
