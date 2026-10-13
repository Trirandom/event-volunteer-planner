// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/** Locations as server state. See `useFestivals.ts` for the rationale — it
 * applies unchanged here. */
import { useQuery } from '@tanstack/vue-query';
import { computed, toValue, type MaybeRefOrGetter } from 'vue';

import { fetchLocations } from './locations';

export function locationsQueryKey(orgId: string, eventId: string) {
  return ['orgs', orgId, 'events', eventId, 'locations'] as const;
}

/** `GET /events/{event}/locations`. */
export function useLocations(
  orgId: MaybeRefOrGetter<string>,
  eventId: MaybeRefOrGetter<string>,
) {
  return useQuery({
    queryKey: computed(() =>
      locationsQueryKey(toValue(orgId), toValue(eventId)),
    ),
    queryFn: async ({ signal }) =>
      fetchLocations(toValue(orgId), toValue(eventId), signal),
  });
}
