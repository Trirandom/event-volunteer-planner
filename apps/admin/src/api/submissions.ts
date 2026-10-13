// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * Form submissions: what a volunteer answered, and when they said they can
 * work (docs/09).
 *
 * Read-only, and festival-scoped rather than event-scoped, because that is
 * what the volunteer actually did: one form is filled once for Soundclash 26
 * and its availability question covers every day of the production
 * (docs/09 §3). The server therefore answers per festival and the day strip
 * narrows the answer (`plan/submissions.ts`) — an event-scoped route would
 * have to invent a per-day submission that nobody ever submitted, and "who
 * has offered nothing yet?" would become six questions again.
 *
 * `availability` carries `event_id` on every window for exactly that reason:
 * the narrowing is a client-side filter over one cached response, not a
 * refetch per day.
 */

import * as v from 'valibot';

import { request, type ApiResult } from './http';

const windowSchema = v.object({
  event_id: v.pipe(v.string(), v.minLength(1)),
  start: v.pipe(v.string(), v.isoTimestamp()),
  end: v.pipe(v.string(), v.isoTimestamp()),
});

export type AvailabilityWindow = v.InferOutput<typeof windowSchema>;

/**
 * One non-availability answer, already rendered by the server.
 *
 * A `{question, value}` pair rather than a keyed object: answers are
 * interpreted against the form version they were given to (docs/09 §2), so
 * the set of questions is not fixed and a client that indexed them by a
 * known key would silently drop whatever a later version added.
 */
const answerSchema = v.object({
  question: v.pipe(v.string(), v.minLength(1)),
  value: v.string(),
});

export type SubmissionAnswer = v.InferOutput<typeof answerSchema>;

export const submissionSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  /** Never empty: a scene name or a four-token name survives intact here,
   * which is why it is stored rather than joined from the parts on read
   * (ADR-0012). */
  display_name: v.pipe(v.string(), v.minLength(1)),
  /**
   * Absent where the volunteer gave no such part. Nothing splits a combined
   * field — docs/10 §4 showed that to be wrong for most of the real pool, and
   * the legacy form asked for one name box, so the worked example omits both
   * on every row (ADR-0012).
   *
   * `nullish`, not `nullable`: `evp-api` carries `skip_serializing_if` on
   * both, so the *key is missing* rather than sent as `null` — the same
   * convention `LocationResponse.description` follows. A schema demanding the
   * key would reject every submission the example loads, and the page would
   * report a contract break instead of showing them.
   */
  first_name: v.nullish(v.string()),
  last_name: v.nullish(v.string()),
  submitted_at: v.pipe(v.string(), v.isoTimestamp()),
  answers: v.array(answerSchema),
  availability: v.array(windowSchema),
});

export type Submission = v.InferOutput<typeof submissionSchema>;

const listResponseSchema = v.object({
  submissions: v.array(submissionSchema),
});

/** `GET /api/v1/orgs/{org}/festivals/{festival}/submissions`. */
export async function fetchSubmissions(
  orgId: string,
  festivalId: string,
  signal?: AbortSignal,
): Promise<ApiResult<readonly Submission[]>> {
  const result = await request(
    {
      method: 'GET',
      path: `/api/v1/orgs/${encodeURIComponent(orgId)}/festivals/${encodeURIComponent(festivalId)}/submissions`,
      ...(signal === undefined ? {} : { signal }),
    },
    listResponseSchema,
  );

  return result.ok ? { ok: true, value: result.value.submissions } : result;
}
