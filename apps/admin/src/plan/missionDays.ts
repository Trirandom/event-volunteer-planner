// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * Which days a zone runs on, as something a coordinator can change.
 *
 * A zone "runs on" a day by having a `locations` row on that event
 * (ADR-0032), so ticking a day is a create and un-ticking it is a delete.
 * Both are lopsided in what they carry, and this module is where that is
 * decided, away from the requests:
 *
 * - **Ticking copies.** The new day gets the zone as it stands on its first
 *   day, and every post filed under it, so "the bar runs on Sunday too" is
 *   one press rather than a zone and then each of its posts typed again. The
 *   first day rather than a merge of all of them, because a field the days
 *   disagree on has no right answer to merge to, and the copy is one more day
 *   to correct afterwards rather than a guess spread over every field.
 * - **Un-ticking can take more than the row.** `ON DELETE CASCADE` takes the
 *   day's posts and every shift on either. That is what decides whether the
 *   view asks first: a day holding nothing is restored exactly by ticking it
 *   again, a day holding shifts is not.
 *
 * Pure. The writes are `api/useMissionWrites.ts`'s.
 */
import type { NewLocation } from '../api/locations';
import type { Mission, MissionPlacement, ZoneGroup } from './missionCatalog';
import { parseCoordinates, parseCount } from './missionDraft';

/** A post's create body, before the new day's zone row exists to file it under. */
export type PostCopy = Omit<NewLocation, 'parentId'>;

export interface DayCopy {
  readonly zone: NewLocation;
  readonly posts: readonly PostCopy[];
}

/** One stored row, as the create that would reproduce it. Absent fields stay
 * absent, the rule `NewLocation`'s spreads follow everywhere else. */
function copyOf(placement: MissionPlacement): NewLocation {
  const coordinates =
    placement.coordinates === null
      ? null
      : parseCoordinates(placement.coordinates);
  const minVolunteers =
    placement.minVolunteers === null
      ? null
      : parseCount(placement.minVolunteers, 0);
  const maxVolunteers =
    placement.maxVolunteers === null
      ? null
      : parseCount(placement.maxVolunteers, 1);

  return {
    kind: placement.kind,
    name: placement.name,
    ...(placement.description === null
      ? {}
      : { description: placement.description }),
    ...(placement.address === null ? {} : { address: placement.address }),
    ...(placement.exactAddress === null
      ? {}
      : { exactAddress: placement.exactAddress }),
    ...(coordinates === null
      ? {}
      : { latitude: coordinates.latitude, longitude: coordinates.longitude }),
    ...(minVolunteers === null ? {} : { minVolunteers }),
    ...(maxVolunteers === null ? {} : { maxVolunteers }),
    ...(placement.checkedByDefault === null
      ? {}
      : { checkedByDefault: placement.checkedByDefault }),
    ...(placement.adultsOnly === null
      ? {}
      : { adultsOnly: placement.adultsOnly }),
  };
}

/**
 * What a new day of `group`'s zone is created with.
 *
 * Each post comes from the zone's first day when it runs there, so the copy
 * is one day's coherent tree, and from its own first day otherwise — a post
 * declared only on the club night still belongs to the zone.
 */
export function dayCopy(group: ZoneGroup): DayCopy {
  const reference = group.zone.placements[0];
  return {
    zone:
      reference === undefined
        ? { kind: 'zone', name: group.zone.name }
        : copyOf(reference),
    posts: group.posts.flatMap((post): PostCopy[] => {
      const placement =
        post.placements.find(
          (candidate) => candidate.eventId === reference?.eventId,
        ) ?? post.placements[0];
      return placement === undefined ? [] : [copyOf(placement)];
    }),
  };
}

/** A zone keeps at least one day: removing the last is deleting the zone,
 * which has its own button and its own, louder, confirmation. */
export function canRemoveDay(zone: Mission): boolean {
  return zone.placements.length > 1;
}

export interface DayRemoval {
  /** The zone's row on that day — the one delete the removal sends. */
  readonly placement: MissionPlacement;
  /** The posts the cascade takes with it. */
  readonly postNames: readonly string[];
  /** Shifts on the zone row or any of those posts. */
  readonly shiftCount: number;
  /** Whether anything goes beyond the row itself — what makes it worth a
   * confirmation, since only then is ticking the day again not an undo. */
  readonly cascades: boolean;
}

/**
 * What removing `eventId` from `group`'s zone would take, given that day's
 * shifts — `null` when the zone does not run on that day.
 */
export function dayRemoval(
  group: ZoneGroup,
  eventId: string,
  shifts: readonly { readonly location_id: string }[],
): DayRemoval | null {
  const placement = group.zone.placements.find(
    (candidate) => candidate.eventId === eventId,
  );
  if (placement === undefined) {
    return null;
  }

  const posts = group.posts.flatMap((post) => {
    const row = post.placements.find(
      (candidate) => candidate.eventId === eventId,
    );
    return row === undefined ? [] : [row];
  });
  const reached = new Set([
    placement.locationId,
    ...posts.map((row) => row.locationId),
  ]);
  const shiftCount = shifts.filter((shift) =>
    reached.has(shift.location_id),
  ).length;

  return {
    placement,
    postNames: posts.map((row) => row.name),
    shiftCount,
    cascades: posts.length > 0 || shiftCount > 0,
  };
}
