// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The form's first entry: it sends the form request and nothing else
 * (`api/early.ts`). The production build puts it in `<head>` ahead of the
 * application (`build/firstPaint.ts`); `main.ts` imports it too, which in a
 * build resolves to the same module, run once, and in development is what
 * runs it at all.
 *
 * `/f/demo` is served from a fixture in development and has no API behind
 * it, so asking for it would only log a 404.
 */
import { early, formRoute } from './api/early';

const route = formRoute(
  globalThis.location.pathname,
  globalThis.location.search,
);

if (route !== null && !(import.meta.env.DEV && route.slug === 'demo')) {
  early.start(route);
}
