// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * Carrying out a board edit: a plan of shift operations, against the API.
 *
 * `board/edit.ts` decides *what* a drag means and stays pure; this is the part
 * that talks. The two are split because the arithmetic is specified and
 * mutation-tested and the transport is not, and because a plan is worth
 * reading in a test without a server anywhere near it.
 *
 * **Sequential, and it stops at the first refusal.** A plan is one
 * coordinator's single gesture — "this bar now ends at 02:00" — and half of it
 * is not a smaller version of it. Firing the operations in parallel would also
 * race the `version` each one asserts against. docs/04's per-item bulk
 * convention (ADR-0024) is about *independent* items, which these are not: a
 * plan's deletes make room for its creates.
 */
import { Temporal } from '@evp/shared/time';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { toValue, type MaybeRefOrGetter } from 'vue';

import { patchEventPeriod } from './events';
import {
  createShift,
  deleteShift,
  patchShiftPeriod,
  type ShiftWriteRejection,
} from './shifts';
import { eventQueryKey, eventsQueryKey } from './useEvents';
import { festivalsQueryKey } from './useFestivals';
import { shiftsQueryKey } from './useShifts';
import type { BoardOp } from '../board/edit';

export interface ApplyOutcome {
  /** How many operations went through before the plan stopped. Reported
   * rather than hidden: a partially applied plan is a real state of the
   * database, and a coordinator is owed the truth about it. */
  readonly applied: number;
  readonly rejection: ShiftWriteRejection | null;
}

/** The wire wants RFC 3339, and `Instant.toString()` is always UTC and always
 * offset-bearing — instants on the wire, wall clock only in the view
 * (docs/16 §2). `new Date` is banned here for the same reason it is banned
 * everywhere else in this codebase (docs/16 §4). */
function isoOf(ms: number): string {
  return Temporal.Instant.fromEpochMilliseconds(ms).toString();
}

export async function applyShiftOps(
  orgId: string,
  ops: readonly BoardOp[],
): Promise<ApplyOutcome> {
  let applied = 0;

  for (const op of ops) {
    // Sequential is the contract, not an oversight: a plan's deletes make room
    // for its creates, and each write asserts a version the one before it may
    // have moved.
    const result = await runOne(orgId, op);
    if (!result.ok) {
      return { applied, rejection: result.rejection };
    }
    applied += 1;
  }

  return { applied, rejection: null };
}

async function runOne(
  orgId: string,
  op: BoardOp,
): Promise<
  | { readonly ok: true }
  | { readonly ok: false; readonly rejection: ShiftWriteRejection }
> {
  if (op.kind === 'extend-event') {
    // First in its plan and on purpose: the shift-inside-event rule is a
    // constraint trigger that fires at the statement, so the slots behind this
    // op are unwritable until it lands (`board/edit.ts`).
    const widened = await patchEventPeriod(orgId, op.eventId, op.version, {
      start: isoOf(op.startMs),
      end: isoOf(op.endMs),
    });
    return widened.ok
      ? { ok: true }
      : { ok: false, rejection: widened.rejection };
  }
  if (op.kind === 'create') {
    return createShift(orgId, op.eventId, {
      locationId: op.locationId,
      period: { start: isoOf(op.startMs), end: isoOf(op.endMs) },
      requiredCount: op.requiredCount,
    });
  }
  if (op.kind === 'patch') {
    return patchShiftPeriod(orgId, op.eventId, op.shiftId, op.version, {
      start: isoOf(op.startMs),
      end: isoOf(op.endMs),
    });
  }
  return deleteShift(orgId, op.eventId, op.shiftId, op.version);
}

/** The events a plan touched — the queries that have to be re-read. */
function touchedEvents(ops: readonly BoardOp[]): readonly string[] {
  return [...new Set(ops.map((op) => op.eventId))];
}

/** The events a plan *moved* — a wider day is a different axis, so the page
 * has to re-read the event itself and not only its shifts. */
function widenedEvents(ops: readonly BoardOp[]): readonly string[] {
  return [
    ...new Set(
      ops.filter((op) => op.kind === 'extend-event').map((op) => op.eventId),
    ),
  ];
}

/**
 * The board's one write path.
 *
 * Invalidation is unconditional, including on a refusal: a plan that stopped
 * halfway changed the database, and leaving the cache holding the shape the
 * coordinator *asked* for would show them an edit that did not happen.
 */
export function useApplyShiftOps(orgId: MaybeRefOrGetter<string>) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (ops: readonly BoardOp[]) =>
      applyShiftOps(toValue(orgId), ops),
    onSettled: async (_data, _error, ops) => {
      const org = toValue(orgId);
      const widened = widenedEvents(ops);

      await Promise.all([
        ...touchedEvents(ops).map(async (eventId) =>
          queryClient.invalidateQueries({
            queryKey: shiftsQueryKey(org, eventId),
          }),
        ),
        ...widened.map(async (eventId) =>
          queryClient.invalidateQueries({
            queryKey: eventQueryKey(org, eventId),
          }),
        ),
        // The festival inlines its days, and the axis of a festival-wide board
        // is the union of their periods — so a day that grew changes a page
        // that never asked for that day on its own.
        ...(widened.length === 0
          ? []
          : [
              queryClient.invalidateQueries({
                queryKey: eventsQueryKey(org),
              }),
              queryClient.invalidateQueries({
                queryKey: festivalsQueryKey(org),
              }),
            ]),
      ]);
    },
  });
}
