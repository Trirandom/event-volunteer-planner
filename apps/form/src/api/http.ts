// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The form's only door to the API.
 *
 * Deliberately not `apps/admin/src/api/http.ts`, even though the shape is the
 * same: the two bundles may not share an API client (docs/09 §6 — the split is
 * a security boundary), and this one has neither a session, a CSRF token nor
 * an `If-Match` to carry. What it keeps from the admin client is the one idea
 * that matters on a phone at a venue: failure is a value the caller must
 * handle, and "the network dropped" is a different sentence from "the server
 * said no".
 *
 * `credentials: 'omit'`, not the default: the `/public` routes are authorised
 * by the `?t=` capability alone (docs/04 §Auth), and a coordinator filling in
 * their own form in the same browser must not have their session cookie ride
 * along on an unauthenticated route.
 */
import * as v from 'valibot';

const problemSchema = v.object({
  type: v.pipe(v.string(), v.minLength(1)),
  title: v.pipe(v.string(), v.minLength(1)),
  status: v.number(),
  detail: v.optional(v.string()),
  problems: v.optional(v.array(v.unknown())),
});

export type Problem = v.InferOutput<typeof problemSchema>;

export type Failure =
  | {
      readonly reason: 'rejected';
      readonly status: number;
      readonly problem: Problem | null;
    }
  | { readonly reason: 'unavailable' }
  | { readonly reason: 'malformed' };

export type ApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: Failure };

interface RequestOptions {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

async function send({
  method,
  path,
  body,
  signal,
}: RequestOptions): Promise<
  | { readonly ok: true; readonly response: Response }
  | { readonly ok: false; readonly failure: Failure }
> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      credentials: 'omit',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    return { ok: false, failure: { reason: 'unavailable' } };
  }
  if (response.ok) {
    return { ok: true, response };
  }
  // A proxy error page is not something the API said: without a conforming
  // problem document the status is all that is trustworthy.
  let problem: Problem | null = null;
  try {
    const parsed = v.safeParse(problemSchema, await response.json());
    problem = parsed.success ? parsed.output : null;
  } catch {
    problem = null;
  }
  if (problem === null && response.status >= 500) {
    return { ok: false, failure: { reason: 'unavailable' } };
  }
  return {
    ok: false,
    failure: { reason: 'rejected', status: response.status, problem },
  };
}

export async function request<TSchema extends v.GenericSchema>(
  options: RequestOptions,
  schema: TSchema,
): Promise<ApiResult<v.InferOutput<TSchema>>> {
  const sent = await send(options);
  if (!sent.ok) {
    return sent;
  }
  let body: unknown;
  try {
    body = await sent.response.json();
  } catch {
    return { ok: false, failure: { reason: 'malformed' } };
  }
  const parsed = v.safeParse(schema, body);
  return parsed.success
    ? { ok: true, value: parsed.output }
    : { ok: false, failure: { reason: 'malformed' } };
}

/** A write whose success (`202`) carries nothing the form needs. */
export async function requestAccepted(
  options: RequestOptions,
): Promise<
  { readonly ok: true } | { readonly ok: false; readonly failure: Failure }
> {
  const sent = await send(options);
  return sent.ok ? { ok: true } : sent;
}
