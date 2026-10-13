// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * Locations: the zone/post tree a coordinator declares posts against
 * (docs/03 §3.4, docs/04 §"Events, locations, shifts").
 *
 * Read *and* write, since the missions section edits these rows directly — a
 * mission is a `locations` row and nothing else stands behind it. The tree
 * shape mirrors the wire exactly: a zone always carries `posts` (empty when it
 * has none), a post never does, which is `evp-api`'s own `as_tree` distinction
 * and not something this file re-derives.
 *
 * Every write carries `If-Match`, because `evp-api`'s `Precondition` extractor
 * answers a `PATCH` or `DELETE` without one with `428` (docs/02 §7).
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

const postSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  event_id: v.pipe(v.string(), v.minLength(1)),
  parent_id: v.nullable(v.pipe(v.string(), v.minLength(1))),
  kind: v.pipe(v.string(), v.minLength(1)),
  name: v.pipe(v.string(), v.minLength(1)),
  /**
   * What the job is, when somebody has said. `optional`, not `nullable`: the
   * server skips the key rather than sending `null`, and the schema refuses a
   * blank string, so there is exactly one way to spell "nothing said" and it
   * is `undefined` here.
   */
  description: v.optional(v.pipe(v.string(), v.minLength(1))),
  /** Where to stand. Free text, not a postal record — see migration
   * `…130000_locations_are_described`. */
  address: v.optional(v.pipe(v.string(), v.minLength(1))),
  /** A postal address a map or courier can resolve. Zones only — see
   * migration `…093312_locations_get_exact_address`. */
  exact_address: v.optional(v.pipe(v.string(), v.minLength(1))),
  /** Decimal degrees, WGS 84. Present together with `longitude`. Zones only. */
  latitude: v.optional(v.number()),
  longitude: v.optional(v.number()),
  /**
   * How many volunteers the mission can take, when somebody has said — the
   * floor it is understaffed below and the ceiling past which another pair of
   * hands is in the way. Each is independent and absent when unset; the server
   * refuses a ceiling below the floor (`locations_volunteer_bounds_ordered`).
   */
  min_volunteers: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  max_volunteers: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  /**
   * How the volunteer form's missions question offers this mission: already
   * ticked, and for adults only. Zones only — the server skips both keys on a
   * post, which takes its zone's values when the form folds missions (see
   * migration `…093000_locations_form_flags`).
   */
  checked_by_default: v.optional(v.boolean()),
  adults_only: v.optional(v.boolean()),
  sort_order: v.pipe(v.number(), v.integer()),
  colour: v.optional(v.string()),
  shift_pattern_id: v.optional(v.pipe(v.string(), v.minLength(1))),
  created_at: v.pipe(v.string(), v.isoTimestamp()),
  updated_at: v.pipe(v.string(), v.isoTimestamp()),
  version: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

export type Post = v.InferOutput<typeof postSchema>;

const zoneSchema = v.object({
  ...postSchema.entries,
  posts: v.array(postSchema),
});

export type Zone = v.InferOutput<typeof zoneSchema>;

const listResponseSchema = v.object({
  data: v.array(zoneSchema),
  next: v.nullable(v.string()),
});

const writtenSchema = v.object({ location: postSchema });

function locationsPath(orgId: string, eventId: string): string {
  return `/api/v1/orgs/${encodeURIComponent(orgId)}/events/${encodeURIComponent(eventId)}/locations`;
}

/** `GET /api/v1/orgs/{org}/events/{event}/locations` — the zone/post tree. */
export async function fetchLocations(
  orgId: string,
  eventId: string,
  signal?: AbortSignal,
): Promise<ApiResult<readonly Zone[]>> {
  const result = await request(
    {
      method: 'GET',
      path: locationsPath(orgId, eventId),
      ...(signal === undefined ? {} : { signal }),
    },
    listResponseSchema,
  );

  return result.ok ? { ok: true, value: result.value.data } : result;
}

/** Why a location write did not happen. Shaped like `shifts.ts`'s rejection so
 * a fan-out over several days can report every refusal through one path. */
export type LocationWriteRejection =
  /**
   * Two things wear this hat, and a coordinator can act on both the same way.
   * Either somebody else edited the row since this page read it — docs/02 §7
   * makes that a visible message and a refetch, never a retry — or the name
   * collides with another mission of the same event, which
   * `locations_event_id_parent_id_name_key` refuses.
   */
  | { readonly reason: 'conflict'; readonly detail: string }
  | { readonly reason: 'validation-failed'; readonly detail: string }
  | { readonly reason: 'forbidden'; readonly detail: string }
  | { readonly reason: 'refused'; readonly detail: string }
  | { readonly reason: 'unavailable' };

function rejectionFor(failure: Failure): LocationWriteRejection {
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

export type LocationWriteResult =
  | { readonly ok: true; readonly location: Post }
  | { readonly ok: false; readonly rejection: LocationWriteRejection };

export type LocationDeleteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly rejection: LocationWriteRejection };

export interface NewLocation {
  readonly kind: 'zone' | 'post';
  readonly name: string;
  /** Required for a post, refused for a zone: the tree is exactly two levels
   * and the server enforces it (docs/03 §3.4). */
  readonly parentId?: string;
  readonly description?: string;
  readonly address?: string;
  /** Zone-only: refused on a post, which is reached through its zone. */
  readonly exactAddress?: string;
  /** Sent together, or not at all. */
  readonly latitude?: number;
  readonly longitude?: number;
  readonly minVolunteers?: number;
  readonly maxVolunteers?: number;
  /** Zone-only, like `exactAddress`. Omitted, the server writes `true` /
   * `false`. */
  readonly checkedByDefault?: boolean;
  readonly adultsOnly?: boolean;
}

/**
 * `POST …/locations`.
 *
 * The optional keys are spread in rather than sent as `undefined`: under
 * `exactOptionalPropertyTypes` those are different values here, and
 * `JSON.stringify` would drop the second silently — which happens to be the
 * right body, but only by accident, and the next field added this way would
 * not be.
 */
export async function createLocation(
  orgId: string,
  eventId: string,
  input: NewLocation,
): Promise<LocationWriteResult> {
  const result = await requestVersioned(
    {
      method: 'POST',
      path: locationsPath(orgId, eventId),
      body: {
        kind: input.kind,
        name: input.name,
        ...(input.parentId === undefined ? {} : { parent_id: input.parentId }),
        ...(input.description === undefined
          ? {}
          : { description: input.description }),
        ...(input.address === undefined ? {} : { address: input.address }),
        ...(input.exactAddress === undefined
          ? {}
          : { exact_address: input.exactAddress }),
        ...(input.latitude === undefined ? {} : { latitude: input.latitude }),
        ...(input.longitude === undefined
          ? {}
          : { longitude: input.longitude }),
        ...(input.minVolunteers === undefined
          ? {}
          : { min_volunteers: input.minVolunteers }),
        ...(input.maxVolunteers === undefined
          ? {}
          : { max_volunteers: input.maxVolunteers }),
        ...(input.checkedByDefault === undefined
          ? {}
          : { checked_by_default: input.checkedByDefault }),
        ...(input.adultsOnly === undefined
          ? {}
          : { adults_only: input.adultsOnly }),
      },
    },
    writtenSchema,
  );

  return result.ok
    ? { ok: true, location: result.value.value.location }
    : { ok: false, rejection: rejectionFor(result.failure) };
}

/**
 * What the missions form can change about a mission.
 *
 * The two text fields are tri-state on the wire and so are they here: `null`
 * clears what is stored, a string replaces it, and an absent key leaves it
 * alone. The form only ever sends the first two — it shows every field at
 * once, so "the coordinator emptied this box" is a real edit and not an
 * omission — but the type has to carry the third, because a caller that
 * renames a mission must not also wipe its briefing.
 */
export interface LocationChanges {
  readonly name?: string;
  readonly description?: string | null;
  readonly address?: string | null;
  readonly exactAddress?: string | null;
  /**
   * Sent and cleared together — the server refuses one without the other
   * (`locations_latitude_longitude_together`).
   */
  readonly latitude?: number | null;
  readonly longitude?: number | null;
  /** Tri-state like the text fields: `null` clears the bound. */
  readonly minVolunteers?: number | null;
  readonly maxVolunteers?: number | null;
  /** Zone-only. Not tri-state: the column is NOT NULL, so there is nothing to
   * clear, only a value to set. */
  readonly checkedByDefault?: boolean;
  readonly adultsOnly?: boolean;
}

/** `PATCH …/locations/{id}`. */
export async function patchLocation(
  orgId: string,
  eventId: string,
  locationId: string,
  version: number,
  changes: LocationChanges,
): Promise<LocationWriteResult> {
  const body: Record<string, unknown> = {};
  if (changes.name !== undefined) {
    body['name'] = changes.name;
  }
  if (changes.description !== undefined) {
    body['description'] = changes.description;
  }
  if (changes.address !== undefined) {
    body['address'] = changes.address;
  }
  if (changes.exactAddress !== undefined) {
    body['exact_address'] = changes.exactAddress;
  }
  if (changes.latitude !== undefined) {
    body['latitude'] = changes.latitude;
  }
  if (changes.longitude !== undefined) {
    body['longitude'] = changes.longitude;
  }
  if (changes.minVolunteers !== undefined) {
    body['min_volunteers'] = changes.minVolunteers;
  }
  if (changes.maxVolunteers !== undefined) {
    body['max_volunteers'] = changes.maxVolunteers;
  }
  if (changes.checkedByDefault !== undefined) {
    body['checked_by_default'] = changes.checkedByDefault;
  }
  if (changes.adultsOnly !== undefined) {
    body['adults_only'] = changes.adultsOnly;
  }

  const result = await requestVersioned(
    {
      method: 'PATCH',
      path: `${locationsPath(orgId, eventId)}/${encodeURIComponent(locationId)}`,
      body,
      ifMatchVersion: version,
    },
    writtenSchema,
  );

  return result.ok
    ? { ok: true, location: result.value.value.location }
    : { ok: false, rejection: rejectionFor(result.failure) };
}

/**
 * `DELETE …/locations/{id}` — `204`, and the cascade takes the posts under a
 * zone and the shifts under either.
 *
 * There is no "refuse if it holds shifts" on the server (`evp-api`'s
 * `delete_location` says why), so the warning about what goes with it belongs
 * in the confirmation the view shows, not here.
 */
export async function deleteLocation(
  orgId: string,
  eventId: string,
  locationId: string,
  version: number,
): Promise<LocationDeleteResult> {
  const outcome = await requestNoContent({
    method: 'DELETE',
    path: `${locationsPath(orgId, eventId)}/${encodeURIComponent(locationId)}`,
    ifMatchVersion: version,
  });

  return outcome.ok
    ? { ok: true }
    : { ok: false, rejection: rejectionFor(outcome.failure) };
}
