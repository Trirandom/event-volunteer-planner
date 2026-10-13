// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { Temporal } from '@evp/shared/time';
import { describe, expect, it } from 'vitest';

import {
  clampMs,
  foldedTimeScale,
  isFolded,
  msAt,
  scaleWidth,
  snapMs,
  timeScale,
  xOf,
  type TimeScale,
} from './scale';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** 5 Sept 2026, 08:00Z — an arbitrary origin, named once so the arithmetic
 * below reads as offsets rather than as epoch numbers. */
const ORIGIN = Temporal.Instant.from('2026-09-05T08:00:00Z').epochMilliseconds;

function tenHours(pixelsPerMinute = 1): TimeScale {
  return timeScale(ORIGIN, ORIGIN + 10 * HOUR, pixelsPerMinute);
}

describe('timeScale', () => {
  it('is as wide as its domain is long', () => {
    expect(scaleWidth(tenHours(1))).toBe(600);
    expect(scaleWidth(tenHours(0.5))).toBe(300);
  });

  it('refuses a domain that does not move forward', () => {
    expect(() => timeScale(ORIGIN, ORIGIN, 1)).toThrow();
    expect(() => timeScale(ORIGIN, ORIGIN - HOUR, 1)).toThrow();
  });

  it('refuses a scale with no extent', () => {
    expect(() => timeScale(ORIGIN, ORIGIN + HOUR, 0)).toThrow();
    expect(() => timeScale(ORIGIN, ORIGIN + HOUR, -1)).toThrow();
  });
});

describe('xOf', () => {
  it('puts the domain start at the left edge', () => {
    expect(xOf(tenHours(), ORIGIN)).toBe(0);
  });

  it('puts the domain end at the full width', () => {
    const scale = tenHours();
    expect(xOf(scale, ORIGIN + 10 * HOUR)).toBe(scaleWidth(scale));
  });

  it('is linear in between', () => {
    expect(xOf(tenHours(2), ORIGIN + 90 * MINUTE)).toBe(180);
  });

  /** Not clamped: a run that starts before the visible window has to be
   * positioned at a negative offset and clipped by the viewport, and a
   * clamping scale would silently stack every such run on the left edge. */
  it('runs off both ends rather than clamping', () => {
    expect(xOf(tenHours(), ORIGIN - HOUR)).toBe(-60);
    expect(xOf(tenHours(), ORIGIN + 11 * HOUR)).toBe(660);
  });
});

describe('msAt', () => {
  it('inverts xOf', () => {
    const scale = tenHours(1.5);
    const instant = ORIGIN + 3 * HOUR + 20 * MINUTE;
    expect(msAt(scale, xOf(scale, instant))).toBe(instant);
  });

  it('reads the left edge as the domain start', () => {
    expect(msAt(tenHours(), 0)).toBe(ORIGIN);
  });
});

/**
 * The board elides the hours nothing runs in, and the elision is a change of
 * zoom rather than a cut: the map stays monotonic and invertible across a
 * fold, which is what lets a bar spanning one still draw as a single box and
 * `msAt` still answer for every pixel of the track.
 */
describe('foldedTimeScale', () => {
  const FOLD_PX = 40;

  /** One px/minute, ten hours, with hours 4–8 folded: 360 unfolded minutes at
   * 1 px each, plus the 40 px the fold is drawn at. */
  function withMidFold(pixelsPerMinute = 1): TimeScale {
    return foldedTimeScale(
      ORIGIN,
      ORIGIN + 10 * HOUR,
      pixelsPerMinute,
      [{ startMs: ORIGIN + 4 * HOUR, endMs: ORIGIN + 8 * HOUR }],
      FOLD_PX,
    );
  }

  it('is as wide as its visible time plus one marker per fold', () => {
    expect(scaleWidth(withMidFold())).toBe(6 * 60 + FOLD_PX);
  });

  it('lays the time before a fold exactly as an unfolded axis would', () => {
    expect(xOf(withMidFold(), ORIGIN + 90 * MINUTE)).toBe(90);
    expect(xOf(withMidFold(), ORIGIN + 4 * HOUR)).toBe(240);
  });

  it('spends one marker on the fold and resumes after it', () => {
    const scale = withMidFold();
    expect(xOf(scale, ORIGIN + 8 * HOUR)).toBe(240 + FOLD_PX);
    expect(xOf(scale, ORIGIN + 9 * HOUR)).toBe(240 + FOLD_PX + 60);
  });

  /** The property every caller leans on without saying so: a bar that happens
   * to span a fold is still one box, `Home` still lands left of `End`, and a
   * pointer moving right never reads an earlier instant. */
  it('stays monotonic and invertible across the fold', () => {
    const scale = withMidFold(1.5);
    const probes = [0, 2, 4, 5, 6, 8, 9.5, 10].map(
      (hours) => ORIGIN + hours * HOUR,
    );

    const positions = probes.map((ms) => xOf(scale, ms));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    for (const ms of probes) {
      expect(msAt(scale, xOf(scale, ms))).toBeCloseTo(ms, 6);
    }
  });

  /** Unclamped on both sides, exactly as the plain scale is, and off the
   * *outer* segments rather than off a fold — otherwise a run beginning an
   * hour before the window would be positioned as though that hour were one of
   * the crushed ones. */
  it('runs off both ends at the outer segments\u2019 zoom', () => {
    const scale = withMidFold();
    expect(xOf(scale, ORIGIN - HOUR)).toBe(-60);
    expect(xOf(scale, ORIGIN + 11 * HOUR)).toBe(6 * 60 + FOLD_PX + 60);
  });

  /**
   * Collapsing a stretch that is already narrower than its own marker would
   * *widen* it, and an ellipsis promising hidden time over a stretch that was
   * fully in view is a lie about the only thing an ellipsis says. Which is
   * also what makes zooming out a way back to the continuous axis.
   */
  it('drops a fold that its zoom has already made small enough', () => {
    const zoomedOut = foldedTimeScale(
      ORIGIN,
      ORIGIN + 10 * HOUR,
      0.1,
      [{ startMs: ORIGIN + 4 * HOUR, endMs: ORIGIN + 8 * HOUR }],
      FOLD_PX,
    );

    // 4 hours at 0.1 px/minute is 24 px — under the marker, so nothing is
    // folded and the axis is its plain 600-minute self.
    expect(scaleWidth(zoomedOut)).toBeCloseTo(60, 6);
    expect(isFolded(zoomedOut, ORIGIN + 6 * HOUR)).toBe(false);
  });

  it('reports which instants are inside a fold, edges excluded', () => {
    const scale = withMidFold();
    expect(isFolded(scale, ORIGIN + 6 * HOUR)).toBe(true);
    // The two edges are where the ticks that frame the fold sit; they are on
    // the visible segments, not in the ellipsis.
    expect(isFolded(scale, ORIGIN + 4 * HOUR)).toBe(false);
    expect(isFolded(scale, ORIGIN + 8 * HOUR)).toBe(false);
    expect(isFolded(scale, ORIGIN + HOUR)).toBe(false);
  });

  it('folds several stretches in one axis', () => {
    const scale = foldedTimeScale(
      ORIGIN,
      ORIGIN + 12 * HOUR,
      1,
      [
        { startMs: ORIGIN + 2 * HOUR, endMs: ORIGIN + 5 * HOUR },
        { startMs: ORIGIN + 7 * HOUR, endMs: ORIGIN + 10 * HOUR },
      ],
      FOLD_PX,
    );

    expect(scaleWidth(scale)).toBe(6 * 60 + 2 * FOLD_PX);
    expect(xOf(scale, ORIGIN + 6 * HOUR)).toBe(120 + FOLD_PX + 60);
  });

  /**
   * The caller is a computed over live data, so a malformed list has to
   * degrade to a plain axis rather than to a scale whose segments run
   * backwards and whose bars land in 1970.
   */
  it('tolerates folds that are out of order, overlapping or outside', () => {
    const scale = foldedTimeScale(
      ORIGIN,
      ORIGIN + 10 * HOUR,
      1,
      [
        { startMs: ORIGIN + 6 * HOUR, endMs: ORIGIN + 8 * HOUR },
        { startMs: ORIGIN + 4 * HOUR, endMs: ORIGIN + 7 * HOUR },
        { startMs: ORIGIN - 5 * HOUR, endMs: ORIGIN - HOUR },
      ],
      FOLD_PX,
    );

    // Taken in start order: 4–7, then what is left of 6–8, which is 7–8. The
    // fold before the axis is clipped away entirely. Six hours stay visible
    // and the two folds cost a marker each.
    expect(scaleWidth(scale)).toBe(6 * 60 + 2 * FOLD_PX);
    expect(isFolded(scale, ORIGIN + 5 * HOUR)).toBe(true);
    expect(isFolded(scale, ORIGIN + 7.5 * HOUR)).toBe(true);
    expect(isFolded(scale, ORIGIN + 3 * HOUR)).toBe(false);
  });

  it('is the plain axis when there is nothing to fold', () => {
    const scale = foldedTimeScale(ORIGIN, ORIGIN + 10 * HOUR, 1, [], FOLD_PX);
    expect(scaleWidth(scale)).toBe(scaleWidth(tenHours(1)));
    expect(xOf(scale, ORIGIN + 3 * HOUR)).toBe(
      xOf(tenHours(1), ORIGIN + 3 * HOUR),
    );
  });

  it('refuses a marker with no width', () => {
    expect(() => foldedTimeScale(ORIGIN, ORIGIN + HOUR, 1, [], 0)).toThrow();
  });
});

describe('snapMs', () => {
  /**
   * The origin is an argument, not the epoch, because a 120-minute step
   * measured from the epoch lands on whole UTC hours — which in `Europe/Paris`
   * is 02:00 and 04:00 local, not 00:00 and 02:00. Snapping from the event's
   * own start is the only reading that keeps a coordinator's grid aligned to
   * the thing they are editing.
   */
  it('snaps relative to the origin it is given', () => {
    const origin = ORIGIN + 7 * MINUTE;
    expect(snapMs(origin + 8 * MINUTE, 15, origin)).toBe(origin + 15 * MINUTE);
    expect(snapMs(origin + 7 * MINUTE, 15, origin)).toBe(origin);
  });

  it('rounds to the nearest step, both ways', () => {
    expect(snapMs(ORIGIN + 22 * MINUTE, 15, ORIGIN)).toBe(ORIGIN + 15 * MINUTE);
    expect(snapMs(ORIGIN + 23 * MINUTE, 15, ORIGIN)).toBe(ORIGIN + 30 * MINUTE);
  });

  it('snaps backwards from the origin as readily as forwards', () => {
    expect(snapMs(ORIGIN - 8 * MINUTE, 15, ORIGIN)).toBe(ORIGIN - 15 * MINUTE);
    expect(snapMs(ORIGIN - 7 * MINUTE, 15, ORIGIN)).toBe(ORIGIN);
  });

  it('leaves a value already on the grid alone', () => {
    expect(snapMs(ORIGIN + 2 * HOUR, 15, ORIGIN)).toBe(ORIGIN + 2 * HOUR);
  });

  it('refuses a step that is not a positive number of minutes', () => {
    expect(() => snapMs(ORIGIN, 0, ORIGIN)).toThrow();
    expect(() => snapMs(ORIGIN, -15, ORIGIN)).toThrow();
  });
});

describe('clampMs', () => {
  it('holds a value inside the bounds', () => {
    expect(clampMs(ORIGIN - HOUR, ORIGIN, ORIGIN + HOUR)).toBe(ORIGIN);
    expect(clampMs(ORIGIN + 2 * HOUR, ORIGIN, ORIGIN + HOUR)).toBe(
      ORIGIN + HOUR,
    );
    expect(clampMs(ORIGIN + 30 * MINUTE, ORIGIN, ORIGIN + HOUR)).toBe(
      ORIGIN + 30 * MINUTE,
    );
  });

  /** An inverted window is a caller bug, and returning the low bound would
   * hide it behind a plausible-looking instant. */
  it('refuses an inverted window', () => {
    expect(() => clampMs(ORIGIN, ORIGIN + HOUR, ORIGIN)).toThrow();
  });
});
