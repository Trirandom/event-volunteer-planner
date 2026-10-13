// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/** Shifts as server state. See `useFestivals.ts` for the rationale — it
 * applies unchanged here. */
import { useQuery } from '@tanstack/vue-query';
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
