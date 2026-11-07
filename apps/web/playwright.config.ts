import { defineConfig } from '@playwright/test';

const WEB = 'http://localhost:5173';

/**
 * Runs against the real stack: API, WS gateway (live Binance feed), settlement worker
 * and Vite. Postgres and Redis must already be up (`npm run dev:deps`). Servers already running
 * are reused. Uses the installed Google Chrome, so no browser download is needed.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: WEB,
    channel: 'chrome',
    headless: true,
    locale: 'pt-BR',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    { command: 'npm run dev:ws', cwd: '../..', url: 'http://127.0.0.1:3001/healthz', reuseExistingServer: true, timeout: 60_000 },
    { command: 'npm run dev:api', cwd: '../..', url: 'http://127.0.0.1:3000/api/auth/csrf', reuseExistingServer: true, timeout: 60_000 },
    { command: 'npm run dev:worker', cwd: '../..', url: 'http://127.0.0.1:3002/healthz', reuseExistingServer: true, timeout: 60_000 },
    { command: 'npm run dev', url: WEB, reuseExistingServer: true, timeout: 60_000 },
  ],
});
