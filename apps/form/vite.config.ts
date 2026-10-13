// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

import { vueI18nBuildFlags } from '../../packages/shared/src/i18n/buildFlags';

/**
 * The public volunteer form. Served at `/f/` by Caddy (docs/09 §4).
 *
 * `base` is `/f/` in development as well as production, and that is
 * load-bearing rather than cosmetic: Vite's HMR WebSocket endpoint is mounted
 * at `base`, so the browser dials `ws://localhost:8080/f/`, which is the only
 * path Caddy can route to this server rather than to the admin one. It also
 * means the dev Caddyfile must *not* strip the `/f` prefix — a `handle_path`
 * in development would hand this server request paths its own asset URLs do
 * not match, and HMR would fail with no useful error. Production strips the
 * prefix correctly, because there the built HTML already refers to
 * `/f/assets/…` and those files sit at `/srv/form/assets/…`.
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

const allowedHosts = (
  process.env['VITE_ALLOWED_HOSTS'] ?? 'localhost,127.0.0.1,web'
).split(',');

const usePolling = process.env['VITE_USE_POLLING'] === 'true';

export default defineConfig({
  base: '/f/',
  plugins: [vue(), tailwindcss()],
  define: vueI18nBuildFlags,
  publicDir,
  server: {
    host: true,
    port: 5174,
    strictPort: true,
    allowedHosts,
    hmr: {
      protocol: 'ws',
      clientPort: hmrClientPort,
    },
    watch: usePolling ? { usePolling: true, interval: 300 } : {},
  },
  build: {
    target: 'baseline-widely-available',
    modulePreload: { polyfill: false },
    sourcemap: true,
    // This bundle is loaded once, on a phone, on event-site mobile data
    // (docs/01 §5: < 1.5 s cold on 3G-fast). A rollup warning at 250 kB is
    // early enough to be a conversation rather than a regression.
    chunkSizeWarningLimit: 250,
  },
});
