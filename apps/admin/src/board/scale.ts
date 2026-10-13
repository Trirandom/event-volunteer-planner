// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The time↔pixel scale the mission board is laid out from.
 *
 * docs/02 §7 settles the shape: the horizontal axis is a **continuous** time
 * scale and shift blocks are absolutely positioned on it, not cells in a
 * table. That is what makes uneven slot lengths free — a row of 45-minute
 * *artiste* slots sits beside a row of 2-hour bar slots with no special case
 * (ADR-0029) — and it is why this module exists as arithmetic rather than as
 * a column index.
 *
 * The scale is **piecewise** linear rather than linear, because a festival is
 * mostly not happening. Six days of Soundclash are six stretches of work with
 * five nights and mornings between them, and at any zoom that lets a
 * 45-minute slot be grabbed, those empty stretches are most of the board: the
 * coordinator scrolls past a day of blank axis to compare Friday's bar with
 * Saturday's. So a stretch with nothing in it is **folded** — drawn at a
 * crushed zoom, a few pixels wide, with an ellipsis on it (`folds.ts` decides
 * which).
 *
 * Folding is a change of zoom, never a cut. The map stays continuous,
 * monotonic and invertible across a fold, which is what lets every caller
 * stay written as it was: a bar that happens to span a fold still draws as
 * one box, `msAt` still answers for every pixel of the track, and no handler
 * has to ask whether the instant it holds is on screen.
 *
 * Pure, and test-first: docs/13 §2 exempts the board's *drag feel* from
 * test-first and explicitly does not exempt this. The geometry is the part a
 * pointer handler and a keyboard handler must agree about, so it is the part
 * that is specified.
 *
 * Epoch milliseconds throughout, never `Date`. The board positions instants;
 * turning one into a clock reading is `format/period.ts`'s job and needs the
 * event's zone, which layout does not have and must not guess (docs/16 §1).
 */

/** One linear stretch of the axis: `[startMs, endMs)` laid out from `xStart`
 * at its own zoom. Segments are contiguous and cover the whole scale. */
export interface ScaleSegment {
  readonly startMs: number;
  readonly endMs: number;
  /** Where this stretch begins, in pixels from the left edge of the track. */
  readonly xStart: number;
  readonly pixelsPerMinute: number;
  /** Elided: nothing happens here, so it is drawn at a crushed zoom and the
   * view puts an ellipsis over it. */
  readonly folded: boolean;
}

/**
 * A monotonic map from a window of time onto a width in CSS pixels.
 *
 * A non-empty tuple rather than an array, so that locating a segment needs no
 * `!` and no length check — `segments[0]` always exists, which is the whole
 * base case of the walk below (docs/11 §3 bans the assertion that would
 * otherwise stand in for it).
 */
export interface TimeScale {
  readonly startMs: number;
  readonly endMs: number;
  /** The zoom the *unfolded* stretches are drawn at — what the zoom slider
   * sets, and what a caller means by "how big is an hour here?". */
  readonly pixelsPerMinute: number;
  readonly segments: readonly [ScaleSegment, ...ScaleSegment[]];
}

/** A stretch of time, as `folds.ts` and the view both describe one. */
export interface MsSpan {
  readonly startMs: number;
  readonly endMs: number;
}

const MS_PER_MINUTE = 60_000;

function checkedSpan(startMs: number, endMs: number): void {
  if (!(endMs > startMs)) {
    throw new RangeError('a time scale must span a positive duration');
  }
}

function checkedZoom(pixelsPerMinute: number): void {
  if (!(pixelsPerMinute > 0)) {
    throw new RangeError('a time scale must have a positive zoom');
  }
}

function widthOf(segment: ScaleSegment): number {
  return (
    ((segment.endMs - segment.startMs) / MS_PER_MINUTE) *
    segment.pixelsPerMinute
  );
}

export function timeScale(
  startMs: number,
  endMs: number,
  pixelsPerMinute: number,
): TimeScale {
  checkedSpan(startMs, endMs);
  checkedZoom(pixelsPerMinute);
  return {
    startMs,
    endMs,
    pixelsPerMinute,
    segments: [{ startMs, endMs, xStart: 0, pixelsPerMinute, folded: false }],
  };
}

/**
 * The same scale with `folds` drawn crushed to `foldedPixels` each.
 *
 * A fold that is not already wider than its marker is dropped rather than
 * applied: collapsing a 20-minute gap at a wide zoom would *widen* it, and an
 * ellipsis promising hidden time over a stretch that was fully visible is a
 * lie about the only thing the ellipsis says. That test is here, in pixels,
 * rather than in `folds.ts`, because it is the only part of the decision that
 * depends on the zoom.
 *
 * Folds are taken in start order, clipped to the scale and skipped where they
 * overlap one already taken. The caller is not required to have done any of
 * that, because the caller is a computed reading live data and a malformed
 * fold list must degrade to a plain axis rather than to a scale whose
 * segments run backwards.
 */
export function foldedTimeScale(
  startMs: number,
  endMs: number,
  pixelsPerMinute: number,
  folds: readonly MsSpan[],
  foldedPixels: number,
): TimeScale {
  checkedSpan(startMs, endMs);
  checkedZoom(pixelsPerMinute);
  if (!(foldedPixels > 0)) {
    throw new RangeError('a fold must be drawn at a positive width');
  }

  const ordered = [...folds].sort((a, b) => a.startMs - b.startMs);
  const segments: ScaleSegment[] = [];
  let cursor = startMs;
  let x = 0;

  function push(spanEndMs: number, folded: boolean): void {
    const segment: ScaleSegment = {
      startMs: cursor,
      endMs: spanEndMs,
      xStart: x,
      pixelsPerMinute: folded
        ? foldedPixels / ((spanEndMs - cursor) / MS_PER_MINUTE)
        : pixelsPerMinute,
      folded,
    };
    segments.push(segment);
    x += widthOf(segment);
    cursor = spanEndMs;
  }

  for (const fold of ordered) {
    const foldStart = Math.max(fold.startMs, cursor);
    const foldEnd = Math.min(fold.endMs, endMs);
    if (foldEnd <= foldStart) {
      continue;
    }
    const natural = ((foldEnd - foldStart) / MS_PER_MINUTE) * pixelsPerMinute;
    if (natural <= foldedPixels) {
      continue;
    }
    if (foldStart > cursor) {
      push(foldStart, false);
    }
    push(foldEnd, true);
  }

  if (cursor < endMs) {
    push(endMs, false);
  }

  const [head, ...tail] = segments;
  if (head === undefined) {
    // Only reachable if a fold covered the entire scale, which `folds.ts`
    // cannot produce — it keeps a margin around every event and there is
    // always at least one. A plain axis is the safe reading of it anyway.
    return timeScale(startMs, endMs, pixelsPerMinute);
  }
  return { startMs, endMs, pixelsPerMinute, segments: [head, ...tail] };
}

/**
 * The segment an instant falls in — the last one starting at or before it.
 *
 * Instants outside the scale fall to the first or last segment and are
 * extrapolated from it, which is what keeps `xOf` unclamped (see below).
 */
function segmentAt(scale: TimeScale, ms: number): ScaleSegment {
  let found: ScaleSegment = scale.segments[0];
  for (const segment of scale.segments) {
    if (ms >= segment.startMs) {
      found = segment;
    }
  }
  return found;
}

function segmentAtX(scale: TimeScale, x: number): ScaleSegment {
  let found: ScaleSegment = scale.segments[0];
  for (const segment of scale.segments) {
    if (x >= segment.xStart) {
      found = segment;
    }
  }
  return found;
}

/** The scale's full extent in CSS pixels — the board's scrollable width. */
export function scaleWidth(scale: TimeScale): number {
  return xOf(scale, scale.endMs);
}

/** Whether an instant falls strictly inside a folded stretch — the test the
 * ruler applies before drawing a label that would land in the ellipsis. */
export function isFolded(scale: TimeScale, ms: number): boolean {
  return scale.segments.some(
    (segment) => segment.folded && ms > segment.startMs && ms < segment.endMs,
  );
}

/**
 * Where an instant sits, in pixels from the left edge.
 *
 * Deliberately unclamped. A festival-wide axis scrolls, and a run that begins
 * before the visible window has to be given a negative offset and clipped by
 * the viewport; a clamping scale would pile every such run onto x=0 and make
 * three different mornings look like the same one.
 */
export function xOf(scale: TimeScale, ms: number): number {
  const segment = segmentAt(scale, ms);
  return (
    segment.xStart +
    ((ms - segment.startMs) / MS_PER_MINUTE) * segment.pixelsPerMinute
  );
}

/** The inverse: which instant a pointer at `x` is pointing at. */
export function msAt(scale: TimeScale, x: number): number {
  const segment = segmentAtX(scale, x);
  return (
    segment.startMs +
    ((x - segment.xStart) / segment.pixelsPerMinute) * MS_PER_MINUTE
  );
}

/**
 * Round an instant onto a grid of `stepMinutes`, measured **from `originMs`**.
 *
 * The origin is an argument rather than the epoch because a coarse step
 * measured from the epoch is measured in UTC: a 120-minute grid from the epoch
 * lands on 00:00 and 02:00 UTC, which in `Europe/Paris` is 02:00 and 04:00
 * local. Anchoring on the event's own start is the only reading that keeps the
 * grid aligned to the thing the coordinator is editing, and it is also what
 * lets a 10:07 start snap to 10:07, 10:22, … rather than to a clock the event
 * does not run on.
 *
 * Integer-valued output for an integer-valued input: `Math.round` on the step
 * count, not on the result, so a half-step never drifts by a millisecond.
 */
export function snapMs(
  ms: number,
  stepMinutes: number,
  originMs: number,
): number {
  if (!(stepMinutes > 0)) {
    throw new RangeError('a snap step must be a positive number of minutes');
  }
  const stepMs = stepMinutes * MS_PER_MINUTE;
  return originMs + Math.round((ms - originMs) / stepMs) * stepMs;
}

/**
 * Hold an instant inside `[loMs, hiMs]`.
 *
 * Every edge the board writes is clamped to its event's own period, because
 * "a shift cannot fall outside its event" is one of the six hard rules
 * (docs/02 §5) and is enforced by a constraint trigger. Clamping here means a
 * coordinator dragging past the end of the last day feels the edge instead of
 * collecting a 422.
 */
export function clampMs(ms: number, loMs: number, hiMs: number): number {
  if (loMs > hiMs) {
    throw new RangeError('cannot clamp to an inverted window');
  }
  return Math.min(Math.max(ms, loMs), hiMs);
}
