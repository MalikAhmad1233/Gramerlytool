import { createRoot } from 'react-dom/client';
import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { Assistant } from '../../src/content/assistant';
import { App } from '../../src/ui/App';
import { UI_CSS } from '../../src/ui/styles';

/** Fixed (not per-extension-ID) so a re-installed or updated WriteMind can replace any older copy in the page. */
const TAKEOVER_EVENT = 'writemind:content-script-started';

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  matchAboutBlank: true,
  runAt: 'document_idle',
  async main(ctx) {
    // Pages can opt out entirely, e.g. <html data-writemind="off">.
    if (document.documentElement.getAttribute('data-writemind') === 'off') return;

    // Take over from any older copy of WriteMind still running in this tab (e.g. after an update):
    // ask it to stop, and remove UI it may have left behind so no stale badge remains.
    document.dispatchEvent(new CustomEvent(TAKEOVER_EVENT));
    for (const stale of Array.from(document.querySelectorAll('writemind-ui'))) stale.remove();

    const assistant = new Assistant(document);

    // UI lives in an open shadow root so page CSS cannot affect it (and vice versa).
    const host = document.createElement('writemind-ui');
    host.setAttribute('data-writemind-ui', '');
    host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483646;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = UI_CSS;
    const mount = document.createElement('div');
    shadow.append(style, mount);
    document.documentElement.appendChild(host);
    assistant.uiHost = host;

    const root = createRoot(mount);
    root.render(<App store={assistant.view} actions={assistant} />);

    const onMessage = (message: unknown) => {
      if ((message as { type?: string })?.type === 'open-assistant' && document.hasFocus()) assistant.openPanel('issues');
    };
    browser.runtime.onMessage.addListener(onMessage);

    let stopped = false;
    const shutdown = () => {
      if (stopped) return;
      stopped = true;
      assistant.stop();
      document.removeEventListener(TAKEOVER_EVENT, shutdown);
      clearInterval(watchdog);
      try {
        browser.runtime.onMessage.removeListener(onMessage);
      } catch {
        /* extension context already gone */
      }
      root.unmount();
      host.remove();
    };
    document.addEventListener(TAKEOVER_EVENT, shutdown);
    assistant.onOrphaned = shutdown;
    // The extension was removed, disabled or updated: this copy can no longer check text.
    const watchdog = setInterval(() => {
      if (!browser.runtime?.id) shutdown();
    }, 2000);
    ctx.onInvalidated(shutdown);

    await assistant.start();
  },
});
