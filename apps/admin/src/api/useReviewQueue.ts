// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/** The review queue as server state. See `useFestivals.ts` for the
 * rationale — it applies unchanged here. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed, toValue, type MaybeRefOrGetter } from 'vue';

import {
  fetchReviewQueue,
  resolveSubmission,
  type Resolution,
} from './intakeReview';

export function reviewQueueQueryKey(orgId: string) {
  return ['orgs', orgId, 'intake', 'review'] as const;
}

export function useReviewQueue(
  orgId: MaybeRefOrGetter<string>,
  options: { readonly enabled?: MaybeRefOrGetter<boolean> } = {},
) {
  return useQuery({
    queryKey: computed(() => reviewQueueQueryKey(toValue(orgId))),
    queryFn: async ({ signal }) => fetchReviewQueue(toValue(orgId), signal),
    enabled: computed(
      () => toValue(orgId) !== '' && toValue(options.enabled ?? true),
    ),
  });
}

export interface ResolveInput {
  readonly submissionId: string;
  readonly resolution: Resolution;
}

/**
 * One decision on one submission.
 *
 * Everything under the organisation is re-read afterwards, refusal or not:
 * an applied submission moves to the submissions list and writes a volunteer,
 * their participations and their availability, so the queue is far from the
 * only thing that changed — and a `409` means someone else changed it.
 */
export function useResolveSubmission(orgId: MaybeRefOrGetter<string>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ResolveInput) =>
      resolveSubmission(toValue(orgId), input.submissionId, input.resolution),
    onSettled: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['orgs', toValue(orgId)],
      });
    },
  });
}
