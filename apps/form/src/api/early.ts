// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The form request, started before the application has booted (docs/01 §5).
 *
 * Left to the application, `GET /api/v1/public/forms/{slug}` waits for the
 * entry chunk to download and run, for the router to resolve, and for the
 * `FormView` chunk to arrive and mount: three round trips in a row, each one
 * hundreds of milliseconds on venue mobile data, before the one request that
 * carries the form is even sent. `src/early.ts` is a separate, tiny entry the
 * build puts in front of the application's (`build/firstPaint.ts`). It reads
 * the route from the address bar and sends this request while the rest of
 * the bundle is still downloading, and `FormView` takes the response instead
 * of sending its own.
 *
 * Not an inline script: the production CSP is `script-src 'self'`
 * (docker/caddy/Caddyfile), and relaxing it for a few hundred milliseconds is
 * a bad trade. Not a `<link rel=preload>` either: the path depends on the
 * address, which static HTML does not know.
 *
 * Nothing here may import anything. This module is the early entry's whole
 * weight, and pulling valibot or Vue in would make the entry as slow as the
 * application it is meant to overtake.
 *
 * Getting the route wrong costs a wasted request, never a wrong form: the
 * response is only handed to a load for the same slug and token, and the
 * path is built by the same function either way.
 */

export interface FormRoute {
  readonly slug: string;
  readonly token: string | null;
}

/** The base is `/f/` in every environment (apps/form/vite.config.ts). */
const PREFIX = '/f/';

/**
 * Mirrors the router's reading of the address (`router/index.ts`): `/:slug`
 * with an optional trailing slash, and the capability token in `?t=`.
 * vue-router turns a repeated key into an array, which `FormView` treats as
 * no token, so a repeated `t` is read as none here too.
 */
export function formRoute(pathname: string, search: string): FormRoute | null {
  if (!pathname.startsWith(PREFIX)) {
    return null;
  }
  const rest = pathname.slice(PREFIX.length).replace(/\/$/, '');
  if (rest === '' || rest.includes('/')) {
    return null;
  }
  let slug: string;
  try {
    slug = decodeURIComponent(rest);
  } catch {
    return null;
  }
  const tokens = new URLSearchParams(search).getAll('t');
  const [token] = tokens;
  return {
    slug,
    token:
      tokens.length === 1 && token !== undefined && token !== '' ? token : null,
  };
}

export function publicFormPath(
  slug: string,
  token: string | null,
  suffix = '',
): string {
  const query = token === null ? '' : `?t=${encodeURIComponent(token)}`;
  return `/api/v1/public/forms/${encodeURIComponent(slug)}${suffix}${query}`;
}

/**
 * What `api/http.ts` sends for a GET. Restated rather than imported, because
 * that module brings valibot; `early.test.ts` holds the two to the same
 * request. `credentials: 'omit'` for the reason given there.
 */
const GET: RequestInit = {
  method: 'GET',
  headers: { accept: 'application/json' },
  credentials: 'omit',
};

export interface Early {
  start(route: FormRoute, fetcher?: typeof fetch): void;
  /**
   * The early response for this route, once. Every later load (a retry, a
   * stale version, a lapsed captcha) must go to the network: a response
   * taken twice would hand back an answer, and a captcha challenge, that
   * the server has since moved past.
   */
  take(route: FormRoute): Promise<Response> | null;
}

export function createEarly(): Early {
  let slot: { route: FormRoute; response: Promise<Response> } | null = null;
  return {
    start(route, fetcher = globalThis.fetch) {
      const response = fetcher(publicFormPath(route.slug, route.token), GET);
      // Marked as handled: nobody may be listening yet, and an offline
      // volunteer should get the form's own "unreachable" page, not an
      // unhandled rejection. The rejection still reaches whoever takes it.
      response.catch(() => undefined);
      slot = { route, response };
    },
    take(route) {
      const held = slot;
      slot = null;
      return held !== null &&
        held.route.slug === route.slug &&
        held.route.token === route.token
        ? held.response
        : null;
    },
  };
}

/** The one the early entry starts and `FormView` takes. */
export const early = createEarly();
