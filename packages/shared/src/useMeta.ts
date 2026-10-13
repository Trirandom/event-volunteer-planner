// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import {
  onScopeDispose,
  readonly,
  ref,
  type DeepReadonly,
  type Ref,
} from 'vue';

import { fetchMeta, type Meta } from './meta.js';

export type MetaState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly meta: Meta }
  | { readonly status: 'failed'; readonly reason: 'unreachable' | 'malformed' };

/**
 * Deliberately not a TanStack Query hook.
 *
 * `apps/form` must not carry a query client (docs/09 §6), and this is the one
 * request both applications make. A ~20-line composable in the shared package
 * costs the form bundle nothing; the admin application's *own* server state
 * goes through TanStack Query as ADR-0004 requires.
 */
export function useMeta(): DeepReadonly<Ref<MetaState>> {
  const state = ref<MetaState>({ status: 'loading' });
  const controller = new AbortController();

  void fetchMeta(controller.signal).then((result) => {
    state.value = result.ok
      ? { status: 'ready', meta: result.meta }
      : { status: 'failed', reason: result.reason };
  });

  onScopeDispose(() => {
    controller.abort();
  });

  return readonly(state);
}
