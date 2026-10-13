// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/** Events as server state. See `useFestivals.ts` for the rationale — it
 * applies unchanged here. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed, toValue, type MaybeRefOrGetter } from 'vue';

import {
  createEvent,
  deleteEvent,
  fetchEvent,
  fetchEvents,
  loadExampleEvent,
  patchEventDetails,
  type CreateEventInput,
  type Event,
  type EventDetailsInput,
} from './events';
import { festivalQueryKey, festivalsQueryKey } from './useFestivals';

export function eventsQueryKey(orgId: string) {
  return ['orgs', orgId, 'events'] as const;
}

export function eventQueryKey(orgId: string, eventId: string) {
  return ['orgs', orgId, 'events', eventId] as const;
}

/** `GET /events` for the given org, unfiltered. */
export function useEvents(orgId: MaybeRefOrGetter<string>) {
  return useQuery({
    queryKey: computed(() => eventsQueryKey(toValue(orgId))),
    queryFn: async ({ signal }) => fetchEvents(toValue(orgId), { signal }),
  });
}

/** `GET /events/{event}`. See `useFestival` for what `enabled` is for — the
 * same detail page needs it in the other direction, when the URL named a
 * festival and there is no day to load at all. */
export function useEvent(
  orgId: MaybeRefOrGetter<string>,
  eventId: MaybeRefOrGetter<string>,
  options: { readonly enabled?: MaybeRefOrGetter<boolean> } = {},
) {
  return useQuery({
    queryKey: computed(() => eventQueryKey(toValue(orgId), toValue(eventId))),
    queryFn: async ({ signal }) =>
      fetchEvent(toValue(orgId), toValue(eventId), signal),
    enabled: computed(() => toValue(options.enabled ?? true)),
  });
}

/**
 * `POST /events`.
 *
 * Also invalidates the owning festival's detail query when the new event is
 * attached to one: that query's `events` array and `event_count` would
 * otherwise read stale until something else happened to refetch it, which on
 * the festival detail view is "the coordinator navigates away and back" — a
 * worse experience than one extra request.
 */
export function useCreateEvent(orgId: MaybeRefOrGetter<string>) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateEventInput) =>
      createEvent(toValue(orgId), input),
    onSuccess: async (result) => {
      if (!result.ok) {
        return;
      }
      const org = toValue(orgId);
      const invalidations = [
        queryClient.invalidateQueries({ queryKey: eventsQueryKey(org) }),
      ];
      if (result.event.festival_id !== null) {
        invalidations.push(
          queryClient.invalidateQueries({
            queryKey: festivalQueryKey(org, result.event.festival_id),
          }),
        );
      }
      await Promise.all(invalidations);
    },
  });
}

/** `POST /events/example`. See `useLoadExampleFestival` for why every
 * outcome invalidates. */
export function useLoadExampleEvent(orgId: MaybeRefOrGetter<string>) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => loadExampleEvent(toValue(orgId)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: eventsQueryKey(toValue(orgId)),
      });
    },
  });
}

/**
 * Every query a changed event appears in.
 *
 * An event is inlined into its festival's detail response and summarised in
 * both lists, so a page can be showing the same row from four caches at once —
 * the day strip reads the festival, the board reads the event. Invalidating
 * only the one the form wrote through is how a recoloured day stays the old
 * colour in the strip beside it.
 */
async function invalidateEvent(
  queryClient: ReturnType<typeof useQueryClient>,
  orgId: string,
  event: Pick<Event, 'id' | 'festival_id'>,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: eventQueryKey(orgId, event.id) }),
    queryClient.invalidateQueries({ queryKey: eventsQueryKey(orgId) }),
    queryClient.invalidateQueries({ queryKey: festivalsQueryKey(orgId) }),
    ...(event.festival_id === null
      ? []
      : [
          queryClient.invalidateQueries({
            queryKey: festivalQueryKey(orgId, event.festival_id),
          }),
        ]),
  ]);
}

/**
 * `PATCH /events/{event}` from the details form.
 *
 * The version travels in the call rather than being read from the cache here,
 * because the cache is not what the coordinator was looking at when they
 * pressed save — the form is, and the row it rendered is the one whose version
 * the `If-Match` has to assert.
 */
export function useUpdateEventDetails(orgId: MaybeRefOrGetter<string>) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      readonly eventId: string;
      readonly version: number;
      readonly changes: EventDetailsInput;
    }) =>
      patchEventDetails(
        toValue(orgId),
        input.eventId,
        input.version,
        input.changes,
      ),
    onSuccess: async (result) => {
      if (result.ok) {
        await invalidateEvent(queryClient, toValue(orgId), result.event);
      }
    },
  });
}

/**
 * `DELETE /events/{event}`.
 *
 * The festival the event belonged to travels in with the request rather than
 * being looked up afterwards: by the time this resolves the event is gone, and
 * the query that needs invalidating most is precisely the one that used to
 * list it.
 *
 * **Invalidation is started, not awaited**, which is the one place this hook
 * differs from `useUpdateEventDetails`. `mutateAsync` does not resolve until
 * `onSuccess` does, so awaiting the refetch here would hand the caller control
 * back only *after* the page had re-read a row the server now answers `404`
 * for — and the caller's whole job is to navigate away before that matters.
 * Awaiting it renders "this page could not be loaded" for as long as the
 * redirect takes. The queries still refresh; nothing waits on them.
 */
export function useDeleteEvent(orgId: MaybeRefOrGetter<string>) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      readonly eventId: string;
      readonly version: number;
      readonly festivalId: string | null;
    }) => deleteEvent(toValue(orgId), input.eventId, input.version),
    onSuccess: (result, input) => {
      if (result.ok) {
        void invalidateEvent(queryClient, toValue(orgId), {
          id: input.eventId,
          festival_id: input.festivalId,
        });
      }
    },
  });
}
