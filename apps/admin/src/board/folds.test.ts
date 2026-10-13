// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { Temporal } from '@evp/shared/time';
import { describe, expect, it } from 'vitest';

import { axisFolds } from './folds';
import type { MsSpan } from './scale';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** 5 Sept 2026, 08:00Z — an arbitrary origin, named once so the arithmetic
 * below reads as offsets rather than as epoch numbers. */
const ORIGIN = Temporal.Instant.from('2026-09-05T08:00:00Z').epochMilliseconds;

const MARGIN = 120;
const FLOOR = 60;

function span(fromHours: number, toHours: number): MsSpan {
  return { startMs: ORIGIN + fromHours * HOUR, endMs: ORIGIN + toHours * HOUR };
}

/** The axis as the board builds it: the days, plus the margin at each end. */
function axisAround(...windows: readonly MsSpan[]): MsSpan {
  return {
    startMs: Math.min(...windows.map((w) => w.startMs)) - MARGIN * MINUTE,
    endMs: Math.max(...windows.map((w) => w.endMs)) + MARGIN * MINUTE,
  };
}

describe('axisFolds', () => {
  /** A one-day board has nothing between anything. The margins at either end
   * are the drag room, not empty axis to be reclaimed. */
  it('folds nothing when the days are one continuous stretch', () => {
    const day = span(0, 10);
    expect(axisFolds([day], axisAround(day), MARGIN, FLOOR)).toEqual([]);
  });

  /**
   * The feature. Two nights a day apart are twenty hours of blank track at any
   * zoom that lets a slot be grabbed, and the two things being compared are
   * never on screen together.
   */
  it('folds the stretch between two days, margins kept', () => {
    const friday = span(0, 6);
    const saturday = span(30, 36);

    expect(
      axisFolds(
        [friday, saturday],
        axisAround(friday, saturday),
        MARGIN,
        FLOOR,
      ),
    ).toEqual([{ startMs: ORIGIN + 8 * HOUR, endMs: ORIGIN + 28 * HOUR }]);
  });

  /**
   * The margin is the drag room, and the drag is how a day is lengthened: an
   * edge dragged past closing time has to land on time, and the pixel past
   * closing time must therefore not be the ellipsis.
   */
  it('never folds the two hours either side of a day', () => {
    const day = span(0, 6);
    const later = span(40, 46);
    const folds = axisFolds(
      [day, later],
      axisAround(day, later),
      MARGIN,
      FLOOR,
    );

    expect(folds[0]?.startMs).toBe(day.endMs + 2 * HOUR);
    expect(folds[0]?.endMs).toBe(later.startMs - 2 * HOUR);
  });

  /** Four hours apart is four hours of margin and nothing left over — the two
   * days are "close to each other" in the only sense the board has. */
  it('leaves days whose margins touch alone', () => {
    const first = span(0, 6);
    const second = span(10, 16);

    expect(
      axisFolds([first, second], axisAround(first, second), MARGIN, FLOOR),
    ).toEqual([]);
  });

  /** Below the floor an ellipsis costs the continuity of the ruler and buys a
   * reading nobody needed: "half an hour is hidden here". */
  it('leaves a gap shorter than the floor alone', () => {
    const first = span(0, 6);
    const second = span(10.5, 16);

    expect(
      axisFolds([first, second], axisAround(first, second), MARGIN, FLOOR),
    ).toEqual([]);
  });

  it('folds a gap exactly at the floor', () => {
    const first = span(0, 6);
    const second = span(11, 17);

    expect(
      axisFolds([first, second], axisAround(first, second), MARGIN, FLOOR),
    ).toEqual([{ startMs: ORIGIN + 8 * HOUR, endMs: ORIGIN + 9 * HOUR }]);
  });

  /**
   * Concurrent days are the shape `eventLanes` exists for — a main stage and
   * an afterparty — and between them there is no gap at all. Folding the hours
   * the shorter one leaves would hide time the longer one is running.
   */
  it('treats overlapping days as one stretch', () => {
    const main = span(0, 12);
    const inside = span(4, 8);
    const later = span(30, 34);

    expect(
      axisFolds(
        [main, inside, later],
        axisAround(main, inside, later),
        MARGIN,
        FLOOR,
      ),
    ).toEqual([{ startMs: ORIGIN + 14 * HOUR, endMs: ORIGIN + 28 * HOUR }]);
  });

  /** Order is the caller's accident — days arrive in whatever order the
   * queries settled in — and must not be the board's. */
  it('does not depend on the order the days arrive in', () => {
    const first = span(0, 6);
    const second = span(30, 36);
    const third = span(60, 66);
    const axis = axisAround(first, second, third);

    expect(axisFolds([third, first, second], axis, MARGIN, FLOOR)).toEqual(
      axisFolds([first, second, third], axis, MARGIN, FLOOR),
    );
  });

  it('folds every gap, not only the first', () => {
    const first = span(0, 6);
    const second = span(30, 36);
    const third = span(60, 66);

    expect(
      axisFolds(
        [first, second, third],
        axisAround(first, second, third),
        MARGIN,
        FLOOR,
      ),
    ).toEqual([
      { startMs: ORIGIN + 8 * HOUR, endMs: ORIGIN + 28 * HOUR },
      { startMs: ORIGIN + 38 * HOUR, endMs: ORIGIN + 58 * HOUR },
    ]);
  });

  /** An axis wider than the days plus their margins — not a shape the board
   * builds today, but the complement is computed against the axis and a fold
   * running off the end of it would be positioned past the scrollable width. */
  it('clips a fold to the axis it is asked about', () => {
    const day = span(0, 6);
    const axis = { startMs: ORIGIN - 12 * HOUR, endMs: ORIGIN + 18 * HOUR };
    expect(axisFolds([day], axis, MARGIN, FLOOR)).toEqual([
      { startMs: axis.startMs, endMs: ORIGIN - 2 * HOUR },
      { startMs: ORIGIN + 8 * HOUR, endMs: axis.endMs },
    ]);
  });

  /** An axis with nothing on it is already the empty board; crushing it would
   * leave a coordinator with an ellipsis and no way back. */
  it('folds nothing when there are no days at all', () => {
    expect(axisFolds([], span(0, 48), MARGIN, FLOOR)).toEqual([]);
  });

  it('refuses a negative margin or a floor that is not positive', () => {
    const day = span(0, 6);
    const axis = axisAround(day);
    expect(() => axisFolds([day], axis, -1, FLOOR)).toThrow();
    expect(() => axisFolds([day], axis, MARGIN, 0)).toThrow();
  });
});
