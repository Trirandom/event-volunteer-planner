// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The festival's missions, assembled out of the events that store them.
 *
 * "Bar" is one mission. Soundclash 26 runs it at the Open Air, at both club
 * nights and at the after, and the schema records that as four `locations`
 * rows — one per event — because those four are staffed, scheduled and
 * reported on independently (ADR-0032). A coordinator planning the festival
 * means the one; a coordinator working Saturday means Saturday's row. This
 * module is the single place the four become one, keyed by the name a
 * coordinator typed, so both readings come off the same rows without the
 * database storing either of them twice.
 *
 * Matching on the name is the honest mechanism and its limits are real: two
 * genuinely different posts that happen to share a word are folded together,
 * and a typo splits one mission in two. Both are visible in the result — the
 * per-day breakdown is always shown — which is why this is the right trade
 * against the alternative of asking a coordinator to maintain a festival-wide
 * mission table by hand.
 *
 * Pure. The fan-out that feeds it is `api/usePlan.ts`.
 */
import { Temporal } from '@evp/shared/time';

import type { Event } from '../api/events';
import type { Zone } from '../api/locations';
import type { Shift } from '../api/shifts';

/** One event's worth of what the server stores against it. */
export interface MissionSource {
  readonly event: Event;
  readonly zones: readonly Zone[];
  readonly shifts: readonly Shift[];
}

export interface MissionShift {
  readonly id: string;
  /** The optimistic-concurrency token. Carried down because the board writes:
   * every `PATCH`/`DELETE` on a shift sends `If-Match` (docs/02 §7), and the
   * `Precondition` extractor refuses a request without one. */
  readonly version: number;
  readonly eventId: string;
  readonly eventName: string;
  /** The location the shift is worked at. Already known from the occupied
   * occurrence, and repeated here because an *unplaced* shift has no
   * occurrence to be read from and still has to name where it was scheduled. */
  readonly locationId: string;
  /** The event's own IANA zone. A shift row carries none, and the viewer's
   * browser zone is the one zone this application must never render in
   * (docs/16 §1), so it is carried down here rather than looked up later. */
  readonly timezone: string;
  readonly title: string;
  readonly period: { readonly start: string; readonly end: string };
  readonly requiredCount: number;
  readonly maxCount: number | null;
}

/** One event's instance of a mission — the row the schema actually stores. */
export interface MissionOccurrence {
  readonly eventId: string;
  readonly eventName: string;
  readonly locationId: string;
  /** The zone the post sits in, or `null` when the mission is a zone itself. */
  readonly zoneName: string | null;
  readonly shifts: readonly MissionShift[];
  readonly requiredTotal: number;
}

export interface Mission {
  /** The normalised name: what four independent rows have in common. */
  readonly key: string;
  readonly name: string;
  readonly occurrences: readonly MissionOccurrence[];
  readonly shiftCount: number;
  readonly requiredTotal: number;
  /**
   * Days of the festival that run this mission but are not in view. Always 0
   * on the festival-wide reading, where every day is in view; it is what
   * stops the narrowed reading from hiding that "Bar" is a festival-wide
   * decision and not a Saturday one.
   */
  readonly alsoAtDays: number;
}

export interface MissionBoard {
  readonly missions: readonly Mission[];
  /**
   * Shifts on a location no event's tree mentions. Shown rather than
   * dropped: the locations query can fail while the shifts one succeeds, and
   * hiding work that still has to be staffed is the worse failure —
   * `agenda.ts` takes the same line on an event whose festival is missing.
   */
  readonly unplacedShifts: readonly MissionShift[];
}

/** A location a shift can be put on, flattened out of the zone/post tree. */
interface LocationEntry {
  readonly id: string;
  readonly name: string;
  readonly zoneName: string | null;
  /** A zone that has posts is a container. It is not a mission of its own
   * unless a shift lands on it directly, which the schema permits. */
  readonly isContainer: boolean;
}

interface MissionDraft {
  readonly key: string;
  name: string;
  readonly occurrences: MissionOccurrence[];
}

/** Plain `toLowerCase`, not `toLocaleLowerCase`: the latter reads the host's
 * default locale, which is the same ambient dependency `time/clock.ts` exists
 * to keep out of pure code. */
function normalise(name: string): string {
  return name.trim().toLowerCase();
}

function startsAt(period: { readonly start: string }): number {
  return Temporal.Instant.from(period.start).epochMilliseconds;
}

function indexLocations(zones: readonly Zone[]): Map<string, LocationEntry> {
  const index = new Map<string, LocationEntry>();
  for (const zone of zones) {
    index.set(zone.id, {
      id: zone.id,
      name: zone.name,
      zoneName: null,
      isContainer: zone.posts.length > 0,
    });
    for (const post of zone.posts) {
      index.set(post.id, {
        id: post.id,
        name: post.name,
        zoneName: zone.name,
        isContainer: false,
      });
    }
  }
  return index;
}

/** What a mission's own row says about how many people it takes — the
 * standing answer a coordinator types once, as opposed to the per-shift count
 * a slot was cut with (migration `…120000_locations_volunteer_bounds`). */
export interface VolunteerBounds {
  readonly min: number | null;
  readonly max: number | null;
}

/**
 * Every location's bounds, keyed by location id.
 *
 * A post's bounds are its own and never its zone's: the migration is explicit
 * that a zone's floor is a statement about the whole area, not a default for
 * each post in it, so a post with nothing said stays at nothing said.
 */
export function volunteerBounds(
  sources: readonly { readonly zones: readonly Zone[] }[],
): ReadonlyMap<string, VolunteerBounds> {
  const bounds = new Map<string, VolunteerBounds>();
  for (const { zones } of sources) {
    for (const row of zones.flatMap((zone) => [zone, ...zone.posts])) {
      bounds.set(row.id, {
        min: row.min_volunteers ?? null,
        max: row.max_volunteers ?? null,
      });
    }
  }
  return bounds;
}

function missionShift(shift: Shift, event: Event, title: string): MissionShift {
  return {
    id: shift.id,
    version: shift.version,
    eventId: event.id,
    eventName: event.name,
    locationId: shift.location_id,
    timezone: event.timezone,
    title,
    period: shift.period,
    requiredCount: shift.required_count,
    maxCount: shift.max_count ?? null,
  };
}

function totalRequired(shifts: readonly MissionShift[]): number {
  return shifts.reduce((total, shift) => total + shift.requiredCount, 0);
}

/**
 * Folds every day's locations and shifts into the festival's missions.
 *
 * `sources` is expected in the order the page shows its days — chronological,
 * as `scope.ts` sorts them — and that order is preserved in each mission's
 * `occurrences`, so a mission reads as the sequence of days it runs on.
 */
export function buildMissionBoard(
  sources: readonly MissionSource[],
): MissionBoard {
  const drafts = new Map<string, MissionDraft>();
  const unplacedShifts: MissionShift[] = [];

  for (const source of sources) {
    const locations = indexLocations(source.zones);
    const byLocation = new Map<string, MissionShift[]>();

    for (const shift of source.shifts) {
      const entry = locations.get(shift.location_id);
      if (entry === undefined) {
        // The id itself is the only name there is when the tree is missing;
        // a coordinator who sees it can at least say which shift is meant.
        unplacedShifts.push(
          missionShift(shift, source.event, shift.title ?? shift.location_id),
        );
        continue;
      }

      const line = missionShift(shift, source.event, shift.title ?? entry.name);
      const existing = byLocation.get(entry.id);
      if (existing === undefined) {
        byLocation.set(entry.id, [line]);
      } else {
        existing.push(line);
      }
    }

    for (const entry of locations.values()) {
      const shifts = byLocation.get(entry.id) ?? [];
      if (entry.isContainer && shifts.length === 0) {
        continue;
      }

      const key = normalise(entry.name);
      const draft = drafts.get(key) ?? {
        key,
        name: entry.name,
        occurrences: [],
      };
      draft.occurrences.push({
        eventId: source.event.id,
        eventName: source.event.name,
        locationId: entry.id,
        zoneName: entry.zoneName,
        shifts: [...shifts].sort(
          (a, b) => startsAt(a.period) - startsAt(b.period),
        ),
        requiredTotal: totalRequired(shifts),
      });
      drafts.set(key, draft);
    }
  }

  const missions = [...drafts.values()]
    .map((draft): Mission => ({
      key: draft.key,
      name: draft.name,
      occurrences: draft.occurrences,
      shiftCount: draft.occurrences.reduce(
        (total, occurrence) => total + occurrence.shifts.length,
        0,
      ),
      requiredTotal: draft.occurrences.reduce(
        (total, occurrence) => total + occurrence.requiredTotal,
        0,
      ),
      alsoAtDays: 0,
    }))
    // Compared on the normalised key rather than through `localeCompare`,
    // which reads the host's default locale when none is passed — the sort a
    // test sees must not depend on the machine it runs on (docs/13 §8).
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return { missions, unplacedShifts };
}

/**
 * The same board read from one day of the festival.
 *
 * Each mission keeps a count of the festival's *other* days that run it,
 * because that is precisely what a day-at-a-time view otherwise hides:
 * Saturday's bar is not a Saturday decision, it is the festival's bar, and a
 * coordinator about to change it should see that four other days say the same
 * word.
 */
export function narrowToEvent(
  board: MissionBoard,
  eventId: string,
): MissionBoard {
  const missions = board.missions.flatMap((mission): Mission[] => {
    const here = mission.occurrences.filter(
      (occurrence) => occurrence.eventId === eventId,
    );
    if (here.length === 0) {
      return [];
    }

    const elsewhere = new Set(
      mission.occurrences
        .filter((occurrence) => occurrence.eventId !== eventId)
        .map((occurrence) => occurrence.eventId),
    );

    return [
      {
        key: mission.key,
        name: mission.name,
        occurrences: here,
        shiftCount: here.reduce(
          (total, occurrence) => total + occurrence.shifts.length,
          0,
        ),
        requiredTotal: here.reduce(
          (total, occurrence) => total + occurrence.requiredTotal,
          0,
        ),
        alsoAtDays: elsewhere.size,
      },
    ];
  });

  return {
    missions,
    unplacedShifts: board.unplacedShifts.filter(
      (shift) => shift.eventId === eventId,
    ),
  };
}
