// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The festival's missions as a thing you can edit, rather than as a thing you
 * can read.
 *
 * `missions.ts` folds locations *and shifts* into the board's rows: it answers
 * "where is the hole?" and it deliberately drops a zone that is only a
 * container. This module folds the same `locations` rows for the other
 * question — "what posts does this production have, and what do they say?" —
 * so an empty zone is a mission here (a mission nobody has cut into shifts yet
 * is the normal state of a festival three weeks out) and every row carries the
 * `version` a write has to assert against.
 *
 * **One mission, several rows.** "Bar" is four `locations` rows because
 * Soundclash 26 runs a bar at the Open Air, at both club nights and at the
 * after, and the schema hangs a mission off an *event* (ADR-0032). Folding
 * them by name is the same honest mechanism `missions.ts` uses, with the same
 * limits — two different posts sharing a word become one, a typo splits one in
 * two — and the same mitigation: the days a mission runs on are always listed,
 * so a fold you did not intend is visible rather than silent.
 *
 * **Where the days disagree is part of the answer.** Open Air's bar is behind
 * the main stage and the club's bar is in the club, so `description` and
 * `address` genuinely differ per day. A fold that picked the first value and
 * called it the mission's would make the editor a machine for quietly
 * overwriting four addresses with one. `descriptionVaries` / `addressVaries`
 * say so instead, and the form refuses to send what it cannot show.
 *
 * Pure, except that `volunteerBoundsLabel` reads the interface language
 * through `t` when it is called. The fan-out that feeds it is
 * `api/usePlan.ts`; the writes that act on it are `api/useMissionWrites.ts`.
 */
import type { Event } from '../api/events';
import type { Post, Zone } from '../api/locations';
import { t } from '../i18n';

/** One event's worth of tree, as the server stores it. */
export interface CatalogSource {
  readonly event: Event;
  readonly zones: readonly Zone[];
}

/** A day of the production, named. Enough to label a chip and to key a write. */
export interface DayRef {
  readonly eventId: string;
  readonly eventName: string;
}

/** One event's row for a mission — what a write actually addresses. */
export interface MissionPlacement extends DayRef {
  readonly locationId: string;
  /** The optimistic-concurrency token. Every `PATCH`/`DELETE` sends it as
   * `If-Match` and `evp-api`'s `Precondition` extractor refuses a request
   * without one (docs/02 §7). */
  readonly version: number;
  readonly kind: 'zone' | 'post';
  /** The zone this post sits in, or `null` when the mission is a zone. Shown,
   * not editable: re-parenting moves everything beneath a row and there is no
   * endpoint that says so (`evp-db`'s `LocationPatch`). */
  readonly zoneName: string | null;
  /** As stored on *this* row, which is not always the mission's name — the
   * fold is case- and whitespace-insensitive. */
  readonly name: string;
  readonly description: string | null;
  readonly address: string | null;
  /** A postal address a map or courier can resolve. Zones only — `null` on a
   * post and on a zone with none given. */
  readonly exactAddress: string | null;
  /** `"<latitude>,<longitude>"`, decimal degrees, when both are set. Folded as
   * one string so it can share `agreed()`/`…Varies` with every other field
   * here rather than tracking two numbers that must always vary together. */
  readonly coordinates: string | null;
  /** How many volunteers the row can take, as decimal digits — strings for
   * the same reason `coordinates` is one, so the bounds fold through the same
   * `agreed()` as every other field. */
  readonly minVolunteers: string | null;
  readonly maxVolunteers: string | null;
  /**
   * How the volunteer form offers this mission — see migration
   * `…093000_locations_form_flags`. Zones only, so `null` on a post: the
   * server skips both keys there and the form folds the zone's values in, which
   * a placement claiming `true`/`false` of its own would misstate.
   */
  readonly checkedByDefault: boolean | null;
  readonly adultsOnly: boolean | null;
}

export interface Mission {
  /** The normalised name: what the rows have in common. */
  readonly key: string;
  /** The first day's spelling, which is the one the form shows. */
  readonly name: string;
  readonly placements: readonly MissionPlacement[];
  /**
   * The value every placement agrees on, `null` when none of them has one.
   * Meaningless — and not shown — when the matching `…Varies` flag is set.
   */
  readonly description: string | null;
  readonly address: string | null;
  readonly exactAddress: string | null;
  readonly coordinates: string | null;
  readonly minVolunteers: string | null;
  readonly maxVolunteers: string | null;
  readonly checkedByDefault: boolean | null;
  readonly adultsOnly: boolean | null;
  /** The days that run this mission do not say the same thing about it. */
  readonly descriptionVaries: boolean;
  readonly addressVaries: boolean;
  readonly exactAddressVaries: boolean;
  readonly coordinatesVaries: boolean;
  readonly minVolunteersVaries: boolean;
  readonly maxVolunteersVaries: boolean;
  readonly checkedByDefaultVaries: boolean;
  readonly adultsOnlyVaries: boolean;
  /** Days in scope with no row for this mission. Empty at event scope, and
   * the reason a festival-wide "add to the days that are missing it" is
   * offerable at all. */
  readonly missingFrom: readonly DayRef[];
}

export interface MissionCatalog {
  readonly missions: readonly Mission[];
  /** Every day in scope, in the order the day strip shows them. */
  readonly days: readonly DayRef[];
}

/** Plain `toLowerCase`, not `toLocaleLowerCase`: the latter reads the host's
 * default locale, which is the same ambient dependency `time/clock.ts` exists
 * to keep out of pure code. */
export function missionKey(name: string): string {
  return name.trim().toLowerCase();
}

/** The wire omits an absent field; everything downstream of here wants one
 * spelling of "nothing said", and `null` is it. */
function stored(value: string | undefined): string | null {
  return value ?? null;
}

interface Draft {
  readonly key: string;
  name: string;
  readonly placements: MissionPlacement[];
}

function countOf(value: number | undefined): string | null {
  return value === undefined ? null : String(value);
}

/** `"<latitude>,<longitude>"`, or `null` when either is absent — a zone with
 * no map data, or any post (the API never sets these on one). */
function coordinatesOf(row: Post): string | null {
  return row.latitude === undefined || row.longitude === undefined
    ? null
    : `${String(row.latitude)},${String(row.longitude)}`;
}

function placementOf(
  row: Post,
  event: Event,
  kind: 'zone' | 'post',
  zoneName: string | null,
): MissionPlacement {
  return {
    eventId: event.id,
    eventName: event.name,
    locationId: row.id,
    version: row.version,
    kind,
    zoneName,
    name: row.name,
    description: stored(row.description),
    address: stored(row.address),
    exactAddress: stored(row.exact_address),
    coordinates: coordinatesOf(row),
    minVolunteers: countOf(row.min_volunteers),
    maxVolunteers: countOf(row.max_volunteers),
    // The server's defaults stand in for an absent key on a zone, so a zone
    // read from an older payload does not fold as disagreeing with one that
    // spelled the same defaults out.
    checkedByDefault: kind === 'zone' ? (row.checked_by_default ?? true) : null,
    adultsOnly: kind === 'zone' ? (row.adults_only ?? false) : null,
  };
}

/**
 * What the days agree on.
 *
 * Absent everywhere and present-but-different are two answers, not one: the
 * first is a field waiting to be filled, the second is a field that must not
 * be overwritten by a form showing a single box. `null` with `varies: false`
 * is the first.
 */
function agreed<T extends string | boolean>(
  values: readonly (T | null)[],
): {
  value: T | null;
  varies: boolean;
} {
  const first = values[0] ?? null;
  const varies = values.some((value) => value !== first);
  return { value: varies ? null : first, varies };
}

/**
 * Folds every day's zone/post tree into the production's missions.
 *
 * `sources` is expected in the order the page shows its days — chronological,
 * as `scope.ts` sorts them — and that order is preserved in each mission's
 * `placements`, so a mission reads as the sequence of days it runs on.
 */
export function buildMissionCatalog(
  sources: readonly CatalogSource[],
): MissionCatalog {
  const drafts = new Map<string, Draft>();
  const days: DayRef[] = sources.map((source) => ({
    eventId: source.event.id,
    eventName: source.event.name,
  }));

  const add = (
    row: Post,
    event: Event,
    kind: 'zone' | 'post',
    zoneName: string | null,
  ): void => {
    const key = missionKey(row.name);
    const draft = drafts.get(key) ?? { key, name: row.name, placements: [] };
    draft.placements.push(placementOf(row, event, kind, zoneName));
    drafts.set(key, draft);
  };

  for (const source of sources) {
    for (const zone of source.zones) {
      // A zone is a mission in its own right here even when it holds posts.
      // The board drops that case because a container with no shifts is not a
      // row worth drawing; this is the page where somebody named the zone, and
      // a zone that cannot be renamed or deleted from the missions page is a
      // zone that can only be reached through psql.
      add(zone, source.event, 'zone', null);
      for (const post of zone.posts) {
        add(post, source.event, 'post', zone.name);
      }
    }
  }

  const missions = [...drafts.values()]
    .map((draft): Mission => {
      const description = agreed(
        draft.placements.map((placement) => placement.description),
      );
      const address = agreed(
        draft.placements.map((placement) => placement.address),
      );
      const exactAddress = agreed(
        draft.placements.map((placement) => placement.exactAddress),
      );
      const coordinates = agreed(
        draft.placements.map((placement) => placement.coordinates),
      );
      const minVolunteers = agreed(
        draft.placements.map((placement) => placement.minVolunteers),
      );
      const maxVolunteers = agreed(
        draft.placements.map((placement) => placement.maxVolunteers),
      );
      const checkedByDefault = agreed(
        draft.placements.map((placement) => placement.checkedByDefault),
      );
      const adultsOnly = agreed(
        draft.placements.map((placement) => placement.adultsOnly),
      );
      const present = new Set(
        draft.placements.map((placement) => placement.eventId),
      );

      return {
        key: draft.key,
        name: draft.name,
        placements: draft.placements,
        description: description.value,
        address: address.value,
        exactAddress: exactAddress.value,
        coordinates: coordinates.value,
        minVolunteers: minVolunteers.value,
        maxVolunteers: maxVolunteers.value,
        checkedByDefault: checkedByDefault.value,
        adultsOnly: adultsOnly.value,
        descriptionVaries: description.varies,
        addressVaries: address.varies,
        exactAddressVaries: exactAddress.varies,
        coordinatesVaries: coordinates.varies,
        minVolunteersVaries: minVolunteers.varies,
        maxVolunteersVaries: maxVolunteers.varies,
        checkedByDefaultVaries: checkedByDefault.varies,
        adultsOnlyVaries: adultsOnly.varies,
        missingFrom: days.filter((day) => !present.has(day.eventId)),
      };
    })
    // Compared on the normalised key rather than through `localeCompare`,
    // which reads the host's default locale when none is passed — the sort a
    // test sees must not depend on the machine it runs on (docs/13 §8).
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return { missions, days };
}

/**
 * Is this name already a mission here?
 *
 * Asked before a create, so the form can say "there is already a Bar" instead
 * of letting the server say it once per day — the fan-out would otherwise turn
 * one duplicate into six identical `409`s, five of which are noise.
 */
export function missionExists(catalog: MissionCatalog, name: string): boolean {
  const key = missionKey(name);
  return catalog.missions.some((mission) => mission.key === key);
}

/**
 * Zone or post, for a mission that already folded every placement's own
 * `kind` away.
 *
 * `placements[0]` rather than a vote: every row `add()` puts into one draft
 * came from the same fold key, and in practice that means the same `kind` —
 * a zone and a post do not usually share a name. When they do (two unrelated
 * rows sharing a typo), this reads as whichever placement sorted first, which
 * is the same "visible, not hidden" trade-off the name fold itself already
 * makes.
 */
export function missionKind(mission: Mission): 'zone' | 'post' {
  return mission.placements[0]?.kind === 'post' ? 'post' : 'zone';
}

/**
 * The zone a post's placements agree it sits in, normalised — or `null` when
 * they do not agree, which `groupByZone` treats as "cannot place this post
 * under a card with confidence" rather than guessing.
 */
function zoneKeyOf(mission: Mission): string | null {
  const names = new Set(
    mission.placements.map((placement) => placement.zoneName),
  );
  const only = [...names][0];
  return names.size === 1 && only !== null && only !== undefined
    ? missionKey(only)
    : null;
}

/** One zone, with the posts folded underneath it. */
export interface ZoneGroup {
  readonly zone: Mission;
  readonly posts: readonly Mission[];
}

export interface GroupedMissions {
  readonly zones: readonly ZoneGroup[];
  /**
   * A post that could not be placed under a zone card — its zone is missing
   * from this catalog, or its placements disagree about which zone it is in.
   * Both should be rare (the zone's own row is deleted or the fold has
   * collided two different posts under one name) and both are shown flat
   * rather than dropped, because a card that vanished on a rename is worse
   * than a card in the wrong place.
   */
  readonly orphans: readonly Mission[];
}

/**
 * Reassembles the flat fold back into the tree the database actually has —
 * `buildMissionCatalog` cannot do this itself, because a post's zone might
 * still be loading on one day and already folded on another, and the caller
 * is where "which zone" and "is it still there" are both known.
 */
export function groupByZone(missions: readonly Mission[]): GroupedMissions {
  const zones = missions.filter((mission) => missionKind(mission) === 'zone');
  const posts = missions.filter((mission) => missionKind(mission) === 'post');

  const postsByZoneKey = new Map<string, Mission[]>(
    zones.map((zone) => [zone.key, []]),
  );
  const orphans: Mission[] = [];

  for (const post of posts) {
    const zoneKey = zoneKeyOf(post);
    const bucket = zoneKey === null ? undefined : postsByZoneKey.get(zoneKey);
    if (bucket === undefined) {
      orphans.push(post);
    } else {
      bucket.push(post);
    }
  }

  return {
    zones: zones.map((zone) => ({
      zone,
      posts: postsByZoneKey.get(zone.key) ?? [],
    })),
    orphans,
  };
}

/**
 * The volunteer bounds as the collapsed card states them — "2–5 volunteers",
 * "at least 2", "up to 5" — in the interface language, or `null` when
 * neither is set, so the card says nothing rather than "0–∞".
 *
 * A bound the days disagree about makes the whole reading "varies": half a
 * range next to a hidden disagreement would read as the rule for every day.
 */
export function volunteerBoundsLabel(mission: Mission): string | null {
  if (mission.minVolunteersVaries || mission.maxVolunteersVaries) {
    return t('missions.bounds.varies');
  }
  // The bounds are folded as digit strings (see `MissionPlacement`); a plural
  // needs the number back to pick its category.
  const min =
    mission.minVolunteers === null ? null : Number(mission.minVolunteers);
  const max =
    mission.maxVolunteers === null ? null : Number(mission.maxVolunteers);
  if (min !== null && max !== null) {
    return min === max
      ? t('missions.bounds.exactly', { count: max })
      : t('missions.bounds.range', { min, max });
  }
  if (min !== null) {
    return t('missions.bounds.atLeast', { min });
  }
  if (max !== null) {
    return t('missions.bounds.upTo', { max });
  }
  return null;
}
