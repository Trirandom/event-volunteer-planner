// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * What one detail page covers: a festival, or one day of it.
 *
 * There is one detail page, not a festival page and an event page. A
 * coordinator does not staff a Saturday, they staff Soundclash 26 — the
 * missions, the shifts, the volunteer form behind them and the availability
 * volunteers answer with are all declared for the whole production and then
 * read one day at a time. Two pages made that two questions, and "who is
 * still not staffed?" had to be assembled by hand out of six answers.
 *
 * The database does not store it that way, and deliberately: a mission and
 * its shifts hang off an *event*, never off a festival, because Open Air's
 * bar and Dub & 2step's bar are staffed and reported on independently
 * (ADR-0032, whose rejected alternatives are worth reading before revisiting
 * that). The whole is therefore assembled here, on the way out, rather than
 * pretended into the schema. `days` is every event this page covers and
 * `selected` is the one the coordinator has narrowed to, if any; a page with
 * no selection is the festival entire.
 *
 * Pure, and takes rows that are already loaded rather than fetching them —
 * which days are in scope, and what a standalone event scopes to, is the part
 * worth proving without a server (docs/13 §8).
 */
import { Temporal } from '@evp/shared/time';

import type { Event } from '../api/events';
import type { Festival, FestivalDetail } from '../api/festivals';
import { t } from '../i18n';

export type PlanScope =
  | {
      readonly kind: 'festival';
      readonly festival: Festival;
      readonly days: readonly Event[];
      readonly selected: null;
    }
  | {
      readonly kind: 'event';
      /** `null` for a standalone event: it is its own whole. */
      readonly festival: Festival | null;
      readonly days: readonly Event[];
      readonly selected: Event;
    };

function startsAt(event: Event): number {
  return Temporal.Instant.from(event.period.start).epochMilliseconds;
}

/** Soonest first: a festival reads as the sequence of days it is run in, and
 * the day strip is that sequence. */
export function chronological(events: readonly Event[]): readonly Event[] {
  return [...events].sort((a, b) => startsAt(a) - startsAt(b));
}

/** The whole production. */
export function festivalScope(festival: FestivalDetail): PlanScope {
  return {
    kind: 'festival',
    festival,
    days: chronological(festival.events),
    selected: null,
  };
}

/**
 * One day of a festival, or a standalone event.
 *
 * The selected event is appended when the festival's own inlined `events` do
 * not mention it, rather than the page rendering a day strip the coordinator
 * is demonstrably not on. That happens whenever the two queries are
 * momentarily out of step — an event created in another tab — and
 * `agenda.ts` resolves the same race the same way.
 */
export function eventScope(
  event: Event,
  festival: FestivalDetail | null,
): PlanScope {
  if (festival === null) {
    return { kind: 'event', festival: null, days: [event], selected: event };
  }

  const known = festival.events.some((day) => day.id === event.id);
  return {
    kind: 'event',
    festival,
    days: chronological(known ? festival.events : [...festival.events, event]),
    selected: event,
  };
}

/** Everything a heading needs, from whichever row the page is describing.
 * `Festival` and `Event` agree on this shape on the wire, which is why one
 * page can render either without asking which it has. */
export interface PlanSubject {
  readonly name: string;
  readonly slug: string;
  readonly status: string;
  readonly timezone: string;
  readonly period: { readonly start: string; readonly end: string };
}

/** What the heading describes: the selected day when there is one, the
 * festival otherwise. */
export function planSubject(scope: PlanScope): PlanSubject {
  return scope.kind === 'festival' ? scope.festival : scope.selected;
}

/** The day the coordinator has narrowed to, or `null` for the whole
 * festival. Missions and submissions are fetched for `days` either way; this
 * only says which of them is in front. */
export function focusedEventId(scope: PlanScope): string | null {
  return scope.selected?.id ?? null;
}

/** A festival's or event's `status`, in words. The API keeps it an open
 * string, so a status this build does not know is shown as sent rather than
 * hidden. */
export function statusLabel(status: string): string {
  return t('plan.status', { status });
}
