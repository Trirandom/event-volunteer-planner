// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * Events: the thing a coordinator actually staffs.
 *
 * An event may stand alone or belong to a festival (`festival_id`); the two
 * list endpoints and the one create endpoint share this module rather than
 * splitting "standalone" and "in a festival" into separate types, because the
 * server does not distinguish them either — `festival_id` is just `null` on
 * the wire, never a discriminant on a different resource.
 *
 * The org is a path segment on every call here, never inferred from the
 * session (docs/04 §1): a coordinator who is a member of two organisations
 * must say which one they mean, and a function signature that made `orgId`
 * optional would be the place that rule quietly stopped holding.
 */

import * as v from 'valibot';

import {
  request,
  requestNoContent,
  type ApiResult,
  type Failure,
} from './http';

const VALIDATION_FAILED = 'https://evp.example/errors/validation-failed';
const FORBIDDEN = 'https://evp.example/errors/forbidden';
const CONFLICT = 'https://evp.example/errors/conflict';

/**
 * A half-open UTC instant range, as every period on the wire is shaped
 * (docs/04 §1). `isoTimestamp` accepts the `Z`-suffixed RFC 3339 the API
 * sends; it does not by itself prove the zone is UTC, but a non-UTC offset
 * here would still be a valid instant, and `Temporal.Instant.from` downstream
 * is what actually resolves it — this schema's job is only to refuse a string
 * that is not a timestamp at all.
 */
const periodSchema = v.object({
  start: v.pipe(v.string(), v.isoTimestamp()),
  end: v.pipe(v.string(), v.isoTimestamp()),
});

export type Period = v.InferOutput<typeof periodSchema>;

/**
 * `status` is kept as a plain string, not a `picklist`, for the same reason
 * `session.ts` keeps `member_role` as one: the server decodes it as text, so a
 * status value added there must not turn every existing event into a parse
 * failure here before this file catches up.
 */
export const eventSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  festival_id: v.nullable(v.pipe(v.string(), v.minLength(1))),
  name: v.pipe(v.string(), v.minLength(1)),
  slug: v.pipe(v.string(), v.minLength(1)),
  timezone: v.pipe(v.string(), v.minLength(1)),
  /**
   * The **operational** window — everything the edition covers, including the
   * hours worked before the doors open and after they close. It is what every
   * shift must sit inside (docs/02 §5), and therefore what the mission board
   * widens when a bar is dragged past the end of the day.
   */
  period: periodSchema,
  /**
   * When the doors are open to the public, if anyone has said so. Omitted by
   * the server otherwise — which is why it is `optional` and not `nullable`,
   * and why "absent" must be read as "nobody has decided" rather than as "the
   * same as `period`". The two are different facts about the day.
   */
  public_period: v.optional(periodSchema),
  status: v.pipe(v.string(), v.minLength(1)),
  /**
   * Index into the 64-colour event palette (`@evp/shared`'s `eventColor`).
   * The server sends the index, never a hex: the palette is what proves the
   * colour clears 4.5:1 against black and white, so a colour that did not come
   * out of it would be a colour nobody checked.
   */
  color: v.pipe(v.number(), v.integer(), v.minValue(0)),
  created_at: v.pipe(v.string(), v.isoTimestamp()),
  updated_at: v.pipe(v.string(), v.isoTimestamp()),
  version: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

export type Event = v.InferOutput<typeof eventSchema>;

const listResponseSchema = v.object({
  data: v.array(eventSchema),
  next: v.nullable(v.string()),
});

const createEventResponseSchema = v.object({
  event: eventSchema,
  operation_id: v.pipe(v.string(), v.minLength(1)),
});

/** `GET /api/v1/orgs/{org}/events`, optionally narrowed by status or festival. */
export async function fetchEvents(
  orgId: string,
  options: {
    readonly status?: string;
    readonly festivalId?: string;
    readonly signal?: AbortSignal;
  } = {},
): Promise<ApiResult<readonly Event[]>> {
  const params = new URLSearchParams();
  if (options.status !== undefined) {
    params.set('status', options.status);
  }
  if (options.festivalId !== undefined) {
    params.set('festival', options.festivalId);
  }
  const query = params.size > 0 ? `?${params.toString()}` : '';

  const result = await request(
    {
      method: 'GET',
      path: `/api/v1/orgs/${encodeURIComponent(orgId)}/events${query}`,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
    listResponseSchema,
  );

  return result.ok ? { ok: true, value: result.value.data } : result;
}

/** `GET /api/v1/orgs/{org}/events/{event}`. */
export async function fetchEvent(
  orgId: string,
  eventId: string,
  signal?: AbortSignal,
): Promise<ApiResult<Event>> {
  return request(
    {
      method: 'GET',
      path: `/api/v1/orgs/${encodeURIComponent(orgId)}/events/${encodeURIComponent(eventId)}`,
      ...(signal === undefined ? {} : { signal }),
    },
    eventSchema,
  );
}

export interface CreateEventInput {
  readonly name: string;
  readonly slug: string;
  readonly timezone: string;
  readonly period: Period;
  /** Omitted, not `undefined`-valued, to keep the event standalone. */
  readonly festivalId?: string;
}

/** Why `POST /events` did not create the event. */
export type CreateEventRejection =
  | { readonly reason: 'validation-failed'; readonly detail: string }
  | { readonly reason: 'forbidden'; readonly detail: string }
  | { readonly reason: 'refused'; readonly detail: string }
  | { readonly reason: 'unavailable' };

export type CreateEventResult =
  | {
      readonly ok: true;
      readonly event: Event;
      readonly operationId: string;
    }
  | { readonly ok: false; readonly rejection: CreateEventRejection };

/**
 * `POST /api/v1/orgs/{org}/events`.
 *
 * `festivalId` is spread in only when present: under `exactOptionalProperty
 * Types`, sending `festival_id: undefined` is a different body from omitting
 * the key, and the server's "standalone" reading of the field is "the key is
 * absent", not "the key is null".
 */
export async function createEvent(
  orgId: string,
  input: CreateEventInput,
): Promise<CreateEventResult> {
  const result = await request(
    {
      method: 'POST',
      path: `/api/v1/orgs/${encodeURIComponent(orgId)}/events`,
      body: {
        name: input.name,
        slug: input.slug,
        timezone: input.timezone,
        period: input.period,
        ...(input.festivalId === undefined
          ? {}
          : { festival_id: input.festivalId }),
      },
    },
    createEventResponseSchema,
  );

  return result.ok
    ? {
        ok: true,
        event: result.value.event,
        operationId: result.value.operation_id,
      }
    : { ok: false, rejection: createRejectionFor(result.failure) };
}

function createRejectionFor(failure: Failure): CreateEventRejection {
  if (failure.reason !== 'rejected') {
    return { reason: 'unavailable' };
  }

  const { problem } = failure;
  const detail = problem.detail ?? problem.title;

  if (problem.type === VALIDATION_FAILED) {
    return { reason: 'validation-failed', detail };
  }
  if (problem.type === FORBIDDEN) {
    return { reason: 'forbidden', detail };
  }
  return { reason: 'refused', detail };
}

/** Why `POST /events/example` did not load the worked example. */
export type LoadExampleEventRejection =
  /** The org already has at least one event — docs/04 contract for this route. */
  | { readonly reason: 'conflict'; readonly detail: string }
  | { readonly reason: 'forbidden'; readonly detail: string }
  | { readonly reason: 'refused'; readonly detail: string }
  | { readonly reason: 'unavailable' };

export type LoadExampleEventResult =
  | {
      readonly ok: true;
      readonly event: Event;
      readonly operationId: string;
    }
  | { readonly ok: false; readonly rejection: LoadExampleEventRejection };

/** `POST /api/v1/orgs/{org}/events/example`. */
export async function loadExampleEvent(
  orgId: string,
): Promise<LoadExampleEventResult> {
  const result = await request(
    {
      method: 'POST',
      path: `/api/v1/orgs/${encodeURIComponent(orgId)}/events/example`,
    },
    createEventResponseSchema,
  );

  return result.ok
    ? {
        ok: true,
        event: result.value.event,
        operationId: result.value.operation_id,
      }
    : { ok: false, rejection: exampleRejectionFor(result.failure) };
}

/**
 * `PATCH …/events/{event}` — the period only.
 *
 * Narrow for the same reason `patchShiftPeriod` is: `PatchEventRequest` also
 * carries the name, the slug, two tri-state fields and the colour, and a
 * general-purpose patcher here would make it easy to send `festival_id: null`
 * while meaning "leave it alone". The board moves one boundary.
 *
 * Widening no longer has a side effect: the doors used to be filled in from
 * whatever the period had been the first time it grew, and that guess is gone
 * (`board/edit.ts`). A drag moves the operational window and nothing else.
 */
export async function patchEventPeriod(
  orgId: string,
  eventId: string,
  version: number,
  period: Period,
): Promise<PatchEventResult> {
  const result = await request(
    {
      method: 'PATCH',
      path: `/api/v1/orgs/${encodeURIComponent(orgId)}/events/${encodeURIComponent(eventId)}`,
      body: { period },
      ifMatchVersion: version,
    },
    updateEventResponseSchema,
  );

  return result.ok
    ? { ok: true, event: result.value.event }
    : { ok: false, rejection: patchRejectionFor(result.failure) };
}

const updateEventResponseSchema = v.object({
  event: eventSchema,
  operation_id: v.pipe(v.string(), v.minLength(1)),
});

/** Why a period patch did not happen. Shaped like `shifts.ts`'s rejection so
 * the board can report one plan's refusals through one path. */
export type PatchEventRejection =
  | { readonly reason: 'conflict'; readonly detail: string }
  | { readonly reason: 'validation-failed'; readonly detail: string }
  | { readonly reason: 'forbidden'; readonly detail: string }
  | { readonly reason: 'refused'; readonly detail: string }
  | { readonly reason: 'unavailable' };

export type PatchEventResult =
  | { readonly ok: true; readonly event: Event }
  | { readonly ok: false; readonly rejection: PatchEventRejection };

const PRECONDITION_REQUIRED =
  'https://evp.example/errors/precondition-required';

function patchRejectionFor(failure: Failure): PatchEventRejection {
  if (failure.reason !== 'rejected') {
    return { reason: 'unavailable' };
  }

  const { problem } = failure;
  const detail = problem.detail ?? problem.title;

  if (problem.type === CONFLICT || problem.type === PRECONDITION_REQUIRED) {
    return { reason: 'conflict', detail };
  }
  if (problem.type === VALIDATION_FAILED) {
    return { reason: 'validation-failed', detail };
  }
  if (problem.type === FORBIDDEN) {
    return { reason: 'forbidden', detail };
  }
  return { reason: 'refused', detail };
}

function exampleRejectionFor(failure: Failure): LoadExampleEventRejection {
  if (failure.reason !== 'rejected') {
    return { reason: 'unavailable' };
  }

  const { problem } = failure;
  const detail = problem.detail ?? problem.title;

  if (problem.type === CONFLICT) {
    return { reason: 'conflict', detail };
  }
  if (problem.type === FORBIDDEN) {
    return { reason: 'forbidden', detail };
  }
  return { reason: 'refused', detail };
}

/**
 * What the event details form can change.
 *
 * A separate input type from `patchEventPeriod`'s single period, and
 * deliberately not a `Partial<Event>`: every field here is one somebody typed
 * into a form that shows all of them at once, so "absent" means the form does
 * not offer it rather than "the coordinator left it alone". The one field with
 * three states is the one the server treats as tri-state too.
 */
export interface EventDetailsInput {
  readonly period?: Period;
  /**
   * `null` publishes no door times, a period sets them, and omitting the key
   * leaves whatever is stored. The middle case is the reason this is not just
   * `Period | undefined`: under `exactOptionalPropertyTypes` those are three
   * distinct values here, and they are three distinct bodies on the wire.
   */
  readonly publicPeriod?: Period | null;
  /** Palette index; see `eventSchema.color`. */
  readonly color?: number;
}

/**
 * `PATCH …/events/{event}` from the details form.
 *
 * The body is assembled key by key rather than spread from the input, because
 * `JSON.stringify` drops `undefined` values silently and that is exactly the
 * mistake this endpoint punishes: a dropped `public_period` leaves the doors
 * alone, which is right, while a dropped one that was meant to be `null`
 * leaves them set, which is the coordinator's edit quietly not happening.
 */
export async function patchEventDetails(
  orgId: string,
  eventId: string,
  version: number,
  input: EventDetailsInput,
): Promise<PatchEventResult> {
  const body: Record<string, unknown> = {};
  if (input.period !== undefined) {
    body['period'] = input.period;
  }
  if (input.publicPeriod !== undefined) {
    body['public_period'] = input.publicPeriod;
  }
  if (input.color !== undefined) {
    body['color'] = input.color;
  }

  const result = await request(
    {
      method: 'PATCH',
      path: `/api/v1/orgs/${encodeURIComponent(orgId)}/events/${encodeURIComponent(eventId)}`,
      body,
      ifMatchVersion: version,
    },
    updateEventResponseSchema,
  );

  return result.ok
    ? { ok: true, event: result.value.event }
    : { ok: false, rejection: patchRejectionFor(result.failure) };
}

/**
 * `DELETE …/events/{event}` — owner only, and `204` on success.
 *
 * Reuses `PatchEventRejection` rather than growing a near-identical twin: the
 * four ways this can be refused are the four ways a patch can be, and a
 * `forbidden` here has the specific meaning "you are a coordinator, not an
 * owner" that the server's own detail already spells out.
 */
export async function deleteEvent(
  orgId: string,
  eventId: string,
  version: number,
): Promise<
  | { readonly ok: true }
  | { readonly ok: false; readonly rejection: PatchEventRejection }
> {
  const result = await requestNoContent({
    method: 'DELETE',
    path: `/api/v1/orgs/${encodeURIComponent(orgId)}/events/${encodeURIComponent(eventId)}`,
    ifMatchVersion: version,
  });

  return result.ok
    ? { ok: true }
    : { ok: false, rejection: patchRejectionFor(result.failure) };
}
