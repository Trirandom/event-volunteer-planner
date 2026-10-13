// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * OVH SMS settings as server state, on the same footing as
 * `useFestivals.ts`: no Pinia mirror, one cache, invalidated rather than
 * hand-patched after a write.
 *
 * Every key carries `orgId` for the same reason `festivalsQueryKey` does — a
 * coordinator in two organisations must never have one org's saved keys leak
 * into a form open for the other.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed, toValue, type MaybeRefOrGetter } from 'vue';

import {
  fetchSmsSettings,
  updateSmsSettings,
  type UpdateSmsSettingsInput,
} from './smsSettings';

export function smsSettingsQueryKey(orgId: string) {
  return ['orgs', orgId, 'sms-settings'] as const;
}

/** `GET /sms-settings` for the given org. */
export function useSmsSettings(orgId: MaybeRefOrGetter<string>) {
  return useQuery({
    queryKey: computed(() => smsSettingsQueryKey(toValue(orgId))),
    queryFn: async ({ signal }) => fetchSmsSettings(toValue(orgId), signal),
  });
}

/** `PUT /sms-settings`. Invalidates rather than writing the response into the
 * cache directly, so a stale `has_application_secret` flag can never survive
 * a save. */
export function useUpdateSmsSettings(orgId: MaybeRefOrGetter<string>) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateSmsSettingsInput) =>
      updateSmsSettings(toValue(orgId), input),
    onSuccess: async (result) => {
      if (!result.ok) {
        return;
      }
      await queryClient.invalidateQueries({
        queryKey: smsSettingsQueryKey(toValue(orgId)),
      });
    },
  });
}
