// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * Festivals: the optional grouping above an event.
 *
 * Modelled on `session.ts` throughout: a valibot schema is the boundary, the
 * TypeScript type is inferred from it, and every rejection is a value the
 * caller must destructure rather than a `catch` clause. See `http.ts`'s
 * module doc comment for why — it applies unchanged here.
 */

import * as v from 'valibot';

import { eventSchema } from './events';
import { request, type ApiResult, type Failure } from './http';

const VALIDATION_FAILED = 'https://evp.example/errors/validation-failed';
const FORBIDDEN = 'https://evp.example/errors/forbidden';
const CONFLICT = 'https://evp.example/errors/conflict';

/** Shared with `events.ts`'s own copy by shape, not by import: two resources
 * that both happen to be half-open UTC ranges are not one type, and importing
 * across the two would only buy a coincidence. */
const periodSchema = v.object({
  start: v.pipe(v.string(), v.isoTimestamp()),
  end: v.pipe(v.string(), v.isoTimestamp()),
});

export type Period = v.InferOutput<typeof periodSchema>;

export const festivalSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  name: v.pipe(v.string(), v.minLength(1)),
  slug: v.pipe(v.string(), v.minLength(1)),
  timezone: v.pipe(v.string(), v.minLength(1)),
  period: periodSchema,
  status: v.pipe(v.string(), v.minLength(1)),
  event_count: v.pipe(v.number(), v.integer(), v.minValue(0)),
  created_at: v.pipe(v.string(), v.isoTimestamp()),
  updated_at: v.pipe(v.string(), v.isoTimestamp()),
  version: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

export type Festival = v.InferOutput<typeof festivalSchema>;

/** `GET .../festivals/{festival}` inlines the festival's own events. */
const festivalDetailSchema = v.object({
  ...festivalSchema.entries,
  events: v.array(eventSchema),
});

export type FestivalDetail = v.InferOutput<typeof festivalDetailSchema>;

const listResponseSchema = v.object({
  data: v.array(festivalSchema),
  next: v.nullable(v.string()),
});

const createFestivalResponseSchema = v.object({
  festival: festivalSchema,
  operation_id: v.pipe(v.string(), v.minLength(1)),
});

/** `GET /api/v1/orgs/{org}/festivals`, optionally narrowed by status. */
export async function fetchFestivals(
  orgId: string,
  options: { readonly status?: string; readonly signal?: AbortSignal } = {},
): Promise<ApiResult<readonly Festival[]>> {
  const params = new URLSearchParams();
  if (options.status !== undefined) {
    params.set('status', options.status);
  }
  const query = params.size > 0 ? `?${params.toString()}` : '';

  const result = await request(
    {
      method: 'GET',
      path: `/api/v1/orgs/${encodeURIComponent(orgId)}/festivals${query}`,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
    listResponseSchema,
  );

  return result.ok ? { ok: true, value: result.value.data } : result;
}

/** `GET /api/v1/orgs/{org}/festivals/{festival}`, events inlined. */
export async function fetchFestival(
  orgId: string,
  festivalId: string,
  signal?: AbortSignal,
): Promise<ApiResult<FestivalDetail>> {
  return request(
    {
      method: 'GET',
      path: `/api/v1/orgs/${encodeURIComponent(orgId)}/festivals/${encodeURIComponent(festivalId)}`,
      ...(signal === undefined ? {} : { signal }),
    },
    festivalDetailSchema,
  );
}

export interface CreateFestivalInput {
  readonly name: string;
  readonly slug: string;
  readonly timezone: string;
  readonly period: Period;
}

/** Why `POST /festivals` did not create the festival. */
export type CreateFestivalRejection =
  | { readonly reason: 'validation-failed'; readonly detail: string }
  | { readonly reason: 'forbidden'; readonly detail: string }
  | { readonly reason: 'refused'; readonly detail: string }
  | { readonly reason: 'unavailable' };

export type CreateFestivalResult =
  | {
      readonly ok: true;
      readonly festival: Festival;
      readonly operationId: string;
    }
  | { readonly ok: false; readonly rejection: CreateFestivalRejection };

/** `POST /api/v1/orgs/{org}/festivals`. */
export async function createFestival(
  orgId: string,
  input: CreateFestivalInput,
): Promise<CreateFestivalResult> {
  const result = await request(
    {
      method: 'POST',
      path: `/api/v1/orgs/${encodeURIComponent(orgId)}/festivals`,
      body: input,
    },
    createFestivalResponseSchema,
  );

  return result.ok
    ? {
        ok: true,
        festival: result.value.festival,
        operationId: result.value.operation_id,
      }
    : { ok: false, rejection: createRejectionFor(result.failure) };
}

function createRejectionFor(failure: Failure): CreateFestivalRejection {
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

/** Why `POST /festivals/example` did not load the worked example. */
export type LoadExampleFestivalRejection =
  /** The org already has at least one festival — docs contract for this route. */
  | { readonly reason: 'conflict'; readonly detail: string }
  | { readonly reason: 'forbidden'; readonly detail: string }
  | { readonly reason: 'refused'; readonly detail: string }
  | { readonly reason: 'unavailable' };

export type LoadExampleFestivalResult =
  | {
      readonly ok: true;
      readonly festival: Festival;
      readonly operationId: string;
    }
  | { readonly ok: false; readonly rejection: LoadExampleFestivalRejection };

/** `POST /api/v1/orgs/{org}/festivals/example`. */
export async function loadExampleFestival(
  orgId: string,
): Promise<LoadExampleFestivalResult> {
  const result = await request(
    {
      method: 'POST',
      path: `/api/v1/orgs/${encodeURIComponent(orgId)}/festivals/example`,
    },
    createFestivalResponseSchema,
  );

  return result.ok
    ? {
        ok: true,
        festival: result.value.festival,
        operationId: result.value.operation_id,
      }
    : { ok: false, rejection: exampleRejectionFor(result.failure) };
}

function exampleRejectionFor(failure: Failure): LoadExampleFestivalRejection {
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

const count = v.pipe(v.number(), v.integer(), v.minValue(0));

const festivalDeletionSchema = v.object({
  events: count,
  forms: count,
  submissions: count,
});

/** What deleting a festival would touch (ADR-0053): the events it leaves
 * standalone, and the forms and submissions it deletes for good. */
export type FestivalDeletion = v.InferOutput<typeof festivalDeletionSchema>;

/** `GET …/festivals/{festival}/deletion` — owner only. Read before the
 * confirmation opens, so the owner sees the cost in numbers. */
export async function fetchFestivalDeletion(
  orgId: string,
  festivalId: string,
  signal?: AbortSignal,
): Promise<ApiResult<FestivalDeletion>> {
  return request(
    {
      method: 'GET',
      path: `/api/v1/orgs/${encodeURIComponent(orgId)}/festivals/${encodeURIComponent(festivalId)}/deletion`,
      ...(signal === undefined ? {} : { signal }),
    },
    festivalDeletionSchema,
  );
}

const deleteFestivalResponseSchema = v.object({
  operation_id: v.pipe(v.string(), v.minLength(1)),
  events_ungrouped: count,
  forms_deleted: count,
  submissions_deleted: count,
});

/** Why `DELETE …/festivals/{festival}` did not happen. `conflict` is a stale
 * `If-Match`: someone changed the festival since this page read it. */
export type DeleteFestivalRejection =
  | { readonly reason: 'conflict'; readonly detail: string }
  | { readonly reason: 'forbidden'; readonly detail: string }
  | { readonly reason: 'refused'; readonly detail: string }
  | { readonly reason: 'unavailable' };

export type DeleteFestivalResult =
  | {
      readonly ok: true;
      readonly operationId: string;
      readonly eventsUngrouped: number;
    }
  | { readonly ok: false; readonly rejection: DeleteFestivalRejection };

/** `DELETE …/festivals/{festival}` — owner only, behind `If-Match`. Answers
 * with what it did, because the events stay and the page has to say so. */
export async function deleteFestival(
  orgId: string,
  festivalId: string,
  version: number,
): Promise<DeleteFestivalResult> {
  const result = await request(
    {
      method: 'DELETE',
      path: `/api/v1/orgs/${encodeURIComponent(orgId)}/festivals/${encodeURIComponent(festivalId)}`,
      ifMatchVersion: version,
    },
    deleteFestivalResponseSchema,
  );

  return result.ok
    ? {
        ok: true,
        operationId: result.value.operation_id,
        eventsUngrouped: result.value.events_ungrouped,
      }
    : { ok: false, rejection: deleteRejectionFor(result.failure) };
}

const PRECONDITION_REQUIRED =
  'https://evp.example/errors/precondition-required';

function deleteRejectionFor(failure: Failure): DeleteFestivalRejection {
  if (failure.reason !== 'rejected') {
    return { reason: 'unavailable' };
  }

  const { problem } = failure;
  const detail = problem.detail ?? problem.title;

  if (problem.type === CONFLICT || problem.type === PRECONDITION_REQUIRED) {
    return { reason: 'conflict', detail };
  }
  if (problem.type === FORBIDDEN) {
    return { reason: 'forbidden', detail };
  }
  return { reason: 'refused', detail };
}
