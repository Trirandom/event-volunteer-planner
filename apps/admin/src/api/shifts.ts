// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * Shifts: the bookable slots a coordinator cuts a mission into
 * (docs/04 §"Events, locations, shifts").
 *
 * Read *and* write. The board edits shifts directly — a bar is a reading of
 * these rows and nothing else stands behind it (ADR-0029) — so the four verbs
 * `evp-api` already serves are all wired here.
 *
 * Every write carries `If-Match`. That is not belt-and-braces: `evp-api`'s
 * `Precondition` extractor answers a write without one with `428`, and two
 * coordinators editing the same festival at once is the normal case this
 * project exists to support (docs/02 §7).
 */

import * as v from 'valibot';

import {
  request,
  requestNoContent,
  requestVersioned,
  type ApiOutcome,
  type ApiResult,
  type Failure,
} from './http';

const VALIDATION_FAILED = 'https://evp.example/errors/validation-failed';
const FORBIDDEN = 'https://evp.example/errors/forbidden';
const CONFLICT = 'https://evp.example/errors/conflict';
const PRECONDITION_REQUIRED =
  'https://evp.example/errors/precondition-required';

const periodSchema = v.object({
  start: v.pipe(v.string(), v.isoTimestamp()),
  end: v.pipe(v.string(), v.isoTimestamp()),
});

export type Period = v.InferOutput<typeof periodSchema>;

export const shiftSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  event_id: v.pipe(v.string(), v.minLength(1)),
  location_id: v.pipe(v.string(), v.minLength(1)),
  /** Absent means "inherit the location name" (docs/03 §3.4) — see
   * `evp-api`'s own `ShiftResponse` doc comment. */
  title: v.optional(v.string()),
  period: periodSchema,
  required_count: v.pipe(v.number(), v.integer()),
  max_count: v.optional(v.pipe(v.number(), v.integer())),
  notes: v.optional(v.string()),
  created_at: v.pipe(v.string(), v.isoTimestamp()),
  updated_at: v.pipe(v.string(), v.isoTimestamp()),
  version: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

export type Shift = v.InferOutput<typeof shiftSchema>;

const listResponseSchema = v.object({
  data: v.array(shiftSchema),
  next: v.nullable(v.string()),
});

/** `GET /api/v1/orgs/{org}/events/{event}/shifts`, unfiltered — the missions
 * page shows everything the event has, not a window of it. */
export async function fetchShifts(
  orgId: string,
  eventId: string,
  signal?: AbortSignal,
): Promise<ApiResult<readonly Shift[]>> {
  const result = await request(
    {
      method: 'GET',
      path: `/api/v1/orgs/${encodeURIComponent(orgId)}/events/${encodeURIComponent(eventId)}/shifts`,
      ...(signal === undefined ? {} : { signal }),
    },
    listResponseSchema,
  );

  return result.ok ? { ok: true, value: result.value.data } : result;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

const writtenSchema = v.object({
  shift: shiftSchema,
  operation_id: v.pipe(v.string(), v.minLength(1)),
});

/** Why a shift write did not happen. */
export type ShiftWriteRejection =
  /**
   * Somebody else changed this shift since the board read it. docs/02 §7 makes
   * this a visible "someone else changed this" and a refetch, never a retry:
   * re-sending the same edit against a row we have not seen is the lost update
   * the precondition exists to prevent.
   */
  | { readonly reason: 'conflict'; readonly detail: string }
  /** A hard rule refused it — outside the event, longer than a day, or a
   * headcount that does not add up. The detail names which (docs/02 §5). */
  | { readonly reason: 'validation-failed'; readonly detail: string }
  | { readonly reason: 'forbidden'; readonly detail: string }
  | { readonly reason: 'refused'; readonly detail: string }
  | { readonly reason: 'unavailable' };

function rejectionFor(failure: Failure): ShiftWriteRejection {
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

export type ShiftWriteResult =
  | { readonly ok: true; readonly shift: Shift; readonly operationId: string }
  | { readonly ok: false; readonly rejection: ShiftWriteRejection };

function shiftsPath(orgId: string, eventId: string): string {
  return `/api/v1/orgs/${encodeURIComponent(orgId)}/events/${encodeURIComponent(eventId)}/shifts`;
}

export interface NewShift {
  readonly locationId: string;
  readonly period: Period;
  readonly requiredCount: number;
}

/** `POST …/shifts`. */
export async function createShift(
  orgId: string,
  eventId: string,
  input: NewShift,
): Promise<ShiftWriteResult> {
  const result = await requestVersioned(
    {
      method: 'POST',
      path: shiftsPath(orgId, eventId),
      body: {
        location_id: input.locationId,
        period: input.period,
        required_count: input.requiredCount,
      },
    },
    writtenSchema,
  );

  return result.ok
    ? {
        ok: true,
        shift: result.value.value.shift,
        operationId: result.value.value.operation_id,
      }
    : { ok: false, rejection: rejectionFor(result.failure) };
}

/**
 * `PATCH …/shifts/{id}` — the period only.
 *
 * Narrow on purpose. `PatchShiftRequest` also carries `title`, `notes` and the
 * headcounts as tri-state fields, and a general-purpose patcher here would
 * make it easy to send `title: null` while meaning "leave it alone". The board
 * moves edges; when a roster editor needs the other fields it can say so.
 */
export async function patchShiftPeriod(
  orgId: string,
  eventId: string,
  shiftId: string,
  version: number,
  period: Period,
): Promise<ShiftWriteResult> {
  const result = await requestVersioned(
    {
      method: 'PATCH',
      path: `${shiftsPath(orgId, eventId)}/${encodeURIComponent(shiftId)}`,
      body: { period },
      ifMatchVersion: version,
    },
    writtenSchema,
  );

  return result.ok
    ? {
        ok: true,
        shift: result.value.value.shift,
        operationId: result.value.value.operation_id,
      }
    : { ok: false, rejection: rejectionFor(result.failure) };
}

export type ShiftDeleteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly rejection: ShiftWriteRejection };

/** `DELETE …/shifts/{id}` — a 204, so there is no body to read. */
export async function deleteShift(
  orgId: string,
  eventId: string,
  shiftId: string,
  version: number,
): Promise<ShiftDeleteResult> {
  const outcome: ApiOutcome = await requestNoContent({
    method: 'DELETE',
    path: `${shiftsPath(orgId, eventId)}/${encodeURIComponent(shiftId)}`,
    ifMatchVersion: version,
  });

  return outcome.ok
    ? { ok: true }
    : { ok: false, rejection: rejectionFor(outcome.failure) };
}
