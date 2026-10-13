// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The queries behind the one detail page, and the scope they resolve to.
 *
 * Two URLs reach the same page — `/festivals/{id}` is the whole production,
 * `/events/{id}` is one day of it — so the resolution runs in both directions
 * here rather than in either view: the festival URL loads the festival and
 * its inlined days, the event URL loads the day and then the festival that
 * day belongs to, and both end up at a `PlanScope` (`plan/scope.ts`).
 *
 * Missions are fetched for the *whole* festival at either scope, one request
 * pair per day. That is the point of the merge — "is the bar staffed?" is a
 * festival question and the server only answers it per event (ADR-0032) — and
 * it is affordable because every request is keyed exactly as the per-event
 * hooks key it (`useLocations` / `useShifts`). A coordinator who opens the
 * festival and then clicks through its six days makes those requests once,
 * not seven times.
 */
import { useQueries } from '@tanstack/vue-query';
import {
  computed,
  toValue,
  type ComputedRef,
  type MaybeRefOrGetter,
} from 'vue';

import type { Event } from './events';
import { fetchLocations } from './locations';
import { fetchShifts } from './shifts';
import { useEvent } from './useEvents';
import { useFestival } from './useFestivals';
import { locationsQueryKey } from './useLocations';
import { shiftsQueryKey } from './useShifts';
import {
  buildMissionCatalog,
  type CatalogSource,
  type MissionCatalog,
} from '../plan/missionCatalog';
import {
  buildMissionBoard,
  volunteerBounds,
  type MissionBoard,
  type MissionSource,
  type VolunteerBounds,
} from '../plan/missions';
import { eventScope, festivalScope, type PlanScope } from '../plan/scope';

export interface PlanScopeQuery {
  /** `null` until it resolves, and `null` again if it cannot. */
  readonly scope: ComputedRef<PlanScope | null>;
  readonly isPending: ComputedRef<boolean>;
  /** What the URL named could not be loaded: there is no page to render. */
  readonly subjectFailed: ComputedRef<boolean>;
  /**
   * The day loaded but the festival around it did not. The page still works,
   * narrowed to that one day, and says so — the same degradation
   * `EventsView` makes when the festivals list fails under a list of events
   * that did load.
   */
  readonly festivalFailed: ComputedRef<boolean>;
}

/**
 * Resolves whichever of the two URLs was taken.
 *
 * Both params come straight off the route, so exactly one of them is
 * non-empty; an empty string means "this URL did not name one", which is what
 * gates each query rather than a second boolean the caller could get wrong.
 */
export function usePlanScope(
  orgId: MaybeRefOrGetter<string>,
  festivalId: MaybeRefOrGetter<string>,
  eventId: MaybeRefOrGetter<string>,
): PlanScopeQuery {
  const wantsEvent = computed(() => toValue(eventId) !== '');

  const { data: eventResult } = useEvent(orgId, eventId, {
    enabled: wantsEvent,
  });

  const loadedEvent = computed(() =>
    eventResult.value?.ok === true ? eventResult.value.value : null,
  );

  /** The festival to load: the one the URL named, or the one the day it named
   * belongs to. Reaching a day is reaching the production it is part of. */
  const wantedFestivalId = computed(() => {
    const named = toValue(festivalId);
    return named === '' ? (loadedEvent.value?.festival_id ?? '') : named;
  });

  const { data: festivalResult } = useFestival(orgId, wantedFestivalId, {
    enabled: computed(() => wantedFestivalId.value !== ''),
  });

  const loadedFestival = computed(() =>
    festivalResult.value?.ok === true ? festivalResult.value.value : null,
  );

  /**
   * Settled, not `isPending`: a disabled query reports itself as pending
   * forever, and the festival query is disabled right up until the event it
   * depends on has answered. "Has this query produced a result yet" is the
   * question actually being asked, and `data === undefined` is it.
   */
  const settled = computed(() => {
    if (wantsEvent.value && eventResult.value === undefined) {
      return false;
    }
    return wantedFestivalId.value === '' || festivalResult.value !== undefined;
  });

  const scope = computed<PlanScope | null>(() => {
    if (!settled.value) {
      return null;
    }
    if (wantsEvent.value) {
      const event = loadedEvent.value;
      return event === null ? null : eventScope(event, loadedFestival.value);
    }
    const festival = loadedFestival.value;
    return festival === null ? null : festivalScope(festival);
  });

  return {
    scope,
    isPending: computed(() => !settled.value),
    subjectFailed: computed(() => settled.value && scope.value === null),
    festivalFailed: computed(
      () =>
        settled.value &&
        wantsEvent.value &&
        wantedFestivalId.value !== '' &&
        loadedFestival.value === null,
    ),
  };
}

export interface MissionBoardQuery {
  readonly board: ComputedRef<MissionBoard>;
  /** Each location's own min/max volunteers, keyed by location id — what the
   * assignation board staffs a slot against. */
  readonly bounds: ComputedRef<ReadonlyMap<string, VolunteerBounds>>;
  readonly isPending: ComputedRef<boolean>;
  readonly locationsFailed: ComputedRef<boolean>;
  readonly shiftsFailed: ComputedRef<boolean>;
}

/**
 * Every day's locations and shifts, folded into the festival's missions.
 *
 * A failed day contributes nothing rather than failing the board: five days
 * of missions with a warning above them is more use than an error page, and
 * the two flags are what the view says that with.
 */
export function useMissionBoard(
  orgId: MaybeRefOrGetter<string>,
  events: MaybeRefOrGetter<readonly Event[]>,
): MissionBoardQuery {
  const locationQueries = useQueries({
    queries: computed(() =>
      toValue(events).map((event) => ({
        queryKey: locationsQueryKey(toValue(orgId), event.id),
        queryFn: async ({ signal }: { signal: AbortSignal }) =>
          fetchLocations(toValue(orgId), event.id, signal),
      })),
    ),
  });

  const shiftQueries = useQueries({
    queries: computed(() =>
      toValue(events).map((event) => ({
        queryKey: shiftsQueryKey(toValue(orgId), event.id),
        queryFn: async ({ signal }: { signal: AbortSignal }) =>
          fetchShifts(toValue(orgId), event.id, signal),
      })),
    ),
  });

  // `useQueries` answers in the order it was asked, which is the order of
  // `events` — that positional pairing is the whole reason the two fan-outs
  // can be zipped back together without a second lookup by id.
  const sources = computed<readonly MissionSource[]>(() =>
    toValue(events).map((event, index) => {
      const zones = locationQueries.value[index]?.data;
      const shifts = shiftQueries.value[index]?.data;
      return {
        event,
        zones: zones?.ok === true ? zones.value : [],
        shifts: shifts?.ok === true ? shifts.value : [],
      };
    }),
  );

  return {
    board: computed(() => buildMissionBoard(sources.value)),
    bounds: computed(() => volunteerBounds(sources.value)),
    isPending: computed(() =>
      toValue(events).some(
        (_, index) =>
          locationQueries.value[index]?.data === undefined ||
          shiftQueries.value[index]?.data === undefined,
      ),
    ),
    locationsFailed: computed(() =>
      locationQueries.value.some((query) => query.data?.ok === false),
    ),
    shiftsFailed: computed(() =>
      shiftQueries.value.some((query) => query.data?.ok === false),
    ),
  };
}

export interface MissionCatalogQuery {
  readonly catalog: ComputedRef<MissionCatalog>;
  readonly isPending: ComputedRef<boolean>;
  readonly locationsFailed: ComputedRef<boolean>;
}

/**
 * Every day's zone/post tree, folded into the production's missions.
 *
 * The locations half of [`useMissionBoard`] on its own, because the missions
 * section has no use for shifts: it edits the rows, and a page that waited for
 * six days of shifts before it could show six names would be slow for no
 * reason. Keyed identically to [`useMissionBoard`]'s locations fan-out and to
 * `useLocations`, so a coordinator moving between the two sections re-reads
 * nothing.
 *
 * A failed day contributes nothing rather than failing the catalog — same
 * degradation, and the same reason: five days of missions under a warning is
 * more use than an error page. The flag is how the view says so, and it
 * matters more here than on the board, because a day whose tree did not load
 * looks exactly like a day that does not run a mission.
 */
export function useMissionCatalog(
  orgId: MaybeRefOrGetter<string>,
  events: MaybeRefOrGetter<readonly Event[]>,
): MissionCatalogQuery {
  const locationQueries = useQueries({
    queries: computed(() =>
      toValue(events).map((event) => ({
        queryKey: locationsQueryKey(toValue(orgId), event.id),
        queryFn: async ({ signal }: { signal: AbortSignal }) =>
          fetchLocations(toValue(orgId), event.id, signal),
      })),
    ),
  });

  // Positional, like `useMissionBoard`'s zip: `useQueries` answers in the
  // order it was asked, which is the order of `events`.
  const sources = computed<readonly CatalogSource[]>(() =>
    toValue(events).map((event, index) => {
      const zones = locationQueries.value[index]?.data;
      return { event, zones: zones?.ok === true ? zones.value : [] };
    }),
  );

  return {
    catalog: computed(() => buildMissionCatalog(sources.value)),
    isPending: computed(() =>
      toValue(events).some(
        (_, index) => locationQueries.value[index]?.data === undefined,
      ),
    ),
    locationsFailed: computed(() =>
      locationQueries.value.some((query) => query.data?.ok === false),
    ),
  };
}
