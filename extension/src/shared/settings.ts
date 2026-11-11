import { storage } from 'wxt/utils/storage';
import type { Category, Style } from './types';
import { CATEGORIES } from './types';

export interface LocalSettings {
  apiBaseUrl: string;
  enabled: boolean;
  language: string;
  style: Style;
  aiEnabled: boolean;
  categories: Category[];
  disabledSites: string[];
  ignoredRules: string[];
  dictionary: string[];
}

export const DEFAULT_SETTINGS: LocalSettings = {
  apiBaseUrl: 'http://localhost:8000',
  enabled: true,
  language: 'en-US',
  style: 'neutral',
  aiEnabled: true,
  categories: [...CATEGORIES],
  disabledSites: [],
  ignoredRules: [],
  dictionary: [],
};

export interface LocalStats {
  day: string; // YYYY-MM-DD
  checks: number;
  accepted: number;
  ignored: number;
}

export const settingsItem = storage.defineItem<LocalSettings>('local:settings', {
  fallback: DEFAULT_SETTINGS,
});
export const statsItem = storage.defineItem<LocalStats | null>('local:stats', { fallback: null });

export async function getSettings(): Promise<LocalSettings> {
  return { ...DEFAULT_SETTINGS, ...(await settingsItem.getValue()) };
}

export async function updateSettings(patch: Partial<LocalSettings>): Promise<LocalSettings> {
  const next = { ...(await getSettings()), ...patch };
  await settingsItem.setValue(next);
  return next;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function bumpStats(patch: Partial<Omit<LocalStats, 'day'>>): Promise<void> {
  const current = await statsItem.getValue();
  const base: LocalStats =
    current && current.day === today() ? current : { day: today(), checks: 0, accepted: 0, ignored: 0 };
  await statsItem.setValue({
    day: base.day,
    checks: base.checks + (patch.checks ?? 0),
    accepted: base.accepted + (patch.accepted ?? 0),
    ignored: base.ignored + (patch.ignored ?? 0),
  });
}

/** Host matching for the per-site toggle. Supports exact hosts and "*.example.com". */
export function isSiteDisabled(hostname: string, disabledSites: string[]): boolean {
  const host = hostname.toLowerCase();
  return disabledSites.some((entry) => {
    const rule = entry.toLowerCase();
    if (rule.startsWith('*.')) {
      const suffix = rule.slice(1);
      return host.endsWith(suffix) || host === rule.slice(2);
    }
    return host === rule;
  });
}
