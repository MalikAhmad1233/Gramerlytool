import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { ApiClient, storeTokens } from '../src/shared/api';
import type { Envelope, Request, StatusResponse } from '../src/shared/messages';
import { WriteMindError } from '../src/shared/messages';
import { authItem, bumpStats, getSettings, updateSettings } from '../src/shared/settings';
import type {
  CheckResponse,
  FeedbackEvent,
  RemoteSettings,
  RewriteResponse,
  TokenPair,
  UsageSummary,
} from '../src/shared/types';

export default defineBackground(() => {
  const api = new ApiClient();
  const inflight = new Map<string, AbortController>();
  let feedbackQueue: FeedbackEvent[] = [];
  let feedbackTimer: ReturnType<typeof setTimeout> | null = null;

  async function flushFeedback(): Promise<void> {
    feedbackTimer = null;
    const events = feedbackQueue.splice(0, 50);
    if (!events.length) return;
    try {
      await api.request('/v1/feedback', { body: { client: 'chrome-extension', events } });
    } catch {
      /* feedback is best-effort and contains no text */
    }
    if (feedbackQueue.length) feedbackTimer = setTimeout(flushFeedback, 1000);
  }

  async function syncFromServer(): Promise<void> {
    const auth = await authItem.getValue();
    if (!auth) return;
    const [remote, dict] = await Promise.all([
      api.request<RemoteSettings>('/v1/settings', { auth: 'required' }),
      api.request<{ words: string[] }>('/v1/dictionary', { auth: 'required' }),
    ]);
    const local = await getSettings();
    const words = new Map<string, string>();
    for (const w of [...local.dictionary, ...dict.words]) words.set(w.toLowerCase(), w);
    // Push words added while signed out.
    for (const w of local.dictionary) {
      if (!dict.words.some((d) => d.toLowerCase() === w.toLowerCase())) {
        await api.request('/v1/dictionary', { body: { word: w }, auth: 'required' }).catch(() => undefined);
      }
    }
    await updateSettings({
      language: remote.language,
      style: remote.default_style,
      aiEnabled: remote.ai_enabled,
      categories: remote.enabled_categories,
      ignoredRules: Array.from(new Set([...local.ignoredRules, ...remote.disabled_rules])),
      disabledSites: Array.from(new Set([...local.disabledSites, ...remote.disabled_sites])),
      dictionary: Array.from(words.values()).sort((a, b) => a.localeCompare(b)),
    });
  }

  async function pushSettings(): Promise<void> {
    if (!(await authItem.getValue())) return;
    const s = await getSettings();
    await api
      .request('/v1/settings', {
        method: 'PUT',
        auth: 'required',
        body: {
          language: s.language,
          default_style: s.style,
          ai_enabled: s.aiEnabled,
          enabled_categories: s.categories,
          disabled_rules: s.ignoredRules,
          disabled_sites: s.disabledSites,
        },
      })
      .catch(() => undefined);
  }

  async function handle(msg: Request, sender: { tab?: { id?: number } }): Promise<unknown> {
    switch (msg.type) {
      case 'check': {
        const key = `${sender.tab?.id ?? 'x'}:${msg.fieldKey}:${msg.payload.mode}`;
        inflight.get(key)?.abort();
        const controller = new AbortController();
        inflight.set(key, controller);
        try {
          const result = await api.request<CheckResponse>('/v1/check', { body: msg.payload, signal: controller.signal });
          if (msg.payload.mode === 'fast') await bumpStats({ checks: 1 });
          return result;
        } finally {
          if (inflight.get(key) === controller) inflight.delete(key);
        }
      }
      case 'rewrite':
        return api.request<RewriteResponse>('/v1/rewrite', { body: msg.payload });
      case 'feedback': {
        feedbackQueue.push(...msg.events);
        await bumpStats({
          accepted: msg.events.filter((e) => e.action === 'accepted').length,
          ignored: msg.events.filter((e) => e.action !== 'accepted').length,
        });
        if (feedbackQueue.length >= 20) await flushFeedback();
        else feedbackTimer ??= setTimeout(flushFeedback, 5000);
        return null;
      }
      case 'dictionary.add': {
        const s = await getSettings();
        if (!s.dictionary.some((w) => w.toLowerCase() === msg.word.toLowerCase())) {
          await updateSettings({ dictionary: [...s.dictionary, msg.word].sort((a, b) => a.localeCompare(b)) });
        }
        if (await authItem.getValue()) {
          await api.request('/v1/dictionary', { body: { word: msg.word }, auth: 'required' }).catch(() => undefined);
        }
        return null;
      }
      case 'dictionary.remove': {
        const s = await getSettings();
        await updateSettings({ dictionary: s.dictionary.filter((w) => w.toLowerCase() !== msg.word.toLowerCase()) });
        if (await authItem.getValue()) {
          await api
            .request(`/v1/dictionary/${encodeURIComponent(msg.word)}`, { method: 'DELETE', auth: 'required' })
            .catch(() => undefined);
        }
        return null;
      }
      case 'rule.disable':
      case 'rule.enable': {
        const s = await getSettings();
        const rules = new Set(s.ignoredRules);
        if (msg.type === 'rule.disable') rules.add(msg.ruleId);
        else rules.delete(msg.ruleId);
        await updateSettings({ ignoredRules: Array.from(rules) });
        await pushSettings();
        return null;
      }
      case 'auth.login':
      case 'auth.register': {
        const pair = await api.request<TokenPair>(msg.type === 'auth.login' ? '/v1/auth/login' : '/v1/auth/register', {
          auth: 'none',
          body:
            msg.type === 'auth.login'
              ? { email: msg.email, password: msg.password, client: 'chrome-extension' }
              : { email: msg.email, password: msg.password, display_name: msg.displayName, client: 'chrome-extension' },
        });
        await storeTokens(pair);
        if (msg.type === 'auth.register') await pushSettings();
        await syncFromServer().catch(() => undefined);
        return pair.user;
      }
      case 'auth.logout': {
        const auth = await authItem.getValue();
        if (auth) {
          await api
            .request('/v1/auth/logout', { body: { refresh_token: auth.refreshToken }, auth: 'none' })
            .catch(() => undefined);
        }
        await authItem.setValue(null);
        return null;
      }
      case 'account.export':
        return api.request('/v1/me/export', { auth: 'required' });
      case 'account.delete':
        await api.request('/v1/me', { method: 'DELETE', body: { password: msg.password }, auth: 'required' });
        await authItem.setValue(null);
        return null;
      case 'sync':
        await syncFromServer();
        await pushSettings();
        return null;
      case 'usage':
        if (!(await authItem.getValue())) return null;
        return api.request<UsageSummary>('/v1/usage/summary?days=7', { auth: 'required' }).catch(() => null);
      case 'status': {
        const auth = await authItem.getValue();
        try {
          const meta = await api.request<{ ai_available: boolean }>('/v1/meta', { auth: 'none' });
          return { backend: 'ok', aiAvailable: meta.ai_available, user: auth?.user ?? null } satisfies StatusResponse;
        } catch {
          return { backend: 'offline', aiAvailable: false, user: auth?.user ?? null } satisfies StatusResponse;
        }
      }
      case 'badge': {
        const tabId = sender.tab?.id;
        if (tabId !== undefined) {
          await browser.action.setBadgeBackgroundColor({ tabId, color: '#4f46e5' });
          await browser.action.setBadgeText({ tabId, text: msg.count > 0 ? String(Math.min(msg.count, 99)) : '' });
        }
        return null;
      }
    }
  }

  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    handle(message as Request, sender)
      .then((data) => sendResponse({ ok: true, data } satisfies Envelope<unknown>))
      .catch((err: unknown) => {
        const error =
          err instanceof WriteMindError
            ? { code: err.code, message: err.message }
            : { code: 'internal', message: err instanceof Error ? err.message : 'Unexpected error' };
        sendResponse({ ok: false, error } satisfies Envelope<unknown>);
      });
    return true; // async response
  });

  browser.commands.onCommand.addListener(async (command) => {
    if (command !== 'open-assistant') return;
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== undefined) await browser.tabs.sendMessage(tab.id, { type: 'open-assistant' }).catch(() => undefined);
  });

  browser.runtime.onInstalled.addListener(({ reason }) => {
    if (reason === 'install') void browser.runtime.openOptionsPage();
  });
  browser.runtime.onStartup.addListener(() => void syncFromServer().catch(() => undefined));
});
