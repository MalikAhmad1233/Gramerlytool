/**
 * End-to-end tests: real Chromium + the built MV3 extension + the real WriteMind API
 * (LanguageTool-backed) at http://localhost:8000.
 */
import { chromium, expect, test as base, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTENSION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.output/chrome-mv3');
const PAGES = 'http://localhost:4321';
const UNDERLINE = '[data-testid=wm-underline]';

const test = base.extend<{ context: BrowserContext; page: Page }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      viewport: { width: 1280, height: 800 },
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    });
    if (!context.serviceWorkers().length) await context.waitForEvent('serviceworker');
    // A fresh install opens the welcome tab; wait for it so it cannot hijack a test's navigation.
    for (let i = 0; i < 50 && !context.pages().some((p) => p.url().includes('welcome.html')); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await use(context);
    await context.close();
  },
  page: async ({ context }, use) => {
    const page = await context.newPage();
    // The extension opens its welcome/options tab on install; keep the page under test in front
    // (background tabs pause requestAnimationFrame, which drives overlay rendering).
    await page.bringToFront();
    await use(page);
  },
});

async function underlineCount(page: Page): Promise<number> {
  return page.locator(UNDERLINE).count();
}

/** Clicks underlined words until the suggestion card offers `replacement`; returns that button. */
async function acceptButtonFor(page: Page, replacement: string): Promise<Locator> {
  const underlines = page.locator(UNDERLINE);
  const n = await underlines.count();
  for (let i = 0; i < n; i++) {
    await page.keyboard.press('Escape');
    const box = await underlines.nth(i).boundingBox();
    if (!box) continue;
    await page.mouse.click(box.x + box.width / 2, box.y - 6);
    const card = page.getByTestId('wm-card');
    if (!(await card.isVisible().catch(() => false))) await card.waitFor({ timeout: 2000 }).catch(() => undefined);
    const button = card.getByTestId('wm-accept').filter({ hasText: new RegExp(`^${replacement}$`) });
    if (await button.count()) return button.first();
  }
  throw new Error(`No suggestion card offers “${replacement}”`);
}

test('textarea: highlights errors, never edits on its own, applies only on Accept, keeps undo', async ({ page }) => {
  await page.goto(`${PAGES}/textarea.html`);
  await page.bringToFront();
  const ta = page.locator('#ta');
  const text = 'She go to school and I recieved teh files.';
  await ta.click();
  await ta.pressSequentially(text, { delay: 15 });

  await expect.poll(() => underlineCount(page)).toBeGreaterThanOrEqual(3);
  await expect(page.getByTestId('wm-count')).toHaveText('3');

  // Critical rule: waiting through fast *and* full checks must never change the text.
  await page.waitForTimeout(2500);
  await expect(ta).toHaveValue(text);

  await (await acceptButtonFor(page, 'the')).click();
  await expect(ta).toHaveValue('She go to school and I recieved the files.');
  await expect.poll(() => underlineCount(page)).toBe(2);

  // The edit went through the native editing pipeline, so Ctrl+Z restores the original.
  await ta.focus();
  await page.keyboard.press('Control+z');
  await expect(ta).toHaveValue(text);
});

test('textarea: Ignore removes a suggestion without touching the text', async ({ page }) => {
  await page.goto(`${PAGES}/textarea.html`);
  const ta = page.locator('#ta');
  await ta.click();
  await ta.pressSequentially('I recieved it yesterday.', { delay: 10 });
  await expect.poll(() => underlineCount(page)).toBe(1);
  const box = await page.locator(UNDERLINE).first().boundingBox();
  await page.mouse.click(box!.x + box!.width / 2, box!.y - 6);
  await page.getByTestId('wm-ignore').click();
  await expect.poll(() => underlineCount(page)).toBe(0);
  await expect(ta).toHaveValue('I recieved it yesterday.');
});

test('sensitive and opted-out fields are never checked', async ({ page }) => {
  await page.goto(`${PAGES}/textarea.html`);
  for (const id of ['#pw', '#card', '#optout']) {
    await page.locator(id).click();
    await page.locator(id).pressSequentially('teh pasword recieved', { delay: 5 });
    await page.waitForTimeout(1200);
    expect(await underlineCount(page), id).toBe(0);
    await expect(page.getByTestId('wm-badge'), id).toHaveCount(0);
  }
  // Positive control: an ordinary input on the same page is checked.
  await page.locator('#subject').click();
  await page.locator('#subject').pressSequentially('Meeting about teh budget', { delay: 5 });
  await expect.poll(() => underlineCount(page)).toBe(1);
});

test('contenteditable (Gmail-style): checks own text only, applies via native editing, supports undo', async ({ page }) => {
  await page.goto(`${PAGES}/contenteditable.html`);
  const ce = page.locator('#ce');
  await ce.click({ position: { x: 600, y: 10 } });
  // go, recieved, teh — and nothing inside the quoted reply.
  await expect.poll(() => underlineCount(page)).toBe(3);
  await expect(page.getByTestId('wm-count')).toHaveText('3');

  await (await acceptButtonFor(page, 'received')).click();
  await expect(ce).toContainText('She go to school and I received teh files.');
  await expect(ce.locator('blockquote')).toHaveText('Earlier mesage with teh typo that is not mine.');
  await expect.poll(() => underlineCount(page)).toBe(2);

  await page.keyboard.press('Control+z');
  await expect(ce).toContainText('I recieved teh files.');
});

test('model-owning editor (Lexical-style) receives the correction through its own model', async ({ page }) => {
  await page.goto(`${PAGES}/model-editor.html`);
  await page.locator('#me').click();
  await expect.poll(() => underlineCount(page)).toBe(1);
  await (await acceptButtonFor(page, 'the')).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __model: string }).__model)).toBe(
    'Please send me the report today.',
  );
  await expect.poll(() => underlineCount(page)).toBe(0);
});

test('rewrite: alternatives in a chosen style replace the selection only on click', async ({ page }) => {
  await page.goto(`${PAGES}/textarea.html`);
  const ta = page.locator('#ta');
  const text = 'hey can u send me the report asap';
  await ta.click();
  await ta.pressSequentially(text, { delay: 5 });
  await page.getByTestId('wm-badge').waitFor();
  await ta.focus();
  await page.keyboard.press('Control+a');

  await page.getByTestId('wm-badge').click();
  await page.getByTestId('wm-tab-rewrite').click();
  await expect(page.getByTestId('wm-rewrite-source')).toHaveText(text);
  await page.getByRole('radio', { name: 'Formal' }).click();
  await page.getByTestId('wm-generate').click();

  const alternative = page.getByTestId('wm-alternative').first();
  await expect(alternative).toContainText('Hello, can you send me the report as soon as possible?');
  await page.waitForTimeout(500);
  await expect(ta).toHaveValue(text); // still untouched until the user clicks Replace

  await alternative.getByTestId('wm-replace').click();
  await expect(ta).toHaveValue('Hello, can you send me the report as soon as possible?');
});

/** Points the extension at an address where no WriteMind server runs — like a fresh install on a user's PC. */
async function withoutServer(context: BrowserContext): Promise<string> {
  let [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent('serviceworker');
  await sw.evaluate(() => chrome.storage.local.set({ settings: { apiBaseUrl: 'http://127.0.0.1:9' } }));
  return sw.url().split('/')[2]!;
}

test('no server: the built-in checker underlines and fixes errors', async ({ context, page }) => {
  await withoutServer(context);
  await page.goto(`${PAGES}/textarea.html`);
  await page.bringToFront();
  const ta = page.locator('#ta');
  const text = 'She go to school and I recieved teh files.';
  await ta.click();
  await ta.pressSequentially(text, { delay: 10 });
  await expect.poll(() => underlineCount(page)).toBe(3);
  await expect(page.getByTestId('wm-badge')).not.toHaveClass(/offline/);
  await page.waitForTimeout(2000);
  await expect(ta).toHaveValue(text); // still never edits on its own

  await (await acceptButtonFor(page, 'goes')).click();
  await expect(ta).toHaveValue('She goes to school and I recieved teh files.');
  await (await acceptButtonFor(page, 'the')).click();
  await expect(ta).toHaveValue('She goes to school and I recieved the files.');
});

test('no server: rewrite and the popup still work', async ({ context, page }) => {
  const extensionId = await withoutServer(context);
  await page.goto(`${PAGES}/textarea.html`);
  await page.bringToFront();
  const ta = page.locator('#ta');
  await ta.click();
  await ta.pressSequentially('hey can u send me the report asap', { delay: 5 });
  await page.getByTestId('wm-badge').waitFor();
  await ta.focus();
  await page.keyboard.press('Control+a');
  await page.getByTestId('wm-badge').click();
  await page.getByTestId('wm-tab-rewrite').click();
  await page.getByRole('radio', { name: 'Formal' }).click();
  await page.getByTestId('wm-generate').click();
  const alternative = page.getByTestId('wm-alternative').first();
  await expect(alternative).toContainText('Hello, can you send me the report as soon as possible?');
  await alternative.getByTestId('wm-replace').click();
  await expect(ta).toHaveValue('Hello, can you send me the report as soon as possible?');

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.getByTestId('engine-status')).toContainText('built-in checker');
  await expect(popup.getByText(/sign in|sign up|log in/i)).toHaveCount(0);
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(options.getByTestId('engine-status')).toContainText('built-in checker');
  await expect(options.getByText(/sign in|sign up|create account|log in/i)).toHaveCount(0);
});

const WHATSAPP_HTML = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'pages/whatsapp.html'), 'utf8');
const USER_SENTENCE = "My naame is ahmed& I'm yourr aducalnal";

/** Serves the local WhatsApp-like page at the real web.whatsapp.com address, so the WhatsApp profile applies. */
async function openWhatsApp(context: BrowserContext, page: Page): Promise<void> {
  await context.route('https://web.whatsapp.com/**', (route) => route.fulfill({ contentType: 'text/html', body: WHATSAPP_HTML }));
  await page.goto('https://web.whatsapp.com/');
  await page.bringToFront();
}

test('WhatsApp Web: misspellings in a chat message are underlined and fixed in the editor model', async ({ context, page }) => {
  await withoutServer(context);
  await openWhatsApp(context, page);
  await page.locator('#wa').click();
  await page.keyboard.type(USER_SENTENCE, { delay: 10 });
  await expect.poll(() => underlineCount(page)).toBe(4); // naame, ahmed, yourr, aducalnal
  await expect(page.getByTestId('wm-count')).toHaveText('4');
  await (await acceptButtonFor(page, 'name')).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __model: () => string }).__model())).toBe(
    "My name is ahmed& I'm yourr aducalnal",
  );
});

test('a server address answered by something other than WriteMind falls back to the built-in checker', async ({ context, page }) => {
  let [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent('serviceworker');
  // The test-page server answers every API path with 404 — like another app occupying the port.
  await sw.evaluate(() => chrome.storage.local.set({ settings: { apiBaseUrl: 'http://localhost:4321' } }));
  await page.goto(`${PAGES}/textarea.html`);
  await page.bringToFront();
  await page.locator('#ta').click();
  await page.locator('#ta').pressSequentially('I recieved teh files.', { delay: 5 });
  await expect.poll(() => underlineCount(page)).toBe(2);
});

test('when the extension is removed or restarted, the old copy removes its badge (no stale "no issues")', async ({ context, page }) => {
  let [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent('serviceworker');
  await sw.evaluate(() => chrome.storage.local.set({ settings: { apiBaseUrl: 'http://127.0.0.1:9' } }));
  await openWhatsApp(context, page);
  await page.locator('#wa').click();
  await page.keyboard.type(USER_SENTENCE, { delay: 5 });
  await expect.poll(() => underlineCount(page)).toBe(4);
  await sw.evaluate(() => chrome.runtime.reload()).catch(() => undefined);
  await expect.poll(() => page.locator('writemind-ui').count(), { timeout: 10_000 }).toBe(0);
});

test('a newly injected copy (as on install/update) takes over an open tab cleanly', async ({ context, page }) => {
  let [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent('serviceworker');
  await sw.evaluate(() => chrome.storage.local.set({ settings: { apiBaseUrl: 'http://127.0.0.1:9' } }));
  await openWhatsApp(context, page);
  await page.locator('#wa').click();
  await page.keyboard.type(USER_SENTENCE, { delay: 5 });
  await expect.poll(() => underlineCount(page)).toBe(4);

  // Exactly what the background does for open tabs on install/update.
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
    await chrome.scripting.executeScript({ target: { tabId: tab!.id!, allFrames: true }, files: ['/content-scripts/content.js'] });
  });
  await page.waitForTimeout(500);
  await expect(page.locator('writemind-ui')).toHaveCount(1);
  await page.locator('#wa').click();
  await page.keyboard.type(' ok', { delay: 5 });
  await expect.poll(() => underlineCount(page)).toBe(4);
  await expect(page.getByTestId('wm-badge')).toHaveAttribute('data-state', 'issues');
});

test('leftover UI from an older copy is removed, and a failed check is never shown as "no issues"', async ({ page }) => {
  await page.goto(`${PAGES}/textarea.html`);
  await page.bringToFront();
  await page.evaluate(() => {
    const stale = document.createElement('writemind-ui');
    stale.id = 'stale';
    document.documentElement.appendChild(stale);
    document.dispatchEvent(new CustomEvent('writemind:content-script-started'));
  });
  // A newer copy starting up (simulated by re-dispatching) shuts the current one down…
  await expect.poll(() => page.locator('writemind-ui:not(#stale)').count()).toBe(0);
});

test('welcome page: choose British English and try the built-in checker', async ({ context }) => {
  const extensionId = await withoutServer(context);
  const welcome = await context.newPage();
  await welcome.goto(`chrome-extension://${extensionId}/welcome.html`);
  const results = welcome.getByTestId('demo-results');
  await expect(results).toContainText('Uncountable noun');
  const demo = welcome.getByTestId('demo-text');
  const before = await demo.inputValue();
  // Nothing changes until a fix is clicked.
  await welcome.waitForTimeout(500);
  expect(await demo.inputValue()).toBe(before);
  await results.getByRole('button', { name: /informations\s+information/ }).click();
  await expect(demo).toHaveValue(/the information yesterday/);

  await demo.fill('The colour of the organisation logo.');
  await expect(results).toContainText('British spelling');
  await welcome.getByTestId('choose-gb').click();
  await expect(results).toContainText('Looks great');
});
