// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The order a coordinator reads the planner in: what is coming up, then what
 * has already happened.
 *
 * Pure, and takes `now` as an argument rather than reading it — the whole
 * point of the split is that it is testable without a wall clock (docs/13 §8).
 * The view passes an instant captured once at mount (`time/clock.ts`).
 *
 * Festivals and events are one list here rather than two pages. A festival is
 * an optional grouping above an event (`api/festivals.ts`), not a parallel
 * resource, and a coordinator asking "what is next?" means it across both.
 */
import type { Event } from '../api/events';
import type { Festival } from '../api/festivals';
import { Temporal } from '@evp/shared/time';

/** A festival with its events, or a standalone event. Both carry their own
 * ordering key so the two can be sorted against each other as peers. */
export type AgendaGroup =
  | {
      readonly kind: 'festival';
      readonly key: string;
      readonly festival: Festival;
      /** Chronological, *not* split by past/upcoming: a festival half-way
       * through reads as one block with a marked position in it, and lifting
       * its finished days to the bottom of the page would break the one
       * sequence the coordinator is actually working through. */
      readonly events: readonly Event[];
    }
  | {
      readonly kind: 'event';
      readonly key: string;
      readonly event: Event;
    };

export interface Agenda {
  /** Soonest first — the next thing to staff is the first thing on screen. */
  readonly upcoming: readonly AgendaGroup[];
  /** Most recently finished first: the useful end of the archive is the near
   * end, and it sits directly under the upcoming list. */
  readonly past: readonly AgendaGroup[];
}

function epochMillis(timestamp: string): number {
  return Temporal.Instant.from(timestamp).epochMilliseconds;
}

/**
 * A group has passed once nothing in it is still to come.
 *
 * The *end* decides, not the start: an event running right now is upcoming, in
 * the only sense a coordinator cares about — there are still shifts on it.
 */
function endsAt(group: AgendaGroup): number {
  if (group.kind === 'event') {
    return epochMillis(group.event.period.end);
  }
  // A festival whose events overrun its own declared window is not a shape the
  // schema forbids today, so the latest of the two is what "finished" means
  // rather than trusting the festival row alone.
  return group.events.reduce(
    (latest, event) => Math.max(latest, epochMillis(event.period.end)),
    epochMillis(group.festival.period.end),
  );
}

function startsAt(group: AgendaGroup): number {
  if (group.kind === 'event') {
    return epochMillis(group.event.period.start);
  }
  return group.events.reduce(
    (earliest, event) => Math.min(earliest, epochMillis(event.period.start)),
    epochMillis(group.festival.period.start),
  );
}

/**
 * Builds the list the events page renders.
 *
 * An event whose `festival_id` names a festival that is not in `festivals` is
 * rendered standalone rather than dropped. That happens whenever the two
 * queries are momentarily out of step (a festival created in another tab), and
 * silently hiding an event a coordinator has to staff is the worse failure.
 */
export function buildAgenda(
  events: readonly Event[],
  festivals: readonly Festival[],
  now: Temporal.Instant,
): Agenda {
  const byFestival = new Map<string, Event[]>(
    festivals.map((festival) => [festival.id, []]),
  );

  const standalone: Event[] = [];
  for (const event of events) {
    const siblings =
      event.festival_id === null
        ? undefined
        : byFestival.get(event.festival_id);
    if (siblings === undefined) {
      standalone.push(event);
    } else {
      siblings.push(event);
    }
  }

  const groups: AgendaGroup[] = [
    ...festivals.map((festival): AgendaGroup => {
      const owned = [...(byFestival.get(festival.id) ?? [])].sort(
        (a, b) => epochMillis(a.period.start) - epochMillis(b.period.start),
      );
      return {
        kind: 'festival',
        // Prefixed, because a festival and an event are different rows that
        // may share nothing but a `key` collision in `v-for` otherwise.
        key: `festival:${festival.id}`,
        festival,
        events: owned,
      };
    }),
    ...standalone.map((event): AgendaGroup => ({
      kind: 'event',
      key: `event:${event.id}`,
      event,
    })),
  ];

  const nowMillis = now.epochMilliseconds;
  const upcoming: AgendaGroup[] = [];
  const past: AgendaGroup[] = [];
  for (const group of groups) {
    (endsAt(group) <= nowMillis ? past : upcoming).push(group);
  }

  upcoming.sort((a, b) => startsAt(a) - startsAt(b));
  past.sort((a, b) => endsAt(b) - endsAt(a));

  return { upcoming, past };
}

/**
 * Whether one event is already over — the view marks these inside a festival
 * block, where they keep their chronological place.
 *
 * Takes the period rather than the whole event, so a caller holding a row it
 * has already narrowed does not have to reassemble one to ask.
 */
export function hasPassed(
  period: { readonly end: string },
  now: Temporal.Instant,
): boolean {
  return epochMillis(period.end) <= now.epochMilliseconds;
}
