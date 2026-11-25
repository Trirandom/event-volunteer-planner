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
  // One at a time. Every signed-in spec edits the same organisation's worked
  // example — there is one coordinator account and no org management yet —
  // and in parallel the three projects dragged the same day's bar and
  // recoloured the same event at the same moment, each then asserting on a
  // value the other had just moved.
  workers: 1,
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
      // One sign-in for the whole run (e2e/support/coordinator.ts says why).
      name: 'setup',
      testMatch: /\.setup\.ts$/,
    },
    {
      // Before anything loads the worked example, which every other signed-in
      // spec does on its first test (e2e/empty-org.spec.ts says why).
      name: 'empty-org',
      testMatch: /empty-org\.spec\.ts$/,
      use: { ...desktopChrome },
      dependencies: ['setup'],
    },
    {
      name: 'chromium',
      use: { ...desktopChrome },
      testIgnore: /empty-org\.spec\.ts$/,
      dependencies: ['empty-org'],
    },
    {
      // docs/14 §7 — forced-colors on key screens. A separate project rather
      // than a per-test option, so it cannot be forgotten for a new screen.
      name: 'forced-colors',
      // `forcedColors` is a browser-context option, not a top-level test
      // option, in this Playwright line.
      use: { ...desktopChrome, contextOptions: { forcedColors: 'active' } },
      testIgnore: /empty-org\.spec\.ts$/,
      dependencies: ['empty-org'],
    },
    {
      // docs/14 §2 / docs/01 §5 — 320 px is the conformance floor and 400 px
      // is the width the form is designed for. Both are asserted.
      name: 'mobile-320',
      use: { ...desktopChrome, viewport: { width: 320, height: 720 } },
      testIgnore: /empty-org\.spec\.ts$/,
      dependencies: ['empty-org'],
    },
  ],
});
