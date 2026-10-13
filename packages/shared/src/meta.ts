// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import * as v from 'valibot';

/**
 * `GET /api/v1/meta` — the AGPL §13 endpoint (docs/04 §3, CONTRIBUTING).
 *
 * Two things about this file, because both are easy to get wrong later.
 *
 * First, the shape is *parsed*, not asserted. Even once `@evp/api-client` is
 * generated, its types are compile-time only and give no runtime guarantee
 * (docs/11 §3). This schema is the boundary parser and stays after the client
 * lands; what changes then is that a type test asserts the client's `Meta` is
 * assignable to `InferOutput<typeof metaSchema>`, so a contract change fails
 * the build here rather than at a user's browser.
 *
 * Second, the source URL is fetched at runtime and never baked in at build
 * time. `EVP_SOURCE_URL` belongs to the *deployment*: an operator who forks
 * and redeploys the published image must be able to point it at their own
 * fork by setting one variable. A `VITE_`-prefixed build-time constant would
 * make that a rebuild, and a fork that cannot cheaply change it is a fork that
 * ships the upstream URL and is out of compliance.
 */
export const metaSchema = v.object({
  version: v.pipe(v.string(), v.minLength(1)),
  commit: v.pipe(v.string(), v.minLength(1)),
  // `v.url()` alone is not enough: it accepts anything `new URL()` parses,
  // and `javascript:alert(1)` parses. This value is rendered as an `href`, so
  // the scheme is checked rather than assumed.
  source_url: v.pipe(
    v.string(),
    v.url(),
    v.check(
      (value) => value.startsWith('https://') || value.startsWith('http://'),
      'source_url must be an http(s) URL',
    ),
  ),
});

export type Meta = v.InferOutput<typeof metaSchema>;

export type MetaResult =
  | { readonly ok: true; readonly meta: Meta }
  | { readonly ok: false; readonly reason: 'unreachable' | 'malformed' };

/**
 * Same origin, always. Caddy fronts both the applications and the API, so the
 * browser sees one origin and the session cookie behaves in development
 * exactly as it does in production (docs/06 §1).
 */
export async function fetchMeta(signal?: AbortSignal): Promise<MetaResult> {
  let body: unknown;
  try {
    const response = await fetch('/api/v1/meta', {
      headers: { accept: 'application/json' },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      return { ok: false, reason: 'unreachable' };
    }
    body = await response.json();
  } catch {
    return { ok: false, reason: 'unreachable' };
  }

  const parsed = v.safeParse(metaSchema, body);
  return parsed.success
    ? { ok: true, meta: parsed.output }
    : { ok: false, reason: 'malformed' };
}
