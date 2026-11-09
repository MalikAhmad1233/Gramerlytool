/**
 * Site profiles: per-site knowledge the generic adapters need.
 * `app` is sent to the backend, which relaxes chat-style rules for messaging apps.
 */
export interface SiteProfile {
  app: string;
  /** Subtrees inside an editor that are not the user's own writing (quotes, signatures). */
  excludeSelector: string | null;
}

const PROFILES: Array<{ test: (host: string) => boolean; profile: SiteProfile }> = [
  {
    test: (h) => h === 'mail.google.com',
    profile: {
      app: 'gmail',
      excludeSelector: '.gmail_quote, .gmail_signature, [data-smartmail="gmail_signature"], blockquote',
    },
  },
  {
    test: (h) => h === 'web.whatsapp.com',
    profile: { app: 'whatsapp', excludeSelector: null },
  },
  {
    test: (h) => h === 'www.linkedin.com' || h === 'linkedin.com',
    profile: { app: 'linkedin', excludeSelector: null },
  },
  {
    test: (h) => /(^|\.)outlook\.(live|office|office365)\.com$/.test(h),
    profile: { app: 'outlook', excludeSelector: '#divRplyFwdMsg, #divRplyFwdMsg ~ *, blockquote' },
  },
  { test: (h) => h === 'app.slack.com', profile: { app: 'slack', excludeSelector: null } },
  { test: (h) => h === 'teams.microsoft.com' || h === 'teams.live.com', profile: { app: 'teams', excludeSelector: 'blockquote' } },
  { test: (h) => h === 'discord.com', profile: { app: 'discord', excludeSelector: null } },
  { test: (h) => h === 'www.messenger.com', profile: { app: 'messenger', excludeSelector: null } },
  { test: (h) => h === 'web.telegram.org', profile: { app: 'telegram', excludeSelector: null } },
];

export function profileFor(hostname: string): SiteProfile {
  const host = hostname.toLowerCase();
  return PROFILES.find((p) => p.test(host))?.profile ?? { app: 'generic', excludeSelector: 'blockquote[type="cite"]' };
}

/** Code editors hold code, not prose. */
export const CODE_EDITOR_SELECTOR =
  '.cm-editor, .CodeMirror, .monaco-editor, .ace_editor, [data-language], .ql-code-block, pre[contenteditable]';
