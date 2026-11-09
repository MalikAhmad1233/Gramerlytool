/**
 * End-to-end tests: real Chromium + the built MV3 extension + the real WriteMind API
 * (LanguageTool-backed) at http://localhost:8000.
 */
import { chromium, expect, test as base, type BrowserContext, type Locator, type Page } from '@playwright/test';
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

test('account: register in Options, dictionary syncs to the server and silences that word', async ({ context, page }) => {
  let [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent('serviceworker');
  const extensionId = sw.url().split('/')[2];
  const email = `e2e-${Date.now()}@example.com`;

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.getByRole('button', { name: 'Create an account' }).click();
  await options.getByPlaceholder('you@example.com').fill(email);
  await options.getByPlaceholder(/Password/).fill('Writer#2026');
  await options.getByRole('button', { name: 'Create account' }).click();
  await expect(options.getByText(email, { exact: true })).toBeVisible();

  const dictionary = options.locator('section', { hasText: 'Personal dictionary' });
  await dictionary.getByPlaceholder('Add a word, e.g. Kubernetes').fill('Ahmadzai');
  await dictionary.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(options.locator('.tag', { hasText: 'Ahmadzai' })).toBeVisible();

  // The word reached the server-side dictionary.
  const auth = await sw.evaluate(async () => (await chrome.storage.local.get('auth')).auth as { accessToken: string });
  await expect
    .poll(async () => {
      const res = await fetch('http://localhost:8000/v1/dictionary', { headers: { Authorization: `Bearer ${auth.accessToken}` } });
      return ((await res.json()) as { words: string[] }).words;
    })
    .toContain('Ahmadzai');

  await page.bringToFront();
  await page.goto(`${PAGES}/textarea.html`);
  await page.locator('#ta').click();
  await page.locator('#ta').pressSequentially('Ahmadzai recieved the files.', { delay: 5 });
  await expect.poll(() => underlineCount(page)).toBe(1); // only "recieved"
});
