import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { checkOffline, rewriteOffline } from '../src/offline/engine';
import { Speller } from '../src/offline/speller';
import { apiRequest } from '../src/shared/api';
import type { Envelope, Request, StatusResponse } from '../src/shared/messages';
import { WriteMindError } from '../src/shared/messages';
import { bumpStats, getSettings, updateSettings } from '../src/shared/settings';
import type { CheckRequest, CheckResponse, FeedbackEvent, RewriteRequest, RewriteResponse } from '../src/shared/types';

/** Dictionaries are added to the package by a build hook, so they are not in WXT's generated path type. */
const assetUrl = (path: string): string => (browser.runtime.getURL as (p: string) => string)(path);

/** After a failed attempt, use the built-in checker for this long before trying the server again. */
const SERVER_RETRY_MS = 30_000;

export default defineBackground(() => {
  const inflight = new Map<string, AbortController>();
  const spellers = new Map<string, Promise<Speller | null>>();
  let serverDownUntil = 0;
  let lastStatus: StatusResponse = { engine: 'builtin', aiAvailable: false };
  let feedbackQueue: FeedbackEvent[] = [];
  let feedbackTimer: ReturnType<typeof setTimeout> | null = null;

  /** British-style spelling for en-GB/AU/NZ/ZA, American for the rest. */
  function dictionaryFor(language: string): string {
    return /^en-(GB|AU|NZ|ZA)$/i.test(language) ? 'en-GB' : 'en-US';
  }

  function speller(language: string): Promise<Speller | null> {
    if (!language.toLowerCase().startsWith('en')) return Promise.resolve(null);
    const name = dictionaryFor(language);
    let loading = spellers.get(name);
    if (!loading) {
      loading = (async () => {
        try {
          const [aff, dic] = await Promise.all(
            ['aff', 'dic'].map((ext) => fetch(assetUrl(`/dict/${name}.${ext}`)).then((r) => r.text())),
          );
          return new Speller(aff!, dic!);
        } catch {
          spellers.delete(name);
          return null;
        }
      })();
      spellers.set(name, loading);
    }
    return loading;
  }

  function serverAvailable(): boolean {
    return Date.now() >= serverDownUntil;
  }

  function markServer(up: boolean, aiAvailable = lastStatus.aiAvailable): void {
    if (!up) serverDownUntil = Date.now() + SERVER_RETRY_MS;
    lastStatus = { engine: up ? 'server' : 'builtin', aiAvailable: up && aiAvailable };
  }

  async function check(payload: CheckRequest, signal: AbortSignal): Promise<CheckResponse> {
    if (serverAvailable()) {
      try {
        const result = await apiRequest<CheckResponse>('/v1/check', {
          body: payload,
          signal,
          timeoutMs: payload.mode === 'fast' ? 4_000 : 10_000,
        });
        markServer(true, result.engine.ai !== 'unavailable');
        return result;
      } catch (err) {
        if (!(err instanceof WriteMindError) || !['offline', 'timeout'].includes(err.code)) throw err;
        markServer(false);
      }
    }
    // Built-in checker: no server, no account, nothing leaves the browser.
    return checkOffline(
      payload.text,
      { language: payload.language, style: payload.style, app: payload.client.app, mode: payload.mode, dictionary: payload.dictionary },
      await speller(payload.language),
    );
  }

  async function rewrite(payload: RewriteRequest): Promise<RewriteResponse> {
    if (serverAvailable()) {
      try {
        const result = await apiRequest<RewriteResponse>('/v1/rewrite', { body: payload });
        markServer(true);
        return result;
      } catch (err) {
        if (!(err instanceof WriteMindError) || !['offline', 'timeout'].includes(err.code)) throw err;
        markServer(false);
      }
    }
    return rewriteOffline(payload.text, payload.style, payload.count, payload.language, await speller(payload.language));
  }

  async function flushFeedback(): Promise<void> {
    feedbackTimer = null;
    const events = feedbackQueue.splice(0, 50);
    if (!events.length || !serverAvailable()) return;
    try {
      await apiRequest('/v1/feedback', { body: { client: 'chrome-extension', events } });
    } catch {
      /* anonymous quality signal only; never essential */
    }
  }

  async function handle(msg: Request, sender: { tab?: { id?: number } }): Promise<unknown> {
    switch (msg.type) {
      case 'check': {
        const key = `${sender.tab?.id ?? 'x'}:${msg.fieldKey}:${msg.payload.mode}`;
        inflight.get(key)?.abort();
        const controller = new AbortController();
        inflight.set(key, controller);
        try {
          const result = await check(msg.payload, controller.signal);
          if (msg.payload.mode === 'fast') await bumpStats({ checks: 1 });
          return result;
        } finally {
          if (inflight.get(key) === controller) inflight.delete(key);
        }
      }
      case 'rewrite':
        return rewrite(msg.payload);
      case 'feedback': {
        await bumpStats({
          accepted: msg.events.filter((e) => e.action === 'accepted').length,
          ignored: msg.events.filter((e) => e.action !== 'accepted').length,
        });
        feedbackQueue.push(...msg.events);
        feedbackQueue = feedbackQueue.slice(-200);
        feedbackTimer ??= setTimeout(flushFeedback, 5000);
        return null;
      }
      case 'dictionary.add': {
        const s = await getSettings();
        if (!s.dictionary.some((w) => w.toLowerCase() === msg.word.toLowerCase())) {
          await updateSettings({ dictionary: [...s.dictionary, msg.word].sort((a, b) => a.localeCompare(b)) });
        }
        return null;
      }
      case 'dictionary.remove': {
        const s = await getSettings();
        await updateSettings({ dictionary: s.dictionary.filter((w) => w.toLowerCase() !== msg.word.toLowerCase()) });
        return null;
      }
      case 'rule.disable':
      case 'rule.enable': {
        const s = await getSettings();
        const rules = new Set(s.ignoredRules);
        if (msg.type === 'rule.disable') rules.add(msg.ruleId);
        else rules.delete(msg.ruleId);
        await updateSettings({ ignoredRules: Array.from(rules) });
        return null;
      }
      case 'status': {
        try {
          const meta = await apiRequest<{ ai_available: boolean }>('/v1/meta', { timeoutMs: 3_000 });
          serverDownUntil = 0;
          markServer(true, meta.ai_available);
        } catch {
          markServer(false);
        }
        return lastStatus satisfies StatusResponse;
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
});
