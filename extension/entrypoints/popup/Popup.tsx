import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { send } from '../../src/shared/client';
import type { StatusResponse } from '../../src/shared/messages';
import { isSiteDisabled, statsItem, today, type LocalStats } from '../../src/shared/settings';
import type { Style } from '../../src/shared/types';
import { STYLES } from '../../src/shared/types';
import { useSettings } from '../../src/ui/useSettings';

const STYLE_LABEL: Record<Style, string> = {
  neutral: 'Neutral',
  professional: 'Professional',
  casual: 'Casual',
  formal: 'Formal',
};

export function Popup() {
  const [settings, update] = useSettings();
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [host, setHost] = useState<string | null>(null);
  const [stats, setStats] = useState<LocalStats | null>(null);

  useEffect(() => {
    void send({ type: 'status' }).then(setStatus).catch(() => setStatus({ engine: 'builtin', aiAvailable: false }));
    void statsItem.getValue().then((s) => setStats(s && s.day === today() ? s : null));
    void browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      try {
        const url = tab?.url ? new URL(tab.url) : null;
        setHost(url && /^https?:$/.test(url.protocol) ? url.hostname : null);
      } catch {
        setHost(null);
      }
    });
  }, []);

  const siteOn = host ? !isSiteDisabled(host, settings.disabledSites) : false;
  const toggleSite = () => {
    if (!host) return;
    const next = siteOn ? [...settings.disabledSites, host] : settings.disabledSites.filter((h) => h !== host);
    void update({ disabledSites: next });
  };

  return (
    <div className="stack" style={{ width: 340, padding: 16 }}>
      <div className="brand">
        <img src="/icon/48.png" alt="" />
        <div>
          <h1>WriteMind AI</h1>
          <p>Detect Instantly. Suggest Intelligently. Let Users Decide.</p>
        </div>
      </div>

      <div className="card stack">
        <div className="row spread">
          <span>WriteMind enabled</span>
          <label className="switch">
            <input type="checkbox" checked={settings.enabled} onChange={(e) => void update({ enabled: e.target.checked })} />
            <span />
          </label>
        </div>
        {host && (
          <div className="row spread">
            <span>
              Check on <b>{host}</b>
            </span>
            <label className="switch">
              <input type="checkbox" checked={siteOn} disabled={!settings.enabled} onChange={toggleSite} />
              <span />
            </label>
          </div>
        )}
        <div className="row" style={{ fontSize: 12 }} data-testid="engine-status">
          <span className={`dot ${status ? 'ok' : 'wait'}`} />
          <span className="muted">
            {status === null
              ? 'Starting…'
              : status.engine === 'server'
                ? `Ready · WriteMind server${status.aiAvailable ? ' with AI suggestions' : ''}`
                : 'Ready · built-in checker (works offline)'}
          </span>
        </div>
      </div>

      <div className="card stack">
        <b>Writing style</b>
        <div className="chips">
          {STYLES.map((s) => (
            <button key={s} className={`chip${settings.style === s ? ' active' : ''}`} onClick={() => void update({ style: s })}>
              {STYLE_LABEL[s]}
            </button>
          ))}
        </div>
      </div>

      <div className="card stack">
        <b>Today</b>
        <div className="stats">
          <div className="stat">
            <b>{stats?.checks ?? 0}</b>
            <span>checks</span>
          </div>
          <div className="stat">
            <b>{stats?.accepted ?? 0}</b>
            <span>accepted</span>
          </div>
          <div className="stat">
            <b>{stats?.ignored ?? 0}</b>
            <span>ignored</span>
          </div>
        </div>
      </div>

      <div className="row spread">
        <span className="muted" style={{ fontSize: 12 }}>
          Your text stays private.
        </span>
        <button className="btn" onClick={() => void browser.runtime.openOptionsPage()}>
          Settings
        </button>
      </div>
    </div>
  );
}
