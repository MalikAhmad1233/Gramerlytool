import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  use: { trace: 'off' },
  webServer: {
    command: 'node e2e/server.mjs',
    url: 'http://localhost:4321/textarea.html',
    reuseExistingServer: true,
  },
});
