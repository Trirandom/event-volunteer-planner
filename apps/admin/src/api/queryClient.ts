// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { QueryClient } from '@tanstack/vue-query';

/**
 * Constructed here rather than inside `main.ts`'s `app.use(...)` so that the
 * router guard can reach it.
 *
 * A guard runs outside any component, so it cannot call `useQueryClient()`.
 * The alternative is a second copy of "is there a session?" kept in a store
 * and synchronised by hand, which is how a guard and a view come to disagree
 * about whether the user is signed in.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // No WebSockets in v1 (docs/02 §10); polling plus optimistic-concurrency
      // conflict detection is the collision story. Refetching on focus is also
      // what notices a session that expired while the tab was in the
      // background.
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});
