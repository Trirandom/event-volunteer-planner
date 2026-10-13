// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end and accessibility. Both run against the Compose stack through
 * Caddy on 8080, never against a Vite dev server directly: the whole point of
 * the single-origin topology is that cookies, CSP and the `/api` path behave
 * in tests as they do in production (docs/06 §1).
 */
const baseURL = process.env['EVP_E2E_BASE_URL'] ?? 'http://localhost:8080';

const desktopChrome = devices['Desktop Chrome'];

/**
 * The specs are written against the English UI, so English is pinned twice
 * over: the browser's language (what the form and a signed-out visitor
 * negotiate from) and the coordinator application's per-device choice, which
 * outranks the account's `locale` — `fr` by default — once a spec signs in
 * (`apps/admin/src/i18n/preference.ts`). Without the second, every spec would
 * turn French at its first login.
 */
const englishUi = {
  locale: 'en-GB',
  storageState: {
    cookies: [],
    origins: [
      {
        origin: new URL(baseURL).origin,
        localStorage: [{ name: 'evp.locale', value: 'en' }],
      },
    ],
  },
};

export default defineConfig({
  testDir: './e2e',
  // No retries. A flaky test is fixed or deleted, not re-run — the first red
  // build somebody re-runs "because it's flaky" is the one telling the truth
  // (docs/13 §8).
  retries: 0,
  forbidOnly: process.env['CI'] === 'true',
  reporter: process.env['CI'] === 'true' ? [['list'], ['junit']] : [['list']],
  use: {
    baseURL,
    ...englishUi,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...desktopChrome },
    },
    {
      // docs/14 §7 — forced-colors on key screens. A separate project rather
      // than a per-test option, so it cannot be forgotten for a new screen.
      name: 'forced-colors',
      // `forcedColors` is a browser-context option, not a top-level test
      // option, in this Playwright line.
      use: { ...desktopChrome, contextOptions: { forcedColors: 'active' } },
    },
    {
      // docs/14 §2 / docs/01 §5 — 320 px is the conformance floor and 400 px
      // is the width the form is designed for. Both are asserted.
      name: 'mobile-320',
      use: { ...desktopChrome, viewport: { width: 320, height: 720 } },
    },
  ],
});
