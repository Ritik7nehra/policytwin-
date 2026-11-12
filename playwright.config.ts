import { defineConfig } from '@playwright/test';

// E2E expects a production build: `npm run build` first. The server runs in
// fully offline mode (simulated PayPal, deterministic agents, in-memory store).
// `next start` is production mode, where the app fails closed without access control — so the e2e server gets a
// throw-away passcode and secret, and the tests sign in through the real login gate.
export const E2E_PASSCODE = 'e2e-demo-passcode';
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
    // Optional: point at an already-installed Chromium (e.g. PW_CHROMIUM_PATH=/opt/pw-browsers/chromium)
    // when the browser build that this Playwright version expects is not available.
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  webServer: {
    command: 'npx next start -p 3100',
    url: 'http://127.0.0.1:3100',
    reuseExistingServer: true,
    timeout: 60_000,
    env: {
      OPENAI_API_KEY: '',
      PAYPAL_CLIENT_ID: '',
      PAYPAL_CLIENT_SECRET: '',
      DATABASE_URL: '',
      DEMO_PASSCODE: E2E_PASSCODE,
      SESSION_SECRET: 'e2e-only-session-secret-0123456789abcdef',
      // Generous limits so a full demo walkthrough (plus repeated runs on a reused server) never trips the rate limiter.
      RATE_LIMIT_HEAVY_PER_MIN: '200',
      RATE_LIMIT_WRITE_PER_MIN: '400',
      RATE_LIMIT_LOGIN_PER_15MIN: '100',
      MAX_RUNS_PER_SESSION: '60',
    },
  },
});
