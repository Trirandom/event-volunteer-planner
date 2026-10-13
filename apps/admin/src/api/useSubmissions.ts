// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/** Submissions as server state. See `useFestivals.ts` for the rationale — it
 * applies unchanged here. */
import { useQuery } from '@tanstack/vue-query';
import { computed, toValue, type MaybeRefOrGetter } from 'vue';

import { fetchSubmissions } from './submissions';

export function submissionsQueryKey(orgId: string, festivalId: string) {
  return ['orgs', orgId, 'festivals', festivalId, 'submissions'] as const;
}

/**
 * `GET /festivals/{festival}/submissions`.
 *
 * `enabled` for the same reason `useFestival` has it: the page reached
 * through `/events/{id}` does not know which festival it is under — or
 * whether there is one — until that event has loaded, and a standalone event
 * has no festival to ask. Gating is how it asks for nothing rather than
 * firing a request for the empty string and reading a 404 as an answer.
 */
export function useSubmissions(
  orgId: MaybeRefOrGetter<string>,
  festivalId: MaybeRefOrGetter<string>,
  options: { readonly enabled?: MaybeRefOrGetter<boolean> } = {},
) {
  return useQuery({
    queryKey: computed(() =>
      submissionsQueryKey(toValue(orgId), toValue(festivalId)),
    ),
    queryFn: async ({ signal }) =>
      fetchSubmissions(toValue(orgId), toValue(festivalId), signal),
    enabled: computed(() => toValue(options.enabled ?? true)),
  });
}
