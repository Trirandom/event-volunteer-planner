// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * Replacing one participation's declared availability
 * (docs/04 §"Participation and availability").
 *
 * Write only. The board *reads* availability from the roster list, which
 * already carries every participation's windows with their provenance and is
 * the same request the page needs for the names anyway — a second fetch per
 * volunteer would be a few hundred round trips for one festival day, which is
 * the reason `evp-api` inlines them there in the first place.
 *
 * The replace is scoped to the coordinator's own windows: what the volunteer
 * submitted is never sent here and the server never touches it, whatever this
 * body contains (`evp-api`'s `replace_availability`). `plan/availability.ts`
 * is what works out which windows express a given edit; this module only
 * carries them.
 *
 * Notes are not sent, because the board has nowhere to type one. That loses
 * nothing today — nothing in this application writes a note on a declared
 * window — and is stated here rather than discovered later, because a replace
 * that silently dropped a field somebody *had* filled in would be the kind of
 * data loss this codebase is careful about.
 */
import * as v from 'valibot';

import { request, type Failure } from './http';

const VALIDATION_FAILED = 'https://evp.example/errors/validation-failed';
const FORBIDDEN = 'https://evp.example/errors/forbidden';
const CONFLICT = 'https://evp.example/errors/conflict';

const periodSchema = v.object({
  start: v.pipe(v.string(), v.isoTimestamp()),
  end: v.pipe(v.string(), v.isoTimestamp()),
});

const windowSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  kind: v.picklist(['available', 'unavailable']),
  period: periodSchema,
  note: v.optional(v.string()),
  provenance: v.picklist(['declared', 'submitted']),
});

export type AvailabilityWindowDto = v.InferOutput<typeof windowSchema>;

const writtenSchema = v.object({
  windows: v.array(windowSchema),
  operation_id: v.pipe(v.string(), v.minLength(1)),
});

/** One window as the replace sends it: RFC 3339 instants, flat, as
 * `AvailabilityWindowInput` on the server reads them. */
export interface NewWindow {
  readonly kind: 'available' | 'unavailable';
  readonly start: string;
  readonly end: string;
}

/** Why a replace did not happen. */
export type ReplaceAvailabilityRejection =
  /** A rule refused it: two windows in the body overlap, or a period is
   * empty. The detail names which (`evp-api`'s `map_write_error`). */
  | { readonly reason: 'validation-failed'; readonly detail: string }
  /** The replace needs `Coordinator`; a zone lead may read this board and not
   * write to it. */
  | { readonly reason: 'forbidden'; readonly detail: string }
  | { readonly reason: 'conflict'; readonly detail: string }
  | { readonly reason: 'refused'; readonly detail: string }
  | { readonly reason: 'unavailable' };

export type ReplaceAvailabilityResult =
  | {
      readonly ok: true;
      readonly windows: readonly AvailabilityWindowDto[];
      readonly operationId: string;
    }
  | { readonly ok: false; readonly rejection: ReplaceAvailabilityRejection };

function rejectionFor(failure: Failure): ReplaceAvailabilityRejection {
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
  if (problem.type === CONFLICT) {
    return { reason: 'conflict', detail };
  }
  return { reason: 'refused', detail };
}

/**
 * `PUT …/participations/{id}/availability`.
 *
 * No `If-Match`: there is no row this asserts against. The endpoint replaces a
 * *set* rather than editing a row, and the set it replaces is the one this
 * board just drew — so the lost-update story the shift board tells with
 * versions is told here by the board re-reading the roster after every save
 * (`useAvailabilityWrites.ts`).
 */
export async function replaceAvailability(
  orgId: string,
  eventId: string,
  participationId: string,
  windows: readonly NewWindow[],
): Promise<ReplaceAvailabilityResult> {
  const result = await request(
    {
      method: 'PUT',
      path:
        `/api/v1/orgs/${encodeURIComponent(orgId)}` +
        `/events/${encodeURIComponent(eventId)}` +
        `/participations/${encodeURIComponent(participationId)}/availability`,
      body: { windows },
    },
    writtenSchema,
  );

  return result.ok
    ? {
        ok: true,
        windows: result.value.windows,
        operationId: result.value.operation_id,
      }
    : { ok: false, rejection: rejectionFor(result.failure) };
}
