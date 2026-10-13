// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { createRouter, createWebHistory } from 'vue-router';

import { setLocale } from '../i18n';
import { formLocale } from '../i18n/negotiate';

/**
 * The history base matches Caddy's `/f/*` route and Vite's `base`, so
 * `https://evp.example/f/{form_slug}` (docs/09 §4) resolves without a rewrite.
 *
 * The capability token arrives as `?t=` and is deliberately not part of the
 * route: it is a credential, not an identifier, and keeping it in the query
 * means it is never interpolated into a path or a route name.
 */
export const router = createRouter({
  history: createWebHistory('/f/'),
  routes: [
    {
      path: '/:slug',
      name: 'form',
      // Its own chunk: the picker needs `Temporal`, and the polyfill is most
      // of the form's weight. Split off, the page's shell and heading paint
      // while it downloads, and the chunk caches across deploys that do not
      // touch it (docs/01 §5).
      component: async () => import('../views/FormView.vue'),
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'unavailable',
      // docs/09 §5: an unknown slug and a revoked token return the same
      // generic page, so neither confirms the existence of the other.
      component: async () => import('../views/UnavailableView.vue'),
    },
  ],
});

// Before the view renders, so the first paint is already in the right
// language — including the first load, where the English catalogue is fetched
// here rather than after a French flash.
router.beforeEach(async (to) => {
  await setLocale(formLocale(to.query, globalThis.navigator.languages));
});

router.afterEach(() => {
  queueMicrotask(() => {
    const heading = document.querySelector('h1');
    if (heading instanceof HTMLElement) {
      heading.setAttribute('tabindex', '-1');
      heading.focus();
    }
  });
});
