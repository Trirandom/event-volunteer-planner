// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The deployment operator's surface: organisations, accounts, memberships,
 * across every tenant (ADR-0045, docs/04 §Backoffice).
 *
 * Every call takes the key as an argument rather than reading it from
 * `backoffice/key.ts` itself, so this module stays a plain function of its
 * inputs — testable without a store, and unable to send a key nobody passed.
 * `http.ts` sends it as a bearer and leaves the session cookie behind.
 *
 * None of these writes returns an `operation_id`: there is no user to own an
 * undo stack (ADR-0045), so unlike every member route there is nothing to
 * parse or hand on.
 */
import * as v from 'valibot';

import {
  request,
  requestNoContent,
  type ApiOutcome,
  type ApiResult,
  type Failure,
} from './http';

const UNAUTHENTICATED = 'https://evp.example/errors/unauthenticated';
const NOT_FOUND = 'https://evp.example/errors/not-found';
const CONFLICT = 'https://evp.example/errors/conflict';
const VALIDATION_FAILED = 'https://evp.example/errors/validation-failed';
const RATE_LIMITED = 'https://evp.example/errors/rate-limited';

const BASE = '/api/v1/backoffice';

/** `member_role`, in the order a picker offers them. */
export const MEMBER_ROLES = ['owner', 'coordinator', 'zone_lead'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** What the interface preselects when assigning (ADR-0045): most people an
 * operator adds are running a festival, not owning the organisation. */
export const DEFAULT_MEMBER_ROLE: MemberRole = 'coordinator';

/** What the server applies when `timezone` is omitted, shown in the form so
 * the operator sees the value rather than having to know the default. */
export const DEFAULT_ORGANIZATION_TIMEZONE = 'Europe/Paris';

const roleSchema = v.picklist(MEMBER_ROLES);
const timestampSchema = v.pipe(v.string(), v.isoTimestamp());
const idSchema = v.pipe(v.string(), v.minLength(1));

export const organizationSchema = v.object({
  id: idSchema,
  slug: v.pipe(v.string(), v.minLength(1)),
  name: v.pipe(v.string(), v.minLength(1)),
  timezone: v.pipe(v.string(), v.minLength(1)),
  created_at: timestampSchema,
  member_count: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
export type Organization = v.InferOutput<typeof organizationSchema>;

export const memberSchema = v.object({
  user_id: idSchema,
  email: v.pipe(v.string(), v.minLength(1)),
  display_name: v.string(),
  role: roleSchema,
  created_at: timestampSchema,
});
export type Member = v.InferOutput<typeof memberSchema>;

export const userSchema = v.object({
  id: idSchema,
  email: v.pipe(v.string(), v.minLength(1)),
  display_name: v.string(),
  created_at: timestampSchema,
  last_login_at: v.nullable(timestampSchema),
  memberships: v.array(
    v.object({
      org_id: idSchema,
      slug: v.string(),
      name: v.string(),
      role: roleSchema,
    }),
  ),
});
export type BackofficeUser = v.InferOutput<typeof userSchema>;

/** `{ data, next: null }`: the cursor is part of the envelope every list
 * shares (docs/04), always null here. Not checked to be null — a future
 * page would be a contract change this client should notice by lacking
 * rows, not by refusing to show the ones it has. */
function listOf<TItem extends v.GenericSchema>(item: TItem) {
  return v.object({ data: v.array(item), next: v.nullable(v.string()) });
}

/**
 * Why a backoffice call did not produce a value.
 *
 * `disabled` and `not-found` are the same `404` on the wire, told apart by
 * which route answered: on a route that names nothing it can only mean the
 * deployment has no `EVP_BACKOFFICE_KEY` (ADR-0045 "Off means absent"); on
 * one naming an organisation or a user, it means that row is not there.
 */
export type BackofficeRejection =
  | { readonly reason: 'bad-key' }
  | { readonly reason: 'disabled' }
  | { readonly reason: 'not-found'; readonly detail: string }
  | { readonly reason: 'conflict'; readonly detail: string }
  | { readonly reason: 'validation-failed'; readonly detail: string }
  | { readonly reason: 'rate-limited' }
  | { readonly reason: 'refused'; readonly detail: string }
  | { readonly reason: 'unavailable' };

export type BackofficeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly rejection: BackofficeRejection };

/** Whether a `404` here means "switched off" or "no such row". */
type NotFoundMeans = 'disabled' | 'not-found';

function rejectionFor(
  failure: Failure,
  notFound: NotFoundMeans,
): BackofficeRejection {
  if (failure.reason === 'unavailable') {
    // A route that is not mounted answers with the router's bare 404, no
    // envelope — that is what "indistinguishable from a path that does not
    // exist" amounts to, so it has to be read off the status.
    return failure.status === 404 && notFound === 'disabled'
      ? { reason: 'disabled' }
      : { reason: 'unavailable' };
  }
  if (failure.reason === 'malformed') {
    return { reason: 'unavailable' };
  }

  const { problem } = failure;
  const detail = problem.detail ?? problem.title;

  if (problem.type === UNAUTHENTICATED || problem.status === 401) {
    return { reason: 'bad-key' };
  }
  if (problem.type === NOT_FOUND || problem.status === 404) {
    return notFound === 'disabled'
      ? { reason: 'disabled' }
      : { reason: 'not-found', detail };
  }
  if (problem.type === CONFLICT) {
    return { reason: 'conflict', detail };
  }
  if (problem.type === VALIDATION_FAILED) {
    return { reason: 'validation-failed', detail };
  }
  if (problem.type === RATE_LIMITED) {
    return { reason: 'rate-limited' };
  }
  return { reason: 'refused', detail };
}

function settle<T>(
  result: ApiResult<T>,
  notFound: NotFoundMeans,
): BackofficeResult<T> {
  return result.ok
    ? result
    : { ok: false, rejection: rejectionFor(result.failure, notFound) };
}

/** A list's rows, out of their `{ data, next }` envelope. */
function dataOf<T>(
  result: ApiResult<{ readonly data: T; readonly next: string | null }>,
): ApiResult<T> {
  return result.ok ? { ok: true, value: result.value.data } : result;
}

function settleNoContent(
  outcome: ApiOutcome,
  notFound: NotFoundMeans,
): BackofficeResult<null> {
  return outcome.ok
    ? { ok: true, value: null }
    : { ok: false, rejection: rejectionFor(outcome.failure, notFound) };
}

function memberPath(orgId: string, userId?: string): string {
  const members = `${BASE}/organizations/${encodeURIComponent(orgId)}/members`;
  return userId === undefined
    ? members
    : `${members}/${encodeURIComponent(userId)}`;
}

/** `GET /backoffice/organizations`, ordered by name. */
export async function listOrganizations(
  key: string,
  signal?: AbortSignal,
): Promise<BackofficeResult<readonly Organization[]>> {
  const result = await request(
    {
      method: 'GET',
      path: `${BASE}/organizations`,
      bearer: key,
      ...(signal === undefined ? {} : { signal }),
    },
    listOf(organizationSchema),
  );
  return settle(dataOf(result), 'disabled');
}

export interface CreateOrganizationInput {
  readonly name: string;
  readonly slug: string;
  /** Omitted means the server's default, `Europe/Paris`. */
  readonly timezone?: string;
}

/** `POST /backoffice/organizations`. */
export async function createOrganization(
  key: string,
  input: CreateOrganizationInput,
): Promise<BackofficeResult<Organization>> {
  const result = await request(
    {
      method: 'POST',
      path: `${BASE}/organizations`,
      bearer: key,
      body: {
        name: input.name,
        slug: input.slug,
        ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
      },
    },
    organizationSchema,
  );
  return settle(result, 'disabled');
}

/** `GET /backoffice/organizations/{org}/members`. */
export async function listMembers(
  key: string,
  orgId: string,
  signal?: AbortSignal,
): Promise<BackofficeResult<readonly Member[]>> {
  const result = await request(
    {
      method: 'GET',
      path: memberPath(orgId),
      bearer: key,
      ...(signal === undefined ? {} : { signal }),
    },
    listOf(memberSchema),
  );
  return settle(dataOf(result), 'not-found');
}

/** `PUT /backoffice/organizations/{org}/members/{user}` — adds the
 * membership or changes its role; the same call either way. */
export async function assignMember(
  key: string,
  orgId: string,
  userId: string,
  role: MemberRole,
): Promise<BackofficeResult<Member>> {
  const result = await request(
    {
      method: 'PUT',
      path: memberPath(orgId, userId),
      bearer: key,
      body: { role },
    },
    memberSchema,
  );
  return settle(result, 'not-found');
}

/** `DELETE /backoffice/organizations/{org}/members/{user}`. */
export async function removeMember(
  key: string,
  orgId: string,
  userId: string,
): Promise<BackofficeResult<null>> {
  const outcome = await requestNoContent({
    method: 'DELETE',
    path: memberPath(orgId, userId),
    bearer: key,
  });
  return settleNoContent(outcome, 'not-found');
}

/** `GET /backoffice/users`, ordered by e-mail. */
export async function listUsers(
  key: string,
  signal?: AbortSignal,
): Promise<BackofficeResult<readonly BackofficeUser[]>> {
  const result = await request(
    {
      method: 'GET',
      path: `${BASE}/users`,
      bearer: key,
      ...(signal === undefined ? {} : { signal }),
    },
    listOf(userSchema),
  );
  return settle(dataOf(result), 'disabled');
}

export interface CreateUserInput {
  readonly email: string;
  readonly displayName: string;
  readonly password: string;
}

/** `POST /backoffice/users`. */
export async function createUser(
  key: string,
  input: CreateUserInput,
): Promise<BackofficeResult<BackofficeUser>> {
  const result = await request(
    {
      method: 'POST',
      path: `${BASE}/users`,
      bearer: key,
      body: {
        email: input.email,
        display_name: input.displayName,
        password: input.password,
      },
    },
    userSchema,
  );
  return settle(result, 'disabled');
}
