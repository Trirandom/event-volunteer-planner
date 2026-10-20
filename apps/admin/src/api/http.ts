// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The one place this application talks to the API.
 *
 * Three things are settled here rather than at each call site.
 *
 * **Same origin, always.** Caddy fronts both the bundles and the API, so the
 * browser sees one origin and the session cookie behaves in development
 * exactly as it does in production (docs/06 §1). There is no `VITE_API_URL`
 * and there must not be one: a configurable base would buy nothing and
 * introduce CORS.
 *
 * **Failure is a value, not an exception.** Every call returns a union the
 * caller must destructure, so "what does the user see when this fails?" is
 * answered by the type rather than by remembering to write a `catch`. The
 * three failure reasons are genuinely different situations and get different
 * copy: the server refused and said why, the server could not be reached at
 * all, or the server answered 2xx with a body that is not what the contract
 * says.
 *
 * **Bodies are parsed, not asserted.** Same reasoning as
 * `@evp/shared`'s `meta.ts`: once `@evp/api-client` is generated its types are
 * compile-time only and give no runtime guarantee (docs/11 §3). The valibot
 * schema is the boundary and stays after the client lands.
 */

import * as v from 'valibot';

/**
 * RFC 9457 `application/problem+json`, as `evp-api`'s `error.rs` emits it.
 *
 * `type` is the field to branch on. `title` and `detail` are prose and may be
 * reworded or translated, which is exactly what makes them unsafe to compare
 * against — docs/04 §Error format says so, and this schema is where that rule
 * becomes enforceable.
 */
const problemSchema = v.object({
  type: v.pipe(v.string(), v.minLength(1)),
  title: v.pipe(v.string(), v.minLength(1)),
  status: v.number(),
  detail: v.optional(v.string()),
  /**
   * The form endpoints' extension member: each thing a `PUT` or a publish
   * refused, with the question it concerns (docs/04 §"The volunteer form").
   * Carried here unparsed rather than typed, because the envelope is one
   * schema for every endpoint and an item's shape belongs to the resource
   * that defines it — `forms.ts` parses the items. Without this entry valibot
   * would strip the member and the only thing left of a refused publish would
   * be its title.
   */
  problems: v.optional(v.array(v.unknown())),
});

export type Problem = v.InferOutput<typeof problemSchema>;

/** Why a call did not produce a value. */
export type Failure =
  /** The server refused, in the documented envelope. `problem.type` says why. */
  | { readonly reason: 'rejected'; readonly problem: Problem }
  /**
   * Nothing usable came back: the network is down, the proxy answered with its
   * own error page, or the body was not the documented envelope. One reason
   * for all three because the user can do exactly one thing about them.
   *
   * `status` is set when a response did arrive, for the one caller that has
   * to read it: an unconfigured backoffice answers like a path that does not
   * exist (ADR-0045), which is a bare `404` from the router rather than an
   * envelope, and "switched off" is not something to tell the operator as
   * "the server is unreachable".
   */
  | { readonly reason: 'unavailable'; readonly status?: number }
  /** 2xx with a body that does not match the schema — a contract break. */
  | { readonly reason: 'malformed' };

export type ApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: Failure };

/** A 2xx with no body to parse, as `POST /auth/logout` answers. */
export type ApiOutcome =
  { readonly ok: true } | { readonly ok: false; readonly failure: Failure };

interface RequestOptions {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  /**
   * The row version this write is asserting against, sent as `If-Match`.
   *
   * A *version*, not a formatted entity-tag, so the quoting `evp-api` mints
   * (`extract.rs`'s `etag`) is applied in exactly one place and a caller
   * cannot send `W/"3"` or a bare `3` — both of which that API treats as a
   * tag it did not issue, and answers with the same `409` a stale one gets.
   *
   * Omitting it on a write is not a shortcut: `Precondition` refuses a
   * request with no readable `If-Match` outright (`428`), which is docs/02 §7
   * — a lost update has to be impossible, not unlikely.
   */
  readonly ifMatchVersion?: number;
  /**
   * A bearer credential to present instead of the session cookie — the
   * backoffice key (ADR-0045), today the only one.
   *
   * Instead of, not as well as: such a call goes out with `credentials:
   * 'omit'`. The backoffice's authority is the key alone, and a request that
   * also carried a coordinator's cookie would be one where a server-side
   * slip could let the session stand in for the key. Not sending it makes
   * that impossible from this side.
   */
  readonly bearer?: string;
}

/** The `ETag` a write answered with, as a version. `null` when the response
 * carried none or carried one this client did not mint. */
function versionOf(response: Response): number | null {
  const raw = response.headers.get('etag');
  if (raw === null) {
    return null;
  }
  const inner = /^"(\d+)"$/u.exec(raw)?.[1];
  return inner === undefined ? null : Number.parseInt(inner, 10);
}

/**
 * Perform the call and classify the outcome, without looking at the body.
 *
 * Split out so that `request` and `requestNoContent` cannot drift into
 * classifying the same HTTP response differently.
 */
async function send({
  method,
  path,
  body,
  signal,
  ifMatchVersion,
  bearer,
}: RequestOptions): Promise<
  | { readonly ok: true; readonly response: Response }
  | { readonly ok: false; readonly failure: Failure }
> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (ifMatchVersion !== undefined) {
    headers['if-match'] = `"${String(ifMatchVersion)}"`;
  }
  if (bearer !== undefined) {
    headers['authorization'] = `Bearer ${bearer}`;
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      // The session cookie is `HttpOnly` and same-origin; `same-origin` is
      // already the default, and it is written out because this is the line
      // that makes the whole session model work. A bearer call omits it; see
      // `RequestOptions.bearer`.
      credentials: bearer === undefined ? 'same-origin' : 'omit',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    return { ok: false, failure: { reason: 'unavailable' } };
  }

  if (response.ok) {
    return { ok: true, response };
  }

  return { ok: false, failure: await readProblem(response) };
}

/**
 * A non-2xx response, turned into a `Failure`.
 *
 * A body that is not a conforming problem document is treated as
 * `unavailable` rather than invented into one: a Caddy 502 page and a
 * truncated response are not things the API said, and rendering a made-up
 * title as though the server had sent it is worse than admitting we have
 * nothing.
 */
async function readProblem(response: Response): Promise<Failure> {
  const { status } = response;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { reason: 'unavailable', status };
  }

  const parsed = v.safeParse(problemSchema, body);
  return parsed.success
    ? { reason: 'rejected', problem: parsed.output }
    : { reason: 'unavailable', status };
}

/** A call whose success carries a body, parsed against `schema`. */
export async function request<TSchema extends v.GenericSchema>(
  options: RequestOptions,
  schema: TSchema,
): Promise<ApiResult<v.InferOutput<TSchema>>> {
  const sent = await send(options);
  if (!sent.ok) {
    return { ok: false, failure: sent.failure };
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

/** A call whose success carries nothing, such as a 204. */
export async function requestNoContent(
  options: RequestOptions,
): Promise<ApiOutcome> {
  const sent = await send(options);
  return sent.ok ? { ok: true } : { ok: false, failure: sent.failure };
}

/**
 * A write whose success carries both a body and a fresh `ETag`.
 *
 * The version is read from the header rather than from the body so that one
 * write can be followed immediately by another without a refetch in between
 * — which is exactly what the board does when a drag plans four operations
 * against the same row.
 */
export async function requestVersioned<TSchema extends v.GenericSchema>(
  options: RequestOptions,
  schema: TSchema,
): Promise<
  ApiResult<{
    readonly value: v.InferOutput<TSchema>;
    readonly version: number | null;
  }>
> {
  const sent = await send(options);
  if (!sent.ok) {
    return { ok: false, failure: sent.failure };
  }

  let body: unknown;
  try {
    body = await sent.response.json();
  } catch {
    return { ok: false, failure: { reason: 'malformed' } };
  }

  const parsed = v.safeParse(schema, body);
  return parsed.success
    ? {
        ok: true,
        value: { value: parsed.output, version: versionOf(sent.response) },
      }
    : { ok: false, failure: { reason: 'malformed' } };
}
