// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

import { vueI18nBuildFlags } from '../../packages/shared/src/i18n/buildFlags';

/**
 * The coordinator application. Served at `/` by Caddy.
 *
 * There is no `VITE_API_URL`. The browser always sees one origin — Caddy
 * fronts both the applications and the API in development exactly as in
 * production — so `/api/v1/…` is correct everywhere and the session cookie
 * behaves identically (docs/06 §1). A configurable API base would buy nothing
 * and introduce CORS.
 */

/**
 * The browser reaches this server through Caddy on 8080 and cannot see 5173,
 * so the HMR client must be told which port to dial. Host is left unset on
 * purpose: the client then uses `location.hostname`, which is right whether
 * the developer is on `localhost` or a LAN address.
 */
/**
 * Both applications serve their static files from one directory in
 * `packages/shared/public`, rather than each keeping a copy under its own
 * `public/`. The logo is the whole reason: two copies of a brand asset is two
 * files to update and one of them will be missed, and `logo.svg` is also the
 * favicon, so the stale copy would be the one in the browser tab. Vite copies
 * whatever is here into `dist/` at the bundle's own `base`, which is why the
 * form finds it at `/f/logo.svg` with no configuration of its own.
 */
const publicDir = fileURLToPath(
  new URL('../../packages/shared/public', import.meta.url),
);

const hmrClientPort = Number(process.env['VITE_HMR_CLIENT_PORT'] ?? '8080');

/**
 * Vite refuses a request whose Host header it does not recognise. Caddy
 * forwards the browser's Host (`localhost:8080`), and the container is also
 * reachable as `web` on the compose network.
 */
const allowedHosts = (
  process.env['VITE_ALLOWED_HOSTS'] ?? 'localhost,127.0.0.1,web'
).split(',');

/** Bind-mounted sources from a Windows or macOS host do not deliver inotify. */
const usePolling = process.env['VITE_USE_POLLING'] === 'true';

export default defineConfig({
  base: '/',
  plugins: [vue(), tailwindcss()],
  define: vueI18nBuildFlags,
  publicDir,
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    allowedHosts,
    hmr: {
      protocol: 'ws',
      clientPort: hmrClientPort,
    },
    watch: usePolling ? { usePolling: true, interval: 300 } : {},
  },
  build: {
    // Matches the stated browser-support policy (docs/14 §6) rather than a
    // hand-maintained browserslist nobody revisits.
    target: 'baseline-widely-available',
    // `modulepreload` is itself Baseline, so the polyfill is dead weight.
    modulePreload: { polyfill: false },
    sourcemap: true,
  },
});
