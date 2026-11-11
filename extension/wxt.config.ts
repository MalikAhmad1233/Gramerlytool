import { resolve } from 'node:path';
import { defineConfig } from 'wxt';

const SHARED = resolve(__dirname, '..', 'shared');

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'WriteMind AI',
    short_name: 'WriteMind',
    description:
      'Detect Instantly. Suggest Intelligently. Let Users Decide. Grammar, spelling and style suggestions you approve one by one.',
    // scripting: load WriteMind into tabs that were already open when it was installed or updated.
    permissions: ['storage', 'scripting'],
    // Editors can live on any site; an optional WriteMind server URL is user-configurable.
    host_permissions: ['<all_urls>'],
    action: { default_title: 'WriteMind AI' },
    commands: {
      'open-assistant': {
        suggested_key: { default: 'Alt+Shift+W' },
        description: 'Open the WriteMind assistant for the focused field',
      },
    },
  },
  // The grammar rules and Hunspell dictionaries live in /shared so the Windows app uses the same data.
  vite: () => ({ server: { fs: { allow: [resolve(__dirname), SHARED] } } }),
  hooks: {
    'build:publicAssets': (_wxt, files) => {
      for (const lang of ['en-US', 'en-GB']) {
        for (const ext of ['aff', 'dic']) {
          files.push({ absoluteSrc: resolve(SHARED, 'dictionaries', `${lang}.${ext}`), relativeDest: `dict/${lang}.${ext}` });
        }
      }
      files.push({ absoluteSrc: resolve(SHARED, 'model', 'en.model.txt'), relativeDest: 'model/en.model.txt' });
    },
  },
});
