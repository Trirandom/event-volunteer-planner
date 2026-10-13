// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * Editing a mission, which is editing one `locations` row per day it runs on.
 *
 * A coordinator adding "Bar" to Soundclash 26 means the bar the whole
 * production runs, and the schema records that as four rows because the four
 * are staffed independently (ADR-0032). This module is the fan-out that keeps
 * both readings true: one gesture, N requests, and an outcome that names every
 * day the gesture did not reach.
 *
 * **Concurrent, and it does not stop at the first refusal** — the opposite of
 * `useShiftWrites.ts`, and for the stated reason. A drag's operations are
 * dependent on each other (its deletes make room for its creates) and share a
 * row version, so they have to be sequential. These are docs/04's *independent
 * items* (ADR-0024): "Bar at the Open Air" and "Bar at the after" are different
 * rows on different events, one can be refused for a duplicate name without
 * saying anything about the other, and stopping early would leave the fan-out's
 * reach depending on the order the days happen to be in.
 *
 * **A partial result is reported, never hidden.** Four days written and two
 * refused is a real state of the database, and a coordinator is owed the names
 * of the two. That is the same line `applyShiftOps` takes with its `applied`
 * count.
 */
import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from '@tanstack/vue-query';
import { toValue, type MaybeRefOrGetter } from 'vue';

import {
  createLocation,
  deleteLocation,
  patchLocation,
  type LocationChanges,
  type LocationWriteRejection,
} from './locations';
import { locationsQueryKey } from './useLocations';
import { shiftsQueryKey } from './useShifts';
import { t } from '../i18n';
import type { DayRef, MissionPlacement } from '../plan/missionCatalog';

/** One day the fan-out did not reach, and why. */
export interface DayRefusal extends DayRef {
  readonly rejection: LocationWriteRejection;
}

export interface FanOutOutcome {
  /** Days the write landed on. */
  readonly applied: number;
  /** Days it did not, named. Empty on a clean run. */
  readonly refusals: readonly DayRefusal[];
}

/**
 * Runs one write per day and collects the refusals.
 *
 * `Promise.all` over a mapper that cannot reject: every call in this module
 * returns its failure as a value (`api/http.ts`), so there is no path where one
 * day's `409` discards the other five results.
 */
async function fanOut<T extends DayRef>(
  targets: readonly T[],
  write: (
    target: T,
  ) => Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly rejection: LocationWriteRejection }
  >,
): Promise<FanOutOutcome> {
  const results = await Promise.all(
    targets.map(async (target) => ({ target, result: await write(target) })),
  );

  const refusals = results.flatMap(({ target, result }): DayRefusal[] =>
    result.ok
      ? []
      : [
          {
            eventId: target.eventId,
            eventName: target.eventName,
            rejection: result.rejection,
          },
        ],
  );

  return { applied: results.length - refusals.length, refusals };
}

/**
 * The refused days, each with its reason, as the list every form that fans
 * out ends its refusal message with.
 *
 * The days are named rather than counted because the remedy differs per day —
 * a `409` on Saturday means somebody else edited Saturday's row, and a
 * coordinator cannot act on "two days failed". The server's `detail` is shown
 * as given (docs/02 §7): a location refusal carries no code finer than
 * `reason`, and the detail is what says which of a conflict's two causes it
 * was.
 */
export function refusedDaysText(outcome: FanOutOutcome): string {
  return outcome.refusals
    .map((refused) =>
      refused.rejection.reason === 'unavailable'
        ? t('missions.refusal.dayUnreachable', { day: refused.eventName })
        : t('missions.refusal.day', {
            day: refused.eventName,
            detail: refused.rejection.detail,
          }),
    )
    .join(t('missions.refusal.separator'));
}

/**
 * Re-reads the trees the write touched.
 *
 * Shifts go too, but only for a delete: `ON DELETE CASCADE` takes a location's
 * shifts with it, so the board's rows for that day are stale in a way no
 * locations query would reveal. A rename or a new briefing moves no shift, and
 * invalidating them there would refetch a day's board on every keystroke's
 * worth of saved text.
 */
async function reread(
  queryClient: QueryClient,
  orgId: string,
  days: readonly DayRef[],
  alsoShifts: boolean,
): Promise<void> {
  const eventIds = [...new Set(days.map((day) => day.eventId))];

  await Promise.all([
    ...eventIds.map(async (eventId) =>
      queryClient.invalidateQueries({
        queryKey: locationsQueryKey(orgId, eventId),
      }),
    ),
    ...(alsoShifts
      ? eventIds.map(async (eventId) =>
          queryClient.invalidateQueries({
            queryKey: shiftsQueryKey(orgId, eventId),
          }),
        )
      : []),
  ]);
}

/** The two bounds, spread into a create body only when stated — the same
 * absent-not-undefined rule as every other optional key here. Shared by both
 * levels of the tree: a zone and a post are each staffed. */
function volunteerBounds(input: {
  readonly minVolunteers?: number;
  readonly maxVolunteers?: number;
}): { minVolunteers?: number; maxVolunteers?: number } {
  return {
    ...(input.minVolunteers === undefined
      ? {}
      : { minVolunteers: input.minVolunteers }),
    ...(input.maxVolunteers === undefined
      ? {}
      : { maxVolunteers: input.maxVolunteers }),
  };
}

export interface NewMission {
  readonly name: string;
  /** Already trimmed, and absent rather than empty: the server reads `""` as
   * "nothing said" anyway, but sending the two spellings interchangeably is
   * how a client ends up depending on which one it sent. */
  readonly description?: string;
  readonly address?: string;
  readonly exactAddress?: string;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly minVolunteers?: number;
  readonly maxVolunteers?: number;
  /** Zone-only, like `exactAddress` — which this always is (see below). */
  readonly checkedByDefault?: boolean;
  readonly adultsOnly?: boolean;
  /** The days to create it on — every day in scope, or just the ones missing
   * it. The caller decides which; this only writes. */
  readonly days: readonly DayRef[];
}

/**
 * `POST …/locations` once per day.
 *
 * Created as a **zone**, which is to say a top-level mission: a coordinator
 * saying "we need a bar" from this form is naming a new area, not filing it
 * under a zone they have not been asked about. A post nested under an
 * existing zone is a separate, smaller gesture — [`useCreatePost`] — because
 * it only ever has one sensible parent, the zone the coordinator is already
 * looking at.
 */
export function useCreateMission(orgId: MaybeRefOrGetter<string>) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: NewMission) =>
      fanOut(input.days, async (day) =>
        createLocation(toValue(orgId), day.eventId, {
          kind: 'zone',
          name: input.name,
          ...(input.description === undefined
            ? {}
            : { description: input.description }),
          ...(input.address === undefined ? {} : { address: input.address }),
          ...(input.exactAddress === undefined
            ? {}
            : { exactAddress: input.exactAddress }),
          ...(input.latitude === undefined ? {} : { latitude: input.latitude }),
          ...(input.longitude === undefined
            ? {}
            : { longitude: input.longitude }),
          ...volunteerBounds(input),
          ...(input.checkedByDefault === undefined
            ? {}
            : { checkedByDefault: input.checkedByDefault }),
          ...(input.adultsOnly === undefined
            ? {}
            : { adultsOnly: input.adultsOnly }),
        }),
      ),
    // `onSettled`, not `onSuccess`: a fan-out that refused four days out of six
    // still wrote two, and a cache left holding the old tree would show the
    // coordinator a mission that exists as one that does not.
    onSettled: async (_data, _error, input) => {
      await reread(queryClient, toValue(orgId), input.days, false);
    },
  });
}

export interface NewPost {
  readonly name: string;
  readonly description?: string;
  readonly address?: string;
  readonly minVolunteers?: number;
  readonly maxVolunteers?: number;
  /**
   * The zone's own placements — one per day it runs on — not `days` from the
   * page's scope. A post's `parent_id` has to name a zone row of the *same
   * event* (docs/03 §3.4's per-event FK), so the only days a post can be
   * created on are the ones where the zone itself already has a row; a day
   * missing the zone has nothing for the post to be filed under.
   */
  readonly zonePlacements: readonly MissionPlacement[];
}

/**
 * `POST …/locations` once per day the zone runs on, each pointed at that
 * day's own zone row.
 */
export function useCreatePost(orgId: MaybeRefOrGetter<string>) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: NewPost) =>
      fanOut(input.zonePlacements, async (placement) =>
        createLocation(toValue(orgId), placement.eventId, {
          kind: 'post',
          name: input.name,
          parentId: placement.locationId,
          ...(input.description === undefined
            ? {}
            : { description: input.description }),
          ...(input.address === undefined ? {} : { address: input.address }),
          ...volunteerBounds(input),
        }),
      ),
    onSettled: async (_data, _error, input) => {
      await reread(queryClient, toValue(orgId), input.zonePlacements, false);
    },
  });
}

export interface MissionEdit {
  readonly placements: readonly MissionPlacement[];
  readonly changes: LocationChanges;
}

/** `PATCH …/locations/{id}` once per placement, each asserting its own row's
 * version. */
export function useUpdateMission(orgId: MaybeRefOrGetter<string>) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: MissionEdit) =>
      fanOut(input.placements, async (placement) =>
        patchLocation(
          toValue(orgId),
          placement.eventId,
          placement.locationId,
          placement.version,
          input.changes,
        ),
      ),
    onSettled: async (_data, _error, input) => {
      await reread(queryClient, toValue(orgId), input.placements, false);
    },
  });
}

/** `DELETE …/locations/{id}` once per placement. The cascade takes each row's
 * posts and shifts with it, which is why this one re-reads the boards too. */
export function useDeleteMission(orgId: MaybeRefOrGetter<string>) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (placements: readonly MissionPlacement[]) =>
      fanOut(placements, async (placement) =>
        deleteLocation(
          toValue(orgId),
          placement.eventId,
          placement.locationId,
          placement.version,
        ),
      ),
    onSettled: async (_data, _error, placements) => {
      await reread(queryClient, toValue(orgId), placements, true);
    },
  });
}
