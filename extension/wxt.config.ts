import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'WriteMind AI',
    short_name: 'WriteMind',
    description:
      'Detect Instantly. Suggest Intelligently. Let Users Decide. Grammar, spelling and style suggestions you approve one by one.',
    permissions: ['storage'],
    // Editors can live on any site; the backend URL is user-configurable.
    host_permissions: ['<all_urls>'],
    action: { default_title: 'WriteMind AI' },
    commands: {
      'open-assistant': {
        suggested_key: { default: 'Alt+Shift+W' },
        description: 'Open the WriteMind assistant for the focused field',
      },
    },
  },
});
