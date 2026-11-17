// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/** Shifts as server state. See `useFestivals.ts` for the rationale — it
 * applies unchanged here. */
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed, toValue, type MaybeRefOrGetter } from 'vue';

import { fetchShifts } from './shifts';

export function shiftsQueryKey(orgId: string, eventId: string) {
  return ['orgs', orgId, 'events', eventId, 'shifts'] as const;
}

/** `GET /events/{event}/shifts`, unfiltered. */
export function useShifts(
  orgId: MaybeRefOrGetter<string>,
  eventId: MaybeRefOrGetter<string>,
) {
  return useQuery({
    queryKey: computed(() => shiftsQueryKey(toValue(orgId), toValue(eventId))),
    queryFn: async ({ signal }) =>
      fetchShifts(toValue(orgId), toValue(eventId), signal),
  });
}

/**
 * Reads one event's shifts on demand, through the same cache entry the board
 * uses. For a decision rather than a display (whether removing a day takes
 * shifts with it), so `query` refetches anything stale instead of
 * answering from whatever the board last saw.
 */
export function useShiftsReader(orgId: MaybeRefOrGetter<string>) {
  const queryClient = useQueryClient();
  return async (eventId: string) =>
    queryClient.query({
      queryKey: shiftsQueryKey(toValue(orgId), eventId),
      queryFn: async ({ signal }) =>
        fetchShifts(toValue(orgId), eventId, signal),
    });
}
