// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * Putting somebody on a shift, and taking them off again.
 *
 * One mutation for both, the way `useShiftWrites.ts` has one for a whole plan:
 * the board disables its controls while a write is in flight, and two
 * mutations would mean two `isPending` flags that a slot would have to
 * combine — and would get wrong the first time a third verb arrives.
 *
 * **Replacing somebody is a cancel and then a create, in that order and not in
 * parallel.** Picking a different name in a full slot means the outgoing
 * placement has to be gone before the incoming one is attempted, or the
 * exclusion constraint refuses the new name for clashing with the person it is
 * replacing. Sequential is the contract here for the same reason it is in
 * `useShiftWrites.ts`: the second write depends on the first.
 *
 * Invalidation is unconditional, including on a refusal. A refused placement
 * still means the board is looking at a roster somebody else may have moved —
 * that is usually *why* it was refused — so the honest response is to re-read.
 */
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { toValue, type MaybeRefOrGetter } from 'vue';

import {
  cancelAssignment,
  createAssignment,
  type AssignmentRejection,
} from './assignments';
import { assignmentsQueryKey } from './useRoster';

/** What a coordinator just did to one seat. */
export type RosterOp =
  /** Put this person on this shift. */
  | {
      readonly kind: 'assign';
      readonly eventId: string;
      readonly shiftId: string;
      readonly participationId: string;
    }
  /** Take this placement off, naming the version it was read at. */
  | {
      readonly kind: 'cancel';
      readonly eventId: string;
      readonly assignmentId: string;
      readonly version: number;
    };

export interface RosterOutcome {
  /** How many operations went through before the sequence stopped. A replace
   * that cancelled and then failed to create is a real state of the database,
   * and the view says so rather than pretending the seat is unchanged. */
  readonly applied: number;
  readonly rejection: AssignmentRejection | null;
}

export async function applyRosterOps(
  orgId: string,
  ops: readonly RosterOp[],
): Promise<RosterOutcome> {
  let applied = 0;

  for (const op of ops) {
    const result =
      op.kind === 'assign'
        ? await createAssignment(orgId, op.eventId, {
            shiftId: op.shiftId,
            participationId: op.participationId,
          })
        : await cancelAssignment(
            orgId,
            op.eventId,
            op.assignmentId,
            op.version,
          );
    if (!result.ok) {
      return { applied, rejection: result.rejection };
    }
    applied += 1;
  }

  return { applied, rejection: null };
}

/** The days a sequence touched — the rosters that have to be re-read. */
function touchedEvents(ops: readonly RosterOp[]): readonly string[] {
  return [...new Set(ops.map((op) => op.eventId))];
}

export function useApplyRosterOps(orgId: MaybeRefOrGetter<string>) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (ops: readonly RosterOp[]) =>
      applyRosterOps(toValue(orgId), ops),
    onSettled: async (_data, _error, ops) => {
      const org = toValue(orgId);
      await Promise.all(
        touchedEvents(ops).map(async (eventId) =>
          queryClient.invalidateQueries({
            queryKey: assignmentsQueryKey(org, eventId),
          }),
        ),
      );
    },
  });
}
