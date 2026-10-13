// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The roster: which volunteer is on which shift (docs/04 §"Assignments").
 *
 * Read and write, and the write half is deliberately small — put somebody on
 * a shift, take them off. `PATCH` (a move), `/check`, and the three bulk
 * routes are not served by `evp-api` yet, so there is nothing here that
 * pretends they are.
 *
 * **A refusal is the normal case, not an error.** Three hard rules guard this
 * table in PostgreSQL and the most common one — that volunteer is already
 * working then — is a thing a coordinator does several times an hour on a
 * real plan. So the rejection is a value with its own sentence, the way
 * `shifts.ts` treats its own refusals, and the board renders it beside the
 * slot rather than throwing.
 *
 * The cancellation carries `If-Match` like every other write on a versioned
 * row: two coordinators staffing one festival at once is the case this
 * project exists for, and a cancellation sent against a placement somebody
 * else has already replaced must be refused rather than applied to whatever
 * is there now (docs/02 §7).
 */

import * as v from 'valibot';

import {
  request,
  requestNoContent,
  requestVersioned,
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

export const assignmentSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  event_id: v.pipe(v.string(), v.minLength(1)),
  shift_id: v.pipe(v.string(), v.minLength(1)),
  participation_id: v.pipe(v.string(), v.minLength(1)),
  volunteer_id: v.pipe(v.string(), v.minLength(1)),
  /** The shift's own hours, copied onto the row so the database can refuse a
   * double-booking without a join (docs/03 §3.6). */
  period: periodSchema,
  status: v.picklist(['draft', 'published']),
  assigned_at: v.pipe(v.string(), v.isoTimestamp()),
  version: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

export type Assignment = v.InferOutput<typeof assignmentSchema>;

const listResponseSchema = v.object({
  data: v.array(assignmentSchema),
  next: v.nullable(v.string()),
});

function assignmentsPath(orgId: string, eventId: string): string {
  return `/api/v1/orgs/${encodeURIComponent(orgId)}/events/${encodeURIComponent(eventId)}/assignments`;
}

/** `GET …/assignments` — the live roster. Cancelled placements are not in it:
 * the server keeps them as history and leaves them out of this answer. */
export async function fetchAssignments(
  orgId: string,
  eventId: string,
  signal?: AbortSignal,
): Promise<ApiResult<readonly Assignment[]>> {
  const result = await request(
    {
      method: 'GET',
      path: assignmentsPath(orgId, eventId),
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
  assignment: assignmentSchema,
  operation_id: v.pipe(v.string(), v.minLength(1)),
});

/** Why a placement did not happen. */
export type AssignmentRejection =
  /**
   * A hard rule refused it: already working then, withdrawn, or enrolled on
   * another day. The detail is the server's sentence and names the remedy —
   * rendered verbatim rather than mapped to a code, because the three cases
   * have three different fixes and the server is the one that knows which.
   */
  | { readonly reason: 'validation-failed'; readonly detail: string }
  /** Somebody else changed this placement since the board read it. */
  | { readonly reason: 'conflict'; readonly detail: string }
  | { readonly reason: 'forbidden'; readonly detail: string }
  | { readonly reason: 'refused'; readonly detail: string }
  | { readonly reason: 'unavailable' };

function rejectionFor(failure: Failure): AssignmentRejection {
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

export type AssignResult =
  | {
      readonly ok: true;
      readonly assignment: Assignment;
      readonly operationId: string;
    }
  | { readonly ok: false; readonly rejection: AssignmentRejection };

/** `POST …/assignments` — put one volunteer on one shift. */
export async function createAssignment(
  orgId: string,
  eventId: string,
  input: { readonly shiftId: string; readonly participationId: string },
): Promise<AssignResult> {
  const result = await requestVersioned(
    {
      method: 'POST',
      path: assignmentsPath(orgId, eventId),
      body: {
        shift_id: input.shiftId,
        participation_id: input.participationId,
      },
    },
    writtenSchema,
  );

  return result.ok
    ? {
        ok: true,
        assignment: result.value.value.assignment,
        operationId: result.value.value.operation_id,
      }
    : { ok: false, rejection: rejectionFor(result.failure) };
}

export type CancelResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly rejection: AssignmentRejection };

/**
 * `DELETE …/assignments/{id}` — takes somebody off a shift.
 *
 * A cancellation on the server, not an erasure: the row is kept so that "who
 * was on the door?" stays answerable, and it leaves the roster this client
 * reads. A 204, so there is no body.
 */
export async function cancelAssignment(
  orgId: string,
  eventId: string,
  assignmentId: string,
  version: number,
): Promise<CancelResult> {
  const outcome = await requestNoContent({
    method: 'DELETE',
    path: `${assignmentsPath(orgId, eventId)}/${encodeURIComponent(assignmentId)}`,
    ifMatchVersion: version,
  });

  return outcome.ok
    ? { ok: true }
    : { ok: false, rejection: rejectionFor(outcome.failure) };
}
