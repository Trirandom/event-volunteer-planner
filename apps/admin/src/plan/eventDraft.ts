// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * What the event details form holds, and what it would send.
 *
 * Split out of the component because this is the part that can be wrong in a
 * way nobody notices. A form over four timestamps in an event's own timezone
 * has two failure modes that look identical on screen — sending a change
 * nobody made, and sending nothing when a change was made — and both of them
 * are arithmetic, not layout. The component owns the fields; this owns the
 * answer to "did anything actually move, and is what I have sendable".
 *
 * Everything here is in the **event's** zone, never the browser's: the fields
 * are wall-clock readings a coordinator types about a festival in Paris while
 * sitting in Berlin (docs/16 §1, ADR-0019). Conversion happens at both edges
 * of this module and nowhere in the component.
 */
import { Temporal } from '@evp/shared/time';

import { instantFromLocal, localFromInstant } from '../format/period';
import type { Event, EventDetailsInput } from '../api/events';

/**
 * The form's state: five `<input>` values.
 *
 * The door fields are `''` when the event publishes no door times, which is a
 * real and common answer rather than a missing one — an empty pair is what the
 * form sends as `null`. Both must be empty or both filled; one of each is the
 * coordinator halfway through typing, not a state the API has a shape for.
 */
export interface EventDraft {
  readonly start: string;
  readonly end: string;
  readonly doorsOpen: string;
  readonly doorsClose: string;
  readonly color: number;
}

/** The stored event, as the fields that would reproduce it. */
export function draftOf(event: Event): EventDraft {
  const zone = event.timezone;
  const doors = event.public_period;
  return {
    start: localFromInstant(event.period.start, zone),
    end: localFromInstant(event.period.end, zone),
    doorsOpen: doors === undefined ? '' : localFromInstant(doors.start, zone),
    doorsClose: doors === undefined ? '' : localFromInstant(doors.end, zone),
    color: event.color,
  };
}

/**
 * Why a draft cannot be sent.
 *
 * Named rather than pre-worded so the component owns the sentence and this
 * module stays free of copy. Each one mirrors a refusal the server would make
 * anyway — the point of catching them here is that a coordinator finds out
 * while looking at the field, not after a round trip.
 */
export type DraftProblem =
  | 'start-missing'
  | 'end-missing'
  | 'period-inverted'
  | 'doors-half-stated'
  | 'doors-inverted'
  | 'doors-outside-period';

/**
 * A wall-clock field as a UTC instant, or `null` if it is not a reading at all.
 *
 * `Temporal.PlainDateTime.from` throws on anything it cannot parse, and an
 * empty or half-typed `datetime-local` is exactly that. Catching rather than
 * validating with a regexp is deliberate: the parser is the authority on what
 * it accepts, and a second opinion here would eventually disagree with it.
 */
function instantOrNull(
  value: string,
  timezone: string,
): Temporal.Instant | null {
  if (value === '') {
    return null;
  }
  try {
    return Temporal.Instant.from(instantFromLocal(value, timezone));
  } catch {
    return null;
  }
}

/** Epoch milliseconds, for comparisons that must not be string comparisons —
 * two instants written with different offsets order wrongly as text. */
function msOf(instant: Temporal.Instant | string): number {
  return typeof instant === 'string'
    ? Temporal.Instant.from(instant).epochMilliseconds
    : instant.epochMilliseconds;
}

/**
 * The first thing wrong with a draft, or `null`.
 *
 * First, not all: the fields are shown together and fixing the earliest
 * problem often resolves the rest, so a list of six would mostly be noise.
 */
export function draftProblem(
  draft: EventDraft,
  timezone: string,
): DraftProblem | null {
  const start = instantOrNull(draft.start, timezone);
  if (start === null) {
    return 'start-missing';
  }
  const end = instantOrNull(draft.end, timezone);
  if (end === null) {
    return 'end-missing';
  }
  if (msOf(end) <= msOf(start)) {
    return 'period-inverted';
  }

  const open = instantOrNull(draft.doorsOpen, timezone);
  const close = instantOrNull(draft.doorsClose, timezone);
  if (open === null && close === null) {
    return null;
  }
  if (open === null || close === null) {
    return 'doors-half-stated';
  }
  if (msOf(close) <= msOf(open)) {
    return 'doors-inverted';
  }
  // `events_public_period_valid` — the doors are open *during* the event.
  // Refused here as well as in the database because the database's answer is a
  // 422 about a constraint name, and this one can point at the field.
  if (msOf(open) < msOf(start) || msOf(close) > msOf(end)) {
    return 'doors-outside-period';
  }
  return null;
}

/**
 * What to send, or `null` when the draft says the same thing the event does.
 *
 * Compared as instants and not as field text, so re-rendering the form, or a
 * coordinator typing a value back to what it was, sends nothing. A PATCH the
 * server would accept and that changes no column is not harmless here: it
 * bumps `version`, invalidating whatever anybody else has open, and writes an
 * `operations` row that an undo will later offer to reverse (ADR-0024).
 *
 * Returns `undefined`-free keys under `exactOptionalPropertyTypes`: an absent
 * key means "not part of this change", and `public_period: null` — a real
 * value meaning "no published hours" — is why the doors are the one field
 * this can emit as `null`.
 */
export function draftChanges(
  event: Event,
  draft: EventDraft,
): EventDetailsInput | null {
  if (draftProblem(draft, event.timezone) !== null) {
    return null;
  }

  const zone = event.timezone;
  const start = instantOrNull(draft.start, zone);
  const end = instantOrNull(draft.end, zone);
  if (start === null || end === null) {
    return null;
  }

  const changes: {
    period?: { start: string; end: string };
    publicPeriod?: { start: string; end: string } | null;
    color?: number;
  } = {};

  if (
    msOf(start) !== msOf(event.period.start) ||
    msOf(end) !== msOf(event.period.end)
  ) {
    changes.period = { start: start.toString(), end: end.toString() };
  }

  const open = instantOrNull(draft.doorsOpen, zone);
  const close = instantOrNull(draft.doorsClose, zone);
  const stored = event.public_period;
  if (open === null || close === null) {
    // Cleared — but only worth sending if there was something to clear.
    if (stored !== undefined) {
      changes.publicPeriod = null;
    }
  } else if (
    stored === undefined ||
    msOf(open) !== msOf(stored.start) ||
    msOf(close) !== msOf(stored.end)
  ) {
    changes.publicPeriod = { start: open.toString(), end: close.toString() };
  }

  if (draft.color !== event.color) {
    changes.color = draft.color;
  }

  return Object.keys(changes).length === 0 ? null : changes;
}
