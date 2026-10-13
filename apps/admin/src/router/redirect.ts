// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import type { LocationQueryValue, RouteLocationRaw } from 'vue-router';

/**
 * Where to send someone once they are signed in, honouring `?redirect=`.
 *
 * Its own module rather than a helper inside the router, so that the login
 * view can use it without importing the router that lazily imports the login
 * view — and so the rules below can be tested without a router at all.
 *
 * The value is attacker-supplied: it arrives in a URL somebody may have been
 * sent. Only a same-origin *path* is accepted. `//evil.example` is a
 * protocol-relative URL that a browser resolves to another origin despite
 * beginning with a slash, and a backslash is normalised to a forward slash by
 * some parsers — both are rejected rather than reasoned about. Anything else,
 * including a missing or repeated parameter, falls back to the admin panel.
 */
export function afterLoginTarget(
  redirect: LocationQueryValue | LocationQueryValue[] | undefined,
): RouteLocationRaw {
  const fallback: RouteLocationRaw = { name: 'admin' };

  if (typeof redirect !== 'string') {
    return fallback;
  }

  const isSameOriginPath =
    redirect.startsWith('/') &&
    !redirect.startsWith('//') &&
    !redirect.includes('\\');

  return isSameOriginPath ? redirect : fallback;
}
