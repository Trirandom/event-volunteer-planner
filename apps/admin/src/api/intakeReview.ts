// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The review queue (docs/04 "Batches and submissions", docs/08 §6): form
 * submissions that could not be applied on their own — a name too close to
 * an existing volunteer's, an address that belongs to someone else, or an
 * answer sent too fast — and the coordinator's decision on each.
 *
 * Organisation-wide, like the submissions list, so the page reads it once
 * whichever day the strip is on.
 */

import * as v from 'valibot';

import { request, type ApiResult, type Failure } from './http';

const CONFLICT = 'https://evp.example/errors/conflict';
const VALIDATION_FAILED = 'https://evp.example/errors/validation-failed';
const FORBIDDEN = 'https://evp.example/errors/forbidden';

const text = v.pipe(v.string(), v.minLength(1));

const claimedSchema = v.object({
  display_name: text,
  first_name: v.nullish(v.string()),
  last_name: v.nullish(v.string()),
  email: v.nullish(v.string()),
  phone: v.nullish(v.string()),
});

const candidateSchema = v.object({
  volunteer_id: text,
  score: v.number(),
  last_name_agrees: v.boolean(),
  phone_agrees: v.boolean(),
  display_name: text,
  first_name: v.nullish(v.string()),
  last_name: v.nullish(v.string()),
  email: v.nullish(v.string()),
  phone: v.nullish(v.string()),
});

const reviewItemSchema = v.object({
  id: text,
  received_at: v.pipe(v.string(), v.isoTimestamp()),
  /** Absent when the payload would not map: only rejecting it is offered. */
  claimed: v.nullish(claimedSchema),
  answers: v.array(v.object({ question: text, value: v.string() })),
  availability: v.array(
    v.object({
      event_id: text,
      start: v.pipe(v.string(), v.isoTimestamp()),
      end: v.pipe(v.string(), v.isoTimestamp()),
    }),
  ),
  /** Why it is waiting. `code` is what the page branches on. */
  reasons: v.array(
    v.object({
      field: v.string(),
      code: text,
      message: v.nullish(v.string()),
    }),
  ),
  /** Best first; empty when it was never compared with the pool. */
  candidates: v.array(candidateSchema),
});

export type ReviewItem = v.InferOutput<typeof reviewItemSchema>;
export type ReviewCandidate = v.InferOutput<typeof candidateSchema>;

const queueSchema = v.object({ submissions: v.array(reviewItemSchema) });

/** `GET …/intake/submissions?state=needs_review`, oldest first. */
export async function fetchReviewQueue(
  orgId: string,
  signal?: AbortSignal,
): Promise<ApiResult<readonly ReviewItem[]>> {
  const result = await request(
    {
      method: 'GET',
      path: `/api/v1/orgs/${encodeURIComponent(orgId)}/intake/submissions?state=needs_review`,
      ...(signal === undefined ? {} : { signal }),
    },
    queueSchema,
  );
  return result.ok ? { ok: true, value: result.value.submissions } : result;
}

/** What a coordinator decided (`POST …/resolve`'s body). */
export type Resolution =
  | { readonly action: 'match'; readonly volunteer_id: string }
  | { readonly action: 'create_new' }
  | { readonly action: 'reject'; readonly reason: string }
  | { readonly action: 'reconcile' };

const resolvedSchema = v.object({
  state: v.picklist(['applied', 'rejected', 'needs_review']),
  volunteer_id: v.nullish(v.string()),
  match_kind: v.nullish(v.string()),
  email_withheld: v.boolean(),
  operation_id: text,
});

export type Resolved = v.InferOutput<typeof resolvedSchema>;

export type ResolveRejection =
  /** Someone else resolved it first; the queue is re-read. */
  | { readonly reason: 'conflict'; readonly detail: string }
  | { readonly reason: 'invalid'; readonly detail: string }
  | { readonly reason: 'forbidden'; readonly detail: string }
  | { readonly reason: 'refused'; readonly detail: string }
  | { readonly reason: 'unavailable' };

export type ResolveResult =
  | { readonly ok: true; readonly resolved: Resolved }
  | { readonly ok: false; readonly rejection: ResolveRejection };

function rejectionFor(failure: Failure): ResolveRejection {
  if (failure.reason !== 'rejected') {
    return { reason: 'unavailable' };
  }
  const { problem } = failure;
  const detail = problem.detail ?? problem.title;
  if (problem.type === CONFLICT) {
    return { reason: 'conflict', detail };
  }
  if (problem.type === VALIDATION_FAILED) {
    return { reason: 'invalid', detail };
  }
  if (problem.type === FORBIDDEN) {
    return { reason: 'forbidden', detail };
  }
  return { reason: 'refused', detail };
}

/** `POST …/intake/submissions/{sub}/resolve`. */
export async function resolveSubmission(
  orgId: string,
  submissionId: string,
  resolution: Resolution,
): Promise<ResolveResult> {
  const result = await request(
    {
      method: 'POST',
      path:
        `/api/v1/orgs/${encodeURIComponent(orgId)}` +
        `/intake/submissions/${encodeURIComponent(submissionId)}/resolve`,
      body: resolution,
    },
    resolvedSchema,
  );
  return result.ok
    ? { ok: true, resolved: result.value }
    : { ok: false, rejection: rejectionFor(result.failure) };
}
