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
  deleteFestival,
  fetchFestival,
  fetchFestivalDeletion,
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

/**
 * `GET /festivals/{festival}/deletion`: what deleting it would cost.
 *
 * Gated on `enabled` because it is owner-only and only worth asking once
 * the confirmation opens. `staleTime: 0` keeps the count from an earlier
 * opening from standing in for one a new submission has since changed.
 */
export function useFestivalDeletion(
  orgId: MaybeRefOrGetter<string>,
  festivalId: MaybeRefOrGetter<string>,
  options: { readonly enabled: MaybeRefOrGetter<boolean> },
) {
  return useQuery({
    queryKey: computed(() => [
      ...festivalQueryKey(toValue(orgId), toValue(festivalId)),
      'deletion',
    ]),
    queryFn: async ({ signal }) =>
      fetchFestivalDeletion(toValue(orgId), toValue(festivalId), signal),
    enabled: computed(() => toValue(options.enabled)),
    staleTime: 0,
  });
}

/**
 * `DELETE /festivals/{festival}` (ADR-0053).
 *
 * The festival's own entries are removed rather than invalidated: refetching
 * them would only fetch a 404. Everything else under the org is
 * invalidated, because the delete reaches well past the festival — its
 * events are regrouped, its forms and their submissions are gone, and so is
 * availability read off them. Naming each of those caches here would be a
 * list that silently goes stale the day another one is added.
 */
export function useDeleteFestival(orgId: MaybeRefOrGetter<string>) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      readonly festivalId: string;
      readonly version: number;
    }) => deleteFestival(toValue(orgId), input.festivalId, input.version),
    onSuccess: async (result, input) => {
      if (!result.ok) {
        return;
      }
      queryClient.removeQueries({
        queryKey: festivalQueryKey(toValue(orgId), input.festivalId),
      });
      await queryClient.invalidateQueries({
        queryKey: ['orgs', toValue(orgId)],
      });
    },
  });
}
