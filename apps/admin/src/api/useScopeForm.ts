// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The form a plan page's scope manages, shared by the form builder and the
 * publication tab.
 *
 * Two routes rather than one page with local tabs, so that leaving the builder
 * with unsaved edits goes through the route guard it already has, and the
 * publication tab can never publish something other than what was saved.
 * That makes "which form" state that has to survive a route change, which is
 * why the choice between several forms is the `form` query parameter rather
 * than a ref: the tab links carry it, and a reload keeps it.
 *
 * **Scope.** A festival has one form covering every one of its events
 * (ADR-0035). At festival scope this is that form; on a day of the festival
 * the page says the festival's form covers it, rather than offering a second
 * form nobody asked for; a standalone event, with no festival to share one
 * with, manages its own.
 */
import { computed, type Ref } from 'vue';
import { isNavigationFailure, useRoute, useRouter } from 'vue-router';

import type { Event } from './events';
import type { Form, FormScope } from './forms';
import { useForm, useScopedForms } from './useForms';
import { usePlanScope } from './usePlan';

export interface FormSubject {
  readonly name: string;
  readonly slug: string;
  readonly timezone: string;
}

/** What a form page manages at the scope the URL names. */
export type FormPageScope =
  | {
      readonly kind: 'own';
      readonly formScope: FormScope;
      readonly subject: FormSubject;
      readonly events: readonly Event[];
    }
  | {
      readonly kind: 'covered';
      readonly festivalId: string;
      readonly festivalName: string | null;
      readonly dayName: string;
    };

export function useScopeForm(
  orgId: Ref<string>,
  festivalId: Ref<string>,
  eventId: Ref<string>,
) {
  const route = useRoute();
  const router = useRouter();

  const { scope, isPending: scopePending } = usePlanScope(
    orgId,
    festivalId,
    eventId,
  );

  const page = computed((): FormPageScope | null => {
    const value = scope.value;
    if (value === null) {
      return null;
    }
    if (value.kind === 'festival') {
      return {
        kind: 'own',
        formScope: { festivalId: value.festival.id },
        subject: value.festival,
        events: value.days,
      };
    }
    // Read off the event, not off `value.festival`: a day whose festival
    // failed to load is still a festival day, and offering it a form of its
    // own would be offering the wrong thing on a network error.
    const day = value.selected;
    if (day.festival_id !== null) {
      return {
        kind: 'covered',
        festivalId: day.festival_id,
        festivalName: value.festival?.name ?? null,
        dayName: day.name,
      };
    }
    return {
      kind: 'own',
      formScope: { eventId: day.id },
      subject: day,
      events: [day],
    };
  });

  const formScope = computed(() =>
    page.value?.kind === 'own' ? page.value.formScope : null,
  );

  const { data: formsResult, isPending: formsPending } = useScopedForms(
    orgId,
    formScope,
  );
  const forms = computed(() =>
    formsResult.value?.ok === true ? formsResult.value.value : [],
  );
  const formsFailed = computed(() => formsResult.value?.ok === false);

  /** The form named by `?form=`, else the first — a query naming a form this
   * scope does not have is a stale link, not an error. */
  const formId = computed(() => {
    const chosen = route.query['form'];
    const list = forms.value;
    return list.find((form) => form.id === chosen)?.id ?? list[0]?.id ?? '';
  });

  const { data: formResult } = useForm(orgId, formId);
  /** The form's own query once it answers, the list's copy until then — the
   * list already carries the whole row, so there is no reason to show a
   * spinner for a second request. */
  const form = computed(
    (): Form | null =>
      (formResult.value?.ok === true ? formResult.value.value : null) ??
      forms.value.find((candidate) => candidate.id === formId.value) ??
      null,
  );

  const draftSummary = computed(
    () => form.value?.versions.find((v) => v.published_at === null) ?? null,
  );
  const liveSummary = computed(
    () =>
      form.value?.versions.find((v) => v.id === form.value?.live_version_id) ??
      null,
  );

  /** Settled, not `isPending` alone: a disabled query reports itself pending
   * forever, and this one is disabled on a covered day. */
  const isPending = computed(
    () =>
      scopePending.value ||
      (formScope.value !== null &&
        formsPending.value &&
        formsResult.value === undefined),
  );

  /**
   * Switches form. Resolves `false` when the navigation was refused — by the
   * builder's unsaved-changes guard, which the query change goes through like
   * any other route update.
   */
  async function chooseForm(id: string): Promise<boolean> {
    const failure = await router.replace({
      query: { ...route.query, form: id },
    });
    return !isNavigationFailure(failure);
  }

  return {
    page,
    formScope,
    forms,
    formsFailed,
    formId,
    form,
    draftSummary,
    liveSummary,
    isPending,
    chooseForm,
  };
}
