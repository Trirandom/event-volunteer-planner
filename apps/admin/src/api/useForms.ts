// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The volunteer form as server state. Same footing as `useFestivals.ts`: one
 * cache, keyed by org, invalidated rather than hand-patched after a write.
 *
 * One exception to "invalidate, don't patch": a saved or published version is
 * written straight into its own query. The builder re-seeds its draft from
 * that query (`PlanFormView.vue`), and the refetch an invalidation would
 * trigger lands a round trip later — long enough for the page to show the
 * pre-save questions as "unsaved" for a moment after a successful save. The
 * response *is* the stored version, so writing it is not a guess.
 *
 * Mutations return their outcome as a value, as every write here does
 * (`api/http.ts`); a `409` or `422` is a result for the page to render, not an
 * exception for a `catch` to swallow.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed, toValue, type MaybeRefOrGetter } from 'vue';

import {
  createForm,
  createFormVersion,
  fetchForm,
  fetchFormVersion,
  fetchForms,
  fetchMissionOptions,
  patchForm,
  publishFormVersion,
  saveFormVersion,
  type CreateFormInput,
  type FormScope,
  type FormSettingsChanges,
  type FormVersion,
  type SaveVersionInput,
} from './forms';

export function formsQueryKey(orgId: string) {
  return ['orgs', orgId, 'forms'] as const;
}

/** Nested under `formsQueryKey`, so invalidating the list prefix also
 * reaches every scoped list without knowing which scopes are cached. */
export function scopedFormsQueryKey(orgId: string, scope: FormScope) {
  return [
    ...formsQueryKey(orgId),
    'festivalId' in scope
      ? { festival: scope.festivalId }
      : { event: scope.eventId },
  ] as const;
}

export function formQueryKey(orgId: string, formId: string) {
  return ['orgs', orgId, 'form', formId] as const;
}

export function formVersionQueryKey(
  orgId: string,
  formId: string,
  version: number,
) {
  return [...formQueryKey(orgId, formId), 'versions', version] as const;
}

export function missionOptionsQueryKey(orgId: string, formId: string) {
  return [...formQueryKey(orgId, formId), 'mission-options'] as const;
}

/** `GET /forms?festival=|event=`. `null` asks for nothing: the event page of
 * a festival day has no form of its own to list. */
export function useScopedForms(
  orgId: MaybeRefOrGetter<string>,
  scope: MaybeRefOrGetter<FormScope | null>,
) {
  return useQuery({
    queryKey: computed(() => {
      const value = toValue(scope);
      return value === null
        ? [...formsQueryKey(toValue(orgId)), 'none']
        : scopedFormsQueryKey(toValue(orgId), value);
    }),
    queryFn: async ({ signal }) => {
      const value = toValue(scope);
      return value === null
        ? { ok: true as const, value: [] }
        : fetchForms(toValue(orgId), value, signal);
    },
    enabled: computed(() => toValue(scope) !== null),
  });
}

export function useForm(
  orgId: MaybeRefOrGetter<string>,
  formId: MaybeRefOrGetter<string>,
) {
  return useQuery({
    queryKey: computed(() => formQueryKey(toValue(orgId), toValue(formId))),
    queryFn: async ({ signal }) =>
      fetchForm(toValue(orgId), toValue(formId), signal),
    enabled: computed(() => toValue(formId) !== ''),
  });
}

/** `version` of `0` asks for nothing — a form with no version selected yet. */
export function useFormVersion(
  orgId: MaybeRefOrGetter<string>,
  formId: MaybeRefOrGetter<string>,
  version: MaybeRefOrGetter<number>,
) {
  return useQuery({
    queryKey: computed(() =>
      formVersionQueryKey(toValue(orgId), toValue(formId), toValue(version)),
    ),
    queryFn: async ({ signal }) =>
      fetchFormVersion(
        toValue(orgId),
        toValue(formId),
        toValue(version),
        signal,
      ),
    enabled: computed(() => toValue(formId) !== '' && toValue(version) > 0),
  });
}

/** Not cached for long on purpose: the point of reading it is to notice a
 * mission added on the missions page a minute ago. Refetched on focus by the
 * query client's default, which is the tab switch that brings a coordinator
 * back from adding one. */
export function useMissionOptions(
  orgId: MaybeRefOrGetter<string>,
  formId: MaybeRefOrGetter<string>,
  options: { readonly enabled?: MaybeRefOrGetter<boolean> } = {},
) {
  return useQuery({
    queryKey: computed(() =>
      missionOptionsQueryKey(toValue(orgId), toValue(formId)),
    ),
    queryFn: async ({ signal }) =>
      fetchMissionOptions(toValue(orgId), toValue(formId), signal),
    enabled: computed(
      () => toValue(formId) !== '' && toValue(options.enabled ?? true),
    ),
  });
}

export function useCreateForm(orgId: MaybeRefOrGetter<string>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateFormInput) =>
      createForm(toValue(orgId), input),
    // Settled, not only on success: a `409` on the slug may mean another
    // coordinator created this scope's form a moment ago, and the list is
    // then what the page should show instead of the empty state.
    onSettled: async () => {
      await queryClient.invalidateQueries({
        queryKey: formsQueryKey(toValue(orgId)),
      });
    },
  });
}

export function usePatchForm(orgId: MaybeRefOrGetter<string>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      readonly formId: string;
      readonly version: number;
      readonly changes: FormSettingsChanges;
    }) => patchForm(toValue(orgId), input.formId, input.version, input.changes),
    onSettled: async (_data, _error, input) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: formQueryKey(toValue(orgId), input.formId),
          exact: true,
        }),
        queryClient.invalidateQueries({
          queryKey: formsQueryKey(toValue(orgId)),
        }),
      ]);
    },
  });
}

/** Writes the stored version into its query and re-reads the form around
 * it, whose `versions` list carries the question count and the publish
 * date. */
async function storeVersion(
  queryClient: ReturnType<typeof useQueryClient>,
  orgId: string,
  formId: string,
  version: FormVersion,
): Promise<void> {
  queryClient.setQueryData(
    formVersionQueryKey(orgId, formId, version.version),
    { ok: true, value: version },
  );
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: formQueryKey(orgId, formId),
      exact: true,
    }),
    queryClient.invalidateQueries({ queryKey: formsQueryKey(orgId) }),
  ]);
}

export function useSaveFormVersion(orgId: MaybeRefOrGetter<string>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      readonly formId: string;
      readonly save: SaveVersionInput;
    }) => saveFormVersion(toValue(orgId), input.formId, input.save),
    onSuccess: async (result, input) => {
      if (result.ok) {
        await storeVersion(
          queryClient,
          toValue(orgId),
          input.formId,
          result.value,
        );
      }
    },
  });
}

export function usePublishFormVersion(orgId: MaybeRefOrGetter<string>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      readonly formId: string;
      readonly version: number;
      readonly etag: number;
    }) =>
      publishFormVersion(
        toValue(orgId),
        input.formId,
        input.version,
        input.etag,
      ),
    onSettled: async (result, _error, input) => {
      if (result?.ok === true) {
        await storeVersion(
          queryClient,
          toValue(orgId),
          input.formId,
          result.value,
        );
        return;
      }
      // A refused publish may have been refused because the draft moved
      // under us; the version is re-read so the page is not left asserting
      // a stale token on the next attempt.
      await queryClient.invalidateQueries({
        queryKey: formVersionQueryKey(
          toValue(orgId),
          input.formId,
          input.version,
        ),
      });
    },
  });
}

export function useCreateFormVersion(orgId: MaybeRefOrGetter<string>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (formId: string) =>
      createFormVersion(toValue(orgId), formId),
    // Settled: the `409` "a draft already exists" means the form's version
    // list is stale, and re-reading it is what reveals the draft to open.
    onSettled: async (result, _error, formId) => {
      if (result?.ok === true) {
        await storeVersion(queryClient, toValue(orgId), formId, result.value);
        return;
      }
      await queryClient.invalidateQueries({
        queryKey: formQueryKey(toValue(orgId), formId),
        exact: true,
      });
    },
  });
}
