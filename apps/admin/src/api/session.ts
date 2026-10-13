// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The session: who the caller is, how they sign in, how they sign out.
 *
 * Password login is the only method implemented, and is deliberately the
 * fallback rather than the front door ([ADR-0031](../../../../docs/adr/0031-password-bootstrap-credential.md)).
 * Magic links and OIDC land on the same `sessions` table and the same
 * `GET /auth/me` shape, so when they arrive only `login()` below gains
 * siblings — nothing that consumes `Session` changes.
 */

import * as v from 'valibot';

import { request, requestNoContent, type Failure } from './http';

/**
 * Stable error identifiers from `evp-api`'s `error.rs`. Branching happens on
 * these, never on `title` or `detail`, which are prose (docs/04 §Error
 * format).
 */
const INVALID_CREDENTIALS = 'https://evp.example/errors/invalid-credentials';
const UNAUTHENTICATED = 'https://evp.example/errors/unauthenticated';

const membershipSchema = v.object({
  org_id: v.pipe(v.string(), v.minLength(1)),
  slug: v.pipe(v.string(), v.minLength(1)),
  name: v.pipe(v.string(), v.minLength(1)),
  /**
   * `owner`, `coordinator` or `zone_lead` — kept as a plain string rather than
   * a `picklist`. The server decodes `member_role` as text for the same
   * reason: adding a role to the database enum must not turn every existing
   * row into a parse failure at the boundary.
   */
  role: v.pipe(v.string(), v.minLength(1)),
});

const userSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  email: v.pipe(v.string(), v.minLength(1)),
  display_name: v.pipe(v.string(), v.minLength(1)),
  locale: v.pipe(v.string(), v.minLength(1)),
  memberships: v.array(membershipSchema),
});

export type Membership = v.InferOutput<typeof membershipSchema>;
export type User = v.InferOutput<typeof userSchema>;

/**
 * What `GET /auth/me` established.
 *
 * `anonymous` is a first-class answer rather than an error: not being signed
 * in is the ordinary state of a visitor on the landing page, and modelling it
 * as a rejected query would make every public view render an error banner.
 */
export type Session =
  | { readonly status: 'authenticated'; readonly user: User }
  | { readonly status: 'anonymous' }
  | { readonly status: 'unavailable' };

/** The TanStack Query key for the session. One key, so one cached answer. */
export const sessionQueryKey = ['session'];

/**
 * `GET /api/v1/auth/me`.
 *
 * Never throws, so the router guard can await it without a `try`. A 401 is
 * `anonymous`; anything else that went wrong is `unavailable`, which callers
 * must not treat as "signed out" — telling a coordinator their session ended
 * because a proxy hiccuped would send them to re-enter a password they did
 * not need to.
 */
export async function fetchSession(signal?: AbortSignal): Promise<Session> {
  const result = await request(
    {
      method: 'GET',
      path: '/api/v1/auth/me',
      ...(signal === undefined ? {} : { signal }),
    },
    userSchema,
  );

  if (result.ok) {
    return { status: 'authenticated', user: result.value };
  }

  return result.failure.reason === 'rejected' &&
    result.failure.problem.type === UNAUTHENTICATED
    ? { status: 'anonymous' }
    : { status: 'unavailable' };
}

/** Why a sign-in attempt did not produce a session. */
export type LoginRejection =
  /**
   * The address and password do not match an account. One outcome for
   * "no such address", "no password on that account" and "wrong password",
   * because the server refuses to distinguish them and this must not appear
   * to (docs/12).
   */
  | { readonly reason: 'invalid-credentials'; readonly detail: string }
  /** The server refused for a reason this build does not know about. */
  | { readonly reason: 'refused'; readonly detail: string }
  /** Nothing usable came back, or the body was not the documented shape. */
  | { readonly reason: 'unavailable' };

export type LoginResult =
  | { readonly ok: true; readonly user: User }
  | { readonly ok: false; readonly rejection: LoginRejection };

/**
 * `POST /api/v1/auth/login` — exchange an address and password for the session
 * cookie.
 *
 * The cookie is `HttpOnly`, so nothing here can read it and nothing needs to:
 * the browser attaches it to every subsequent same-origin call. The user in
 * the response is the server's own reading of the row, not an echo of the
 * request — `email` is `citext`, so the stored casing may differ from what was
 * typed.
 */
export async function login(
  email: string,
  password: string,
): Promise<LoginResult> {
  const result = await request(
    {
      method: 'POST',
      path: '/api/v1/auth/login',
      body: { email, password },
    },
    userSchema,
  );

  return result.ok
    ? { ok: true, user: result.value }
    : { ok: false, rejection: rejectionFor(result.failure) };
}

function rejectionFor(failure: Failure): LoginRejection {
  if (failure.reason !== 'rejected') {
    return { reason: 'unavailable' };
  }

  const { problem } = failure;
  const detail = problem.detail ?? problem.title;

  return problem.type === INVALID_CREDENTIALS
    ? { reason: 'invalid-credentials', detail }
    : { reason: 'refused', detail };
}

/**
 * `POST /api/v1/auth/logout` — revoke this device's session.
 *
 * Returns nothing, because there is nothing a caller should do differently on
 * failure: the endpoint is idempotent and always clears the cookie, and a user
 * who asked to sign out is sent to the door either way. Leaving them on an
 * admin screen with an error would be a worse answer to "log me out" than
 * ending the session locally and letting the next request discover the truth.
 */
export async function logout(): Promise<void> {
  await requestNoContent({ method: 'POST', path: '/api/v1/auth/logout' });
}
