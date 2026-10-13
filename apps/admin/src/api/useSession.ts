// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { useQuery } from '@tanstack/vue-query';

import { fetchSession, sessionQueryKey, type Session } from './session';

/**
 * The signed-in user, as server state (ADR-0004).
 *
 * One query key for the whole application, so the header, the router guard and
 * every guarded view read the same answer. The alternative — a Pinia store
 * mirroring it — is two sources of truth that disagree the first time a
 * session expires in a background tab.
 *
 * `fetchSession` never rejects, so `data` is the only thing a caller reads:
 * `undefined` while the first request is in flight, then one of the three
 * `Session` states.
 */
export function useSession() {
  return useQuery({
    queryKey: sessionQueryKey,
    queryFn: async ({ signal }): Promise<Session> => fetchSession(signal),
    // Matches the router guard's window; see the guard for why it is not zero.
    staleTime: 30_000,
  });
}
