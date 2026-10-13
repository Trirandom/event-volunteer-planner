// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * Saving one volunteer's edited availability for one day.
 *
 * One request per gesture, not a plan of several: the endpoint is a full
 * replace of that participation's declared windows, so `useShiftWrites.ts`'s
 * op-sequencing — deletes making room for creates, each asserting a version —
 * has no equivalent here and would be ceremony around a single `PUT`.
 *
 * The roster query is invalidated and **awaited**, which is what the board
 * leans on: it holds the edited chips locally only until this resolves, so the
 * hand-off from "what I just dragged" to "what the server says" happens with
 * no frame in between showing the old shape.
 */
import { Temporal } from '@evp/shared/time';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { toValue, type MaybeRefOrGetter } from 'vue';

import { replaceAvailability } from './availability';
import { participationsQueryKey } from './useRoster';
import type { DeclaredWindow } from '../plan/availability';

/** The wire wants RFC 3339, and `Instant.toString()` is always UTC and always
 * offset-bearing — instants on the wire, wall clock only in the view
 * (docs/16 §2). `new Date` is banned here as everywhere else (docs/16 §4). */
function isoOf(ms: number): string {
  return Temporal.Instant.fromEpochMilliseconds(ms).toString();
}

export interface AvailabilitySave {
  readonly participationId: string;
  /** The day the participation belongs to — the query whose roster this save
   * changes, and the path segment the endpoint is under. */
  readonly eventId: string;
  readonly windows: readonly DeclaredWindow[];
}

export function useReplaceAvailability(orgId: MaybeRefOrGetter<string>) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (save: AvailabilitySave) =>
      replaceAvailability(
        toValue(orgId),
        save.eventId,
        save.participationId,
        save.windows.map((window) => ({
          kind: window.kind,
          start: isoOf(window.startMs),
          end: isoOf(window.endMs),
        })),
      ),
    // Unconditional, including on a refusal: a coordinator who was told "no"
    // is owed the board the server actually holds, not the one they drew.
    onSettled: async (_result, _error, save) => {
      await queryClient.invalidateQueries({
        queryKey: participationsQueryKey(toValue(orgId), save.eventId),
      });
    },
  });
}
