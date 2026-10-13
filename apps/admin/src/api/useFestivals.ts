// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * Festivals as server state, on the same footing as `useSession.ts`
 * (ADR-0004): no Pinia mirror, one cache, invalidated rather than
 * hand-patched after a mutation.
 *
 * Every key carries `orgId`: the org is a path segment on the wire (docs/04
 * §1) and it is one here too, so a coordinator who is a member of two
 * organisations never sees one org's festivals answer a query made for the
 * other, and switching org invalidates nothing by accident — it is simply a
 * different key.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed, toValue, type MaybeRefOrGetter } from 'vue';

import {
  createFestival,
  fetchFestival,
  fetchFestivals,
  loadExampleFestival,
  type CreateFestivalInput,
} from './festivals';

export function festivalsQueryKey(orgId: string) {
  return ['orgs', orgId, 'festivals'] as const;
}

export function festivalQueryKey(orgId: string, festivalId: string) {
  return ['orgs', orgId, 'festivals', festivalId] as const;
}

/** `GET /festivals` for the given org. */
export function useFestivals(orgId: MaybeRefOrGetter<string>) {
  return useQuery({
    queryKey: computed(() => festivalsQueryKey(toValue(orgId))),
    queryFn: async ({ signal }) => fetchFestivals(toValue(orgId), { signal }),
  });
}

/**
 * `GET /festivals/{festival}`, events inlined.
 *
 * `enabled` exists for the one page that does not know whether it needs a
 * festival until something else has loaded: a detail page reached through an
 * event only learns which festival — or whether there is one at all — from
 * that event's `festival_id` (`usePlan.ts`). Gating the query is how it asks
 * for nothing in the meantime, rather than firing a request for the empty
 * string and reading a 404 as an answer.
 */
export function useFestival(
  orgId: MaybeRefOrGetter<string>,
  festivalId: MaybeRefOrGetter<string>,
  options: { readonly enabled?: MaybeRefOrGetter<boolean> } = {},
) {
  return useQuery({
    queryKey: computed(() =>
      festivalQueryKey(toValue(orgId), toValue(festivalId)),
    ),
    queryFn: async ({ signal }) =>
      fetchFestival(toValue(orgId), toValue(festivalId), signal),
    enabled: computed(() => toValue(options.enabled ?? true)),
  });
}

/**
 * `POST /festivals`.
 *
 * Invalidates rather than writing the new festival into the cache directly:
 * the list may be filtered by `?status=` in a way this call site does not
 * know about, and a stale filtered view is a worse bug than one extra
 * round trip.
 */
export function useCreateFestival(orgId: MaybeRefOrGetter<string>) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateFestivalInput) =>
      createFestival(toValue(orgId), input),
    onSuccess: async (result) => {
      if (!result.ok) {
        return;
      }
      await queryClient.invalidateQueries({
        queryKey: festivalsQueryKey(toValue(orgId)),
      });
    },
  });
}

/**
 * `POST /festivals/example`.
 *
 * Invalidates the list on *every* outcome, including the 409 an empty state
 * gets when another coordinator's click landed first: the org is no longer
 * empty either way, and the empty state's job is to refetch and show what is
 * actually there now rather than report a raw conflict (see
 * `EventsView.vue`).
 */
export function useLoadExampleFestival(orgId: MaybeRefOrGetter<string>) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => loadExampleFestival(toValue(orgId)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: festivalsQueryKey(toValue(orgId)),
      });
    },
  });
}
