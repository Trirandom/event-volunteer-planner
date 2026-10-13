// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The two queries the assignation board is built from: who is enrolled on each
 * day in view, and who is already placed.
 *
 * One fan-out per day, keyed exactly as a per-event hook would key it, for the
 * same reason `usePlan.ts` fans out locations and shifts: a coordinator who
 * opens the festival and then clicks through its days makes each request once.
 *
 * Both are *per event* rather than per festival, because both facts are. A
 * volunteer enrols in one edition at a time (the schema says so with a
 * composite foreign key), and an assignment belongs to the day its shift is
 * on. A festival-wide board is therefore several days' answers laid on one
 * axis, which is exactly what the shift board already does with shifts.
 *
 * A day whose roster fails contributes nothing rather than failing the board —
 * five days of assignments under a warning is more use than an error page —
 * and the flags are how the view says so. That matters more here than on the
 * shift board: a day whose participations did not load looks exactly like a
 * day nobody signed up for, and the dropdown would be empty with no
 * explanation.
 */
import { useQueries } from '@tanstack/vue-query';
import {
  computed,
  toValue,
  type ComputedRef,
  type MaybeRefOrGetter,
} from 'vue';

import { fetchAssignments, type Assignment } from './assignments';
import type { Event } from './events';
import { fetchParticipations, type Participation } from './participations';

export function participationsQueryKey(orgId: string, eventId: string) {
  return ['orgs', orgId, 'events', eventId, 'participations'] as const;
}

export function assignmentsQueryKey(orgId: string, eventId: string) {
  return ['orgs', orgId, 'events', eventId, 'assignments'] as const;
}

export interface RosterQuery {
  /** Enrolled volunteers, by event id: which pool a given slot may draw from. */
  readonly participants: ComputedRef<
    ReadonlyMap<string, readonly Participation[]>
  >;
  /** Every live placement across the days in view, flat — a slot finds its own
   * by `shift_id`, and the double-booking check needs the whole list. */
  readonly assignments: ComputedRef<readonly Assignment[]>;
  readonly isPending: ComputedRef<boolean>;
  readonly participantsFailed: ComputedRef<boolean>;
  readonly assignmentsFailed: ComputedRef<boolean>;
}

export function useRoster(
  orgId: MaybeRefOrGetter<string>,
  events: MaybeRefOrGetter<readonly Event[]>,
): RosterQuery {
  const participationQueries = useQueries({
    queries: computed(() =>
      toValue(events).map((event) => ({
        queryKey: participationsQueryKey(toValue(orgId), event.id),
        queryFn: async ({ signal }: { signal: AbortSignal }) =>
          fetchParticipations(toValue(orgId), event.id, signal),
      })),
    ),
  });

  const assignmentQueries = useQueries({
    queries: computed(() =>
      toValue(events).map((event) => ({
        queryKey: assignmentsQueryKey(toValue(orgId), event.id),
        queryFn: async ({ signal }: { signal: AbortSignal }) =>
          fetchAssignments(toValue(orgId), event.id, signal),
      })),
    ),
  });

  // Positional, like `usePlan.ts`'s zips: `useQueries` answers in the order it
  // was asked, which is the order of `events`.
  const participants = computed(() => {
    const byEvent = new Map<string, readonly Participation[]>();
    toValue(events).forEach((event, index) => {
      const answer = participationQueries.value[index]?.data;
      byEvent.set(event.id, answer?.ok === true ? answer.value : []);
    });
    return byEvent;
  });

  const assignments = computed(() =>
    toValue(events).flatMap((_event, index) => {
      const answer = assignmentQueries.value[index]?.data;
      return answer?.ok === true ? [...answer.value] : [];
    }),
  );

  return {
    participants,
    assignments,
    isPending: computed(() =>
      toValue(events).some(
        (_event, index) =>
          participationQueries.value[index]?.data === undefined ||
          assignmentQueries.value[index]?.data === undefined,
      ),
    ),
    participantsFailed: computed(() =>
      participationQueries.value.some((query) => query.data?.ok === false),
    ),
    assignmentsFailed: computed(() =>
      assignmentQueries.value.some((query) => query.data?.ok === false),
    ),
  };
}
