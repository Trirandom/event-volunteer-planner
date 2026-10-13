// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The availability board's arithmetic: what each volunteer can work, and what
 * a coordinator's edit to it has to write.
 *
 * The board draws one chip per stretch somebody is available for, and a
 * coordinator drags those chips directly — shorter, longer, split in two,
 * gone, new. That gesture is not what the database stores, and the distance
 * between the two is the whole reason this module exists.
 *
 * **Two layers, one reading.** A window is either *submitted*, derived from
 * what the volunteer answered on the form, or *declared*, entered by hand by a
 * coordinator (docs/03 §3.5, and the provenance CHECK that makes it exactly
 * one of the two). A declared window may now overlap a submitted one: that is
 * an override, not a contradiction (migration
 * `20260918141853_availability_windows_provenance_exclusion`). So what the
 * board draws is the *effective* reading of both layers,
 *
 *     base      = submitted available  −  submitted unavailable
 *     effective = (base − declared unavailable)  ∪  declared available
 *
 * and an edit is expressed by the inverse, which is where the guarantee lives:
 *
 *     declared available   = effective − base
 *     declared unavailable = base − effective
 *
 * Editing therefore **never touches what the volunteer submitted**. Shrinking
 * a chip that came from a form answer does not shorten that answer; it writes
 * a coordinator's "not this part" over it, which is recoverable, auditable,
 * and exactly what the replace endpoint is for (docs/04). The submitted rows
 * stay readable on the submissions page for the rest of the production.
 *
 * **Chips are stretches, not kinds.** Everything drawn is time somebody *can*
 * work; the space between chips is time they have not offered. An explicit
 * "unavailable" is written only where it overrides an offer, which is the case
 * that changes an answer. A coordinator who wants to record "she told me she
 * cannot do Sunday" about a day the volunteer never offered has nothing to
 * shorten, and that stretch stays *unknown* rather than becoming a refusal —
 * docs/03 §3.5 keeps those two apart on purpose, and the roster reads them
 * differently.
 *
 * Pure, and specified rather than felt: docs/13 §2 exempts a board's drag
 * *feel* from test-first and does not exempt this. A wrong answer here does
 * not misplace a chip, it tells a coordinator somebody is free on a night they
 * are not.
 */
import { Temporal } from '@evp/shared/time';

import type { Event } from '../api/events';
import type { Participation } from '../api/participations';

const MS_PER_MINUTE = 60_000;

/** A half-open stretch of time, in the epoch milliseconds the boards measure
 * everything in (`board/scale.ts`). */
export interface Span {
  readonly startMs: number;
  readonly endMs: number;
}

export type AvailabilityKind = 'available' | 'unavailable';

/** One window as the replace has to send it back. */
export interface DeclaredWindow {
  readonly kind: AvailabilityKind;
  readonly startMs: number;
  readonly endMs: number;
}

/** `Date.parse` is banned (docs/16 §4) and rightly: it accepts what is not
 * RFC 3339 and answers `NaN` for the rest, which on a board is a chip at the
 * left edge of the epoch rather than an error. */
function msOf(iso: string): number {
  return Temporal.Instant.from(iso).epochMilliseconds;
}

// ---------------------------------------------------------------------------
// Interval algebra
// ---------------------------------------------------------------------------

/**
 * Sorted, non-overlapping, and with touching stretches folded into one.
 *
 * Touching folds for the reason the shift board's bars do (`board/runs.ts`):
 * 14:00–18:00 beside 18:00–22:00 is one stretch of availability, and drawing
 * it as two chips would invite a coordinator to close a gap that is not there.
 */
export function normalise(spans: readonly Span[]): readonly Span[] {
  const ordered = [...spans]
    .filter((span) => span.endMs > span.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  const merged: Span[] = [];
  for (const span of ordered) {
    const last = merged.at(-1);
    if (last !== undefined && span.startMs <= last.endMs) {
      merged[merged.length - 1] = {
        startMs: last.startMs,
        endMs: Math.max(last.endMs, span.endMs),
      };
      continue;
    }
    // Rebuilt rather than passed through: callers hand this whole windows —
    // which carry a kind and a provenance — and a span that kept those fields
    // would smuggle one layer's reading into the other's arithmetic.
    merged.push({ startMs: span.startMs, endMs: span.endMs });
  }
  return merged;
}

/** Everything in `from` that `cut` does not cover. */
export function subtract(
  from: readonly Span[],
  cut: readonly Span[],
): readonly Span[] {
  const holes = normalise(cut);
  const kept: Span[] = [];

  for (const span of normalise(from)) {
    let cursor = span.startMs;
    for (const hole of holes) {
      if (hole.endMs <= cursor || hole.startMs >= span.endMs) {
        continue;
      }
      if (hole.startMs > cursor) {
        kept.push({ startMs: cursor, endMs: hole.startMs });
      }
      cursor = Math.max(cursor, hole.endMs);
    }
    if (cursor < span.endMs) {
      kept.push({ startMs: cursor, endMs: span.endMs });
    }
  }
  return kept;
}

/** Both, folded together. */
export function union(a: readonly Span[], b: readonly Span[]): readonly Span[] {
  return normalise([...a, ...b]);
}

// ---------------------------------------------------------------------------
// The two layers
// ---------------------------------------------------------------------------

interface Window {
  readonly kind: AvailabilityKind;
  readonly declared: boolean;
  readonly startMs: number;
  readonly endMs: number;
}

function windowsOf(person: Participation): readonly Window[] {
  return person.availability.map((window) => ({
    kind: window.kind,
    // A window from before `provenance` existed means what it always did: a
    // coordinator's own declaration (`api/participations.ts`).
    declared: (window.provenance ?? 'declared') === 'declared',
    startMs: msOf(window.period.start),
    endMs: msOf(window.period.end),
  }));
}

function pick(
  windows: readonly Window[],
  declared: boolean,
  kind: AvailabilityKind,
): readonly Span[] {
  return normalise(
    windows.filter(
      (window) => window.declared === declared && window.kind === kind,
    ),
  );
}

/** What the volunteer themself offered: their `available` answers, less any
 * `unavailable` one they gave alongside. */
export function submittedBase(person: Participation): readonly Span[] {
  const windows = windowsOf(person);
  return subtract(
    pick(windows, false, 'available'),
    pick(windows, false, 'unavailable'),
  );
}

/** What the board draws: the volunteer's own offer, less what a coordinator
 * struck out, plus what a coordinator added. */
export function effectiveSpans(person: Participation): readonly Span[] {
  const windows = windowsOf(person);
  const base = subtract(
    pick(windows, false, 'available'),
    pick(windows, false, 'unavailable'),
  );
  return union(
    subtract(base, pick(windows, true, 'unavailable')),
    pick(windows, true, 'available'),
  );
}

/**
 * The declared windows that express `wanted` against `base` — the inverse of
 * [`effectiveSpans`], and the body of the replace.
 *
 * The two halves cannot overlap each other by construction, which is what
 * satisfies the provenance-scoped exclusion constraint without the board
 * having to think about it: one is what `base` lacks, the other is what `base`
 * has too much of.
 */
export function declaredWindows(
  base: readonly Span[],
  wanted: readonly Span[],
): readonly DeclaredWindow[] {
  const added = subtract(wanted, base).map((span): DeclaredWindow => ({
    kind: 'available',
    ...span,
  }));
  const struck = subtract(base, wanted).map((span): DeclaredWindow => ({
    kind: 'unavailable',
    ...span,
  }));
  return [...added, ...struck].sort((a, b) => a.startMs - b.startMs);
}

// ---------------------------------------------------------------------------
// Editing one track's chips
// ---------------------------------------------------------------------------

function snap(ms: number, stepMinutes: number, originMs: number): number {
  if (!(stepMinutes > 0)) {
    throw new RangeError('a snap step must be a positive number of minutes');
  }
  const stepMs = stepMinutes * MS_PER_MINUTE;
  return originMs + Math.round((ms - originMs) / stepMs) * stepMs;
}

/**
 * Hold `ms` inside `[loMs, hiMs]`, or `null` for a window that has run
 * backwards.
 *
 * `board/scale.ts`'s `clampMs` throws on an inverted window, which is right
 * there and wrong here: a chip already wedged one step from its neighbour is
 * an ordinary thing to grab, and a drag that cannot move has to do nothing
 * rather than take the page down with it.
 */
function held(ms: number, loMs: number, hiMs: number): number | null {
  return loMs > hiMs ? null : Math.min(Math.max(ms, loMs), hiMs);
}

/** Where an edge may land: its own neighbour, or the day. */
function edgeLimit(
  spans: readonly Span[],
  index: number,
  edge: 'start' | 'end',
  bounds: Span,
): number {
  if (edge === 'end') {
    return Math.min(spans[index + 1]?.startMs ?? bounds.endMs, bounds.endMs);
  }
  return Math.max(spans[index - 1]?.endMs ?? bounds.startMs, bounds.startMs);
}

/**
 * Move one chip's edge to `toMs`, snapped, and held inside its neighbours and
 * the day.
 *
 * An edge pushed all the way onto its neighbour merges the two, because
 * [`normalise`] folds what touches — the same reading the shift board gives
 * the same gesture, and the honest one: there is no gap left to draw.
 */
export function moveEdge(
  spans: readonly Span[],
  index: number,
  edge: 'start' | 'end',
  toMs: number,
  stepMinutes: number,
  bounds: Span,
): readonly Span[] {
  const subject = spans[index];
  if (subject === undefined) {
    return spans;
  }

  const floorMs = stepMinutes * MS_PER_MINUTE;
  const snapped = snap(toMs, stepMinutes, bounds.startMs);
  const limit = edgeLimit(spans, index, edge, bounds);

  const settled =
    edge === 'end'
      ? held(snapped, subject.startMs + floorMs, limit)
      : held(snapped, limit, subject.endMs - floorMs);

  if (settled === null) {
    return spans;
  }

  return normalise(
    spans.map((span, at) => {
      if (at !== index) {
        return span;
      }
      return edge === 'end'
        ? { startMs: span.startMs, endMs: settled }
        : { startMs: settled, endMs: span.endMs };
    }),
  );
}

/**
 * Break one chip in two at `atMs`, taking `gapMinutes` out of it.
 *
 * A gap rather than a boundary, for the reason `board/edit.ts` gives at
 * length: two stretches that touch are one stretch on the next render, so
 * "these are two separate windows" can only be said by leaving some time out.
 * Unchanged where the split would leave nothing on one side — that gesture is
 * an edge drag, and is not what a double click said.
 */
export function splitSpan(
  spans: readonly Span[],
  index: number,
  atMs: number,
  gapMinutes: number,
): readonly Span[] {
  if (!(gapMinutes > 0)) {
    throw new RangeError('a split gap must be a positive number of minutes');
  }
  const subject = spans[index];
  if (subject === undefined) {
    return spans;
  }

  const fromMs = atMs;
  const toMs = atMs + gapMinutes * MS_PER_MINUTE;
  if (fromMs <= subject.startMs || toMs >= subject.endMs) {
    return spans;
  }

  return normalise([
    ...spans.filter((_span, at) => at !== index),
    { startMs: subject.startMs, endMs: fromMs },
    { startMs: toMs, endMs: subject.endMs },
  ]);
}

/** The middle of a chip, on the grid — where a split with no pointer behind it
 * goes. Anchored on the chip's own start rather than on the epoch, so the cut
 * lands on the clock the event runs on (`board/scale.ts`'s `snapMs`). */
export function middleOf(span: Span, stepMinutes: number): number {
  return snap(
    span.startMs + (span.endMs - span.startMs) / 2,
    stepMinutes,
    span.startMs,
  );
}

/** Remove one chip outright. */
export function removeSpan(
  spans: readonly Span[],
  index: number,
): readonly Span[] {
  return spans.filter((_span, at) => at !== index);
}

/**
 * A new chip across the stretch a drag covered, held inside the empty space
 * the gesture started in.
 *
 * The list comes back unchanged when the anchor is already inside a chip —
 * that gesture is an edge drag — when it is outside the day, or when what
 * survives clamping is shorter than one step, which is a click rather than a
 * drag.
 */
export function createSpan(
  spans: readonly Span[],
  anchorMs: number,
  toMs: number,
  stepMinutes: number,
  bounds: Span,
): readonly Span[] {
  if (
    anchorMs < bounds.startMs ||
    anchorMs >= bounds.endMs ||
    spans.some((span) => anchorMs >= span.startMs && anchorMs < span.endMs)
  ) {
    return spans;
  }

  const loMs = spans
    .filter((span) => span.endMs <= anchorMs)
    .reduce((lo, span) => Math.max(lo, span.endMs), bounds.startMs);
  const hiMs = spans
    .filter((span) => span.startMs >= anchorMs)
    .reduce((hi, span) => Math.min(hi, span.startMs), bounds.endMs);

  const startMs = held(
    snap(Math.min(anchorMs, toMs), stepMinutes, bounds.startMs),
    loMs,
    hiMs,
  );
  const endMs = held(
    snap(Math.max(anchorMs, toMs), stepMinutes, bounds.startMs),
    loMs,
    hiMs,
  );

  if (
    startMs === null ||
    endMs === null ||
    endMs - startMs < stepMinutes * MS_PER_MINUTE
  ) {
    return spans;
  }
  return normalise([...spans, { startMs, endMs }]);
}

/** The first stretch of at least `minMinutes` that no chip claims — where a
 * keyboard-only "add" plants one, having no drag to anchor on. */
export function firstFreeGap(
  spans: readonly Span[],
  bounds: Span,
  minMinutes: number,
): Span | null {
  const minMs = minMinutes * MS_PER_MINUTE;
  let cursor = bounds.startMs;

  for (const span of normalise(spans)) {
    if (span.startMs - cursor >= minMs) {
      return { startMs: cursor, endMs: span.startMs };
    }
    cursor = Math.max(cursor, span.endMs);
  }
  return bounds.endMs - cursor >= minMs
    ? { startMs: cursor, endMs: bounds.endMs }
    : null;
}

// ---------------------------------------------------------------------------
// The rows the board draws
// ---------------------------------------------------------------------------

/** One volunteer's availability on one day: the unit a replace is sent for,
 * because a participation is one volunteer in one edition (docs/03 §3.5). */
export interface AvailabilityTrack {
  readonly participationId: string;
  readonly eventId: string;
  readonly eventName: string;
  readonly timezone: string;
  /** The day's palette index, so a chip reads in the colour its day has on the
   * strip under the ruler (`board/eventLanes.ts`). */
  readonly color: number;
  /**
   * The day itself, and the wall every chip on it is held inside.
   *
   * A window belongs to one participation and a participation to one edition,
   * so a chip reaching into the next day would be a claim about a
   * participation that is not this one — and, on a festival-wide axis, would
   * be drawn over the track that owns those hours.
   */
  readonly bounds: Span;
  /** What the volunteer offered on their own form — drawn faint under the
   * chips, so a coordinator can see what they are overriding. */
  readonly submitted: readonly Span[];
  /** What the board draws and edits. */
  readonly spans: readonly Span[];
  /** Whether a coordinator has already changed this day's reading. */
  readonly overridden: boolean;
}

export interface AvailabilityRow {
  /** The volunteer, who is the row — not the participation, of which there is
   * one per day and several on a festival-wide axis. */
  readonly key: string;
  readonly name: string;
  readonly tracks: readonly AvailabilityTrack[];
  /** Everything they can work across the days in view, in whole minutes. */
  readonly minutes: number;
}

function sameSpans(a: readonly Span[], b: readonly Span[]): boolean {
  return (
    a.length === b.length &&
    a.every((span, index) => {
      // The optional chain is the undefined check: `undefined` never equals a
      // number, so a short list fails on the first comparison and the second
      // reads a span TypeScript has already narrowed.
      const other = b[index];
      return span.startMs === other?.startMs && span.endMs === other.endMs;
    })
  );
}

function minutesOf(spans: readonly Span[]): number {
  return spans.reduce(
    // Rounded rather than truncated: no boundary in this product is specified
    // below the minute, so a stored instant carrying seconds is noise.
    (total, span) =>
      total + Math.round((span.endMs - span.startMs) / MS_PER_MINUTE),
    0,
  );
}

/**
 * Every enrolled volunteer as a row of chips, laid on the shared axis.
 *
 * Keyed on the volunteer rather than on the participation, because a festival
 * week is one person's availability read across six days, and six rows under
 * one name would be six answers to a question nobody asked twice.
 *
 * A volunteer enrolled with nothing declared still gets a row: an empty lane
 * is where a coordinator draws the first chip, and leaving them out would hide
 * exactly the people this page exists to chase.
 */
export function availabilityRows(
  participantsByEvent: ReadonlyMap<string, readonly Participation[]>,
  days: readonly Event[],
): readonly AvailabilityRow[] {
  const byVolunteer = new Map<
    string,
    { name: string; tracks: AvailabilityTrack[] }
  >();

  for (const day of days) {
    for (const person of participantsByEvent.get(day.id) ?? []) {
      const submitted = submittedBase(person);
      const spans = effectiveSpans(person);

      const row = byVolunteer.get(person.volunteer_id) ?? {
        name: person.display_name,
        tracks: [],
      };
      row.tracks.push({
        participationId: person.id,
        eventId: day.id,
        eventName: day.name,
        timezone: day.timezone,
        color: day.color,
        bounds: {
          startMs: msOf(day.period.start),
          endMs: msOf(day.period.end),
        },
        submitted,
        spans,
        overridden: !sameSpans(submitted, spans),
      });
      byVolunteer.set(person.volunteer_id, row);
    }
  }

  return (
    [...byVolunteer.entries()]
      .map(([key, row]): AvailabilityRow => {
        // Chronological, whatever order the days were fetched in: the row is one
        // timeline and has to read left to right.
        const tracks = [...row.tracks].sort(
          (a, b) => a.bounds.startMs - b.bounds.startMs,
        );
        return {
          key,
          name: row.name,
          tracks,
          minutes: tracks.reduce(
            (total, track) => total + minutesOf(track.spans),
            0,
          ),
        };
      })
      // By name, and by id where two people share one: a roster that reads in a
      // different order on every render is a roster nobody can scan.
      .sort(
        (a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key),
      )
  );
}
