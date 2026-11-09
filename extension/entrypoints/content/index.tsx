import { createRoot } from 'react-dom/client';
import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { Assistant } from '../../src/content/assistant';
import { App } from '../../src/ui/App';
import { UI_CSS } from '../../src/ui/styles';

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  matchAboutBlank: true,
  runAt: 'document_idle',
  async main(ctx) {
    // Pages can opt out entirely, e.g. <html data-writemind="off">.
    if (document.documentElement.getAttribute('data-writemind') === 'off') return;

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

    ctx.onInvalidated(() => {
      browser.runtime.onMessage.removeListener(onMessage);
      root.unmount();
      host.remove();
    });

    await assistant.start();
  },
});
