// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { computed, type ComputedRef } from 'vue';
import { useRoute } from 'vue-router';

/**
 * A route param, guaranteed to be a string.
 *
 * `RouteParams` is `Record<string, string | string[]>`, so under
 * `noUncheckedIndexedAccess` reading it is `string | string[] | undefined`
 * even for a segment the route definition declares as a single, always-present
 * `:name`. `EventsView`, `PlanDetailView` and the shell's own header all
 * needed the same "narrow it or fall back" logic; this is that logic written
 * once instead of copied three times with room to drift.
 */
export function useRouteParam(name: string): ComputedRef<string> {
  const route = useRoute();
  return computed(() => {
    const raw = route.params[name];
    return typeof raw === 'string' ? raw : '';
  });
}
