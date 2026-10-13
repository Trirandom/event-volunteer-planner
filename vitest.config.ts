// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

import { vueI18nBuildFlags } from './packages/shared/src/i18n/buildFlags';

/**
 * One runner over the whole workspace.
 *
 * This replaces `vitest.workspace.ts`, which Vitest deprecated in v3 and
 * removed thereafter; `test.projects` is the same idea in the file that also
 * holds the shared settings, so there is one place to look.
 *
 * The harness deliberately pins no `TZ` and no locale. The Rust suite is
 * re-run under `TZ=Pacific/Chatham` to prove the server's timezone is
 * irrelevant, and pinning it here would make the equivalent frontend job prove
 * nothing (docs/13 §8, docs/16 §7). A test that cares about a zone names it.
 */
export default defineConfig({
  // The same switches the applications build with, so a test exercises the
  // vue-i18n the browser gets.
  define: vueI18nBuildFlags,
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'shared',
          root: './packages/shared',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        extends: true,
        // Both application projects mount `.vue` single-file components in
        // their tests (`EventsView.test.ts`, `params.test.ts`), which is
        // plain, unparsable JS to esbuild without this transform — Vite's own
        // config carries it for the dev server and build, but a `test.projects`
        // entry does not inherit `vite.config.ts`'s `plugins`, only its own.
        plugins: [vue()],
        test: {
          name: 'admin',
          root: './apps/admin',
          environment: 'jsdom',
          include: ['src/**/*.test.ts'],
          setupFiles: ['./src/i18n/testSetup.ts'],
        },
      },
      {
        extends: true,
        plugins: [vue()],
        test: {
          name: 'form',
          root: './apps/form',
          environment: 'jsdom',
          include: ['src/**/*.test.ts'],
          setupFiles: ['./src/i18n/testSetup.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      // Coverage is a ratchet, not a target (docs/13 §10). No global
      // threshold is set here on purpose; the ratchet against the base branch
      // is planned, not yet run anywhere.
      include: ['packages/shared/src/**', 'apps/*/src/**'],
      exclude: ['**/*.test.ts', '**/main.ts', '**/*.d.ts'],
    },
    // A flaky test is fixed or deleted within one working day. There is no
    // retry mechanism, deliberately (docs/13 §8).
    retry: 0,
  },
});
