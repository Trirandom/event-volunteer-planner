// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The roster of one event: who said they are coming, and when they can work
 * (docs/04 §"Participation and availability").
 *
 * Read-only, because the endpoint is. Enrolling somebody, changing a status
 * and replacing an availability list are documented writes that `evp-api` does
 * not serve yet, and a client function for one of them would be a function
 * that cannot work.
 *
 * Event-scoped, unlike submissions: a submission is filled once for the whole
 * festival, but *enrolment* is per edition — a volunteer who offered Saturday
 * has no participation on Sunday, and the assignation board must not offer
 * them for it. That is also what the server's composite foreign key enforces,
 * so a client that guessed otherwise would collect a 422 per click.
 */

import * as v from 'valibot';

import { request, type ApiResult } from './http';

const periodSchema = v.object({
  start: v.pipe(v.string(), v.isoTimestamp()),
  end: v.pipe(v.string(), v.isoTimestamp()),
});

const windowSchema = v.object({
  /** `available` or `unavailable`. Kept apart: somebody who declared neither
   * is *unknown*, not free (docs/03 §3.5), and the board says so. */
  kind: v.picklist(['available', 'unavailable']),
  period: periodSchema,
  /**
   * `declared` for a coordinator's hand-entered window, `submitted` for one
   * derived from the volunteer's own form submission. The two may overlap in
   * time — a declared window over a submitted one is an override, not a
   * contradiction (`evp-api`'s `WindowResponse` doc comment) — which is what
   * `plan/roster.ts`'s `declaredState` uses this for. Optional and defaulted
   * to `declared` in that function rather than made required here, so a
   * fixture built before this field existed still means what it always did.
   */
  provenance: v.optional(v.picklist(['declared', 'submitted'])),
});

export type AvailabilityWindow = v.InferOutput<typeof windowSchema>;

export const participationSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  volunteer_id: v.pipe(v.string(), v.minLength(1)),
  display_name: v.pipe(v.string(), v.minLength(1)),
  status: v.picklist(['invited', 'confirmed', 'declined', 'withdrawn']),
  availability: v.array(windowSchema),
});

export type Participation = v.InferOutput<typeof participationSchema>;

/** The two statuses that may hold an assignment. A constraint trigger refuses
 * the other two, so offering them would be offering a click that is always
 * refused. */
export function isAssignable(participation: Participation): boolean {
  return (
    participation.status === 'invited' || participation.status === 'confirmed'
  );
}

const listResponseSchema = v.object({
  data: v.array(participationSchema),
  next: v.nullable(v.string()),
});

/** `GET /api/v1/orgs/{org}/events/{event}/participations`. */
export async function fetchParticipations(
  orgId: string,
  eventId: string,
  signal?: AbortSignal,
): Promise<ApiResult<readonly Participation[]>> {
  const result = await request(
    {
      method: 'GET',
      path: `/api/v1/orgs/${encodeURIComponent(orgId)}/events/${encodeURIComponent(eventId)}/participations`,
      ...(signal === undefined ? {} : { signal }),
    },
    listResponseSchema,
  );

  return result.ok ? { ok: true, value: result.value.data } : result;
}
