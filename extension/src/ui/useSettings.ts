import { useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, getSettings, settingsItem, updateSettings, type LocalSettings } from '../shared/settings';

/** Live view of extension settings shared by popup and options pages. */
export function useSettings(): [LocalSettings, (patch: Partial<LocalSettings>) => Promise<void>] {
  const [settings, setSettings] = useState<LocalSettings>(DEFAULT_SETTINGS);
  useEffect(() => {
    void getSettings().then(setSettings);
    return settingsItem.watch((value) => setSettings({ ...DEFAULT_SETTINGS, ...(value ?? {}) }));
  }, []);
  const update = async (patch: Partial<LocalSettings>) => {
    setSettings(await updateSettings(patch));
  };
  return [settings, update];
}
