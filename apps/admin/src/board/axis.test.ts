// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { Temporal } from '@evp/shared/time';
import { describe, expect, it } from 'vitest';

import { axisDays, axisTicks } from './axis';

const HOUR = 3_600_000;
const PARIS = 'Europe/Paris';

/** 5 Sept 2026 08:00Z — 10:00 in Paris, which is where the design's axis
 * starts. Summer time, so the offset is +02:00. */
const FRI_10H = Temporal.Instant.from('2026-09-05T08:00:00Z').epochMilliseconds;

describe('axisDays', () => {
  it('bands the axis by the event own calendar days', () => {
    const days = axisDays(FRI_10H, FRI_10H + 34 * HOUR, PARIS, 'fr');

    expect(days).toHaveLength(2);
    expect(days[0]?.startMs).toBe(FRI_10H);
    expect(days[1]?.startMs).toBe(
      Temporal.Instant.from('2026-09-05T22:00:00Z').epochMilliseconds,
    );
  });

  it('clips the first and last band to the window it was asked for', () => {
    const endMs = FRI_10H + 34 * HOUR;
    const days = axisDays(FRI_10H, endMs, PARIS, 'fr');

    expect(days[0]?.startMs).toBe(FRI_10H);
    expect(days.at(-1)?.endMs).toBe(endMs);
  });

  it('labels a band with its own date, not the viewer time zone one', () => {
    // 23:30 in Paris on the 5th is already the 6th in UTC; a band labelled
    // from the browser would say so, and be wrong about which night it is.
    const lateMs = Temporal.Instant.from(
      '2026-09-05T21:30:00Z',
    ).epochMilliseconds;
    const days = axisDays(lateMs, lateMs + HOUR, PARIS, 'fr');

    expect(days[0]?.label).toContain('05');
  });

  it('is one band for an axis inside a single day', () => {
    expect(axisDays(FRI_10H, FRI_10H + 2 * HOUR, PARIS, 'fr')).toHaveLength(1);
  });
});

describe('axisTicks', () => {
  it('puts ticks on the event wall clock, not on whole UTC hours', () => {
    const ticks = axisTicks(FRI_10H, FRI_10H + 6 * HOUR, PARIS, 'fr', 120);

    // 10:00, 12:00, 14:00 Paris — which are 08:00Z, 10:00Z, 12:00Z.
    expect(ticks.map((tick) => tick.atMs)).toEqual([
      FRI_10H,
      FRI_10H + 2 * HOUR,
      FRI_10H + 4 * HOUR,
    ]);
  });

  it('never places a tick outside the window', () => {
    const startMs = FRI_10H + 30 * 60_000;
    const ticks = axisTicks(startMs, startMs + 3 * HOUR, PARIS, 'fr', 60);

    expect(ticks.every((tick) => tick.atMs >= startMs)).toBe(true);
    expect(ticks.every((tick) => tick.atMs < startMs + 3 * HOUR)).toBe(true);
  });

  /**
   * The whole reason ticks are re-anchored on each civil midnight rather than
   * walked as one exact-duration sequence. 29 March 2026 is 23 hours long in
   * Paris: 02:00 does not exist, and a tick claiming it does would be a label
   * for a time no shift can start at (ADR-0019).
   */
  it('skips the hour a spring-forward day does not have', () => {
    // 00:00 Paris on 29 March, the day the clocks go forward.
    const dayStart = Temporal.Instant.from(
      '2026-03-28T23:00:00Z',
    ).epochMilliseconds;
    const ticks = axisTicks(dayStart, dayStart + 23 * HOUR, PARIS, 'fr', 60);

    expect(ticks).toHaveLength(23);
    expect(ticks.map((tick) => tick.label)).not.toContain('02:00');
  });

  it('gives an autumn-back day its twenty-five hours', () => {
    // 00:00 Paris on 25 October, the day the clocks go back.
    const dayStart = Temporal.Instant.from(
      '2026-10-24T22:00:00Z',
    ).epochMilliseconds;
    const ticks = axisTicks(dayStart, dayStart + 25 * HOUR, PARIS, 'fr', 60);

    expect(ticks).toHaveLength(25);
  });

  it('re-anchors on each midnight, so every day reads the same', () => {
    const ticks = axisTicks(FRI_10H, FRI_10H + 30 * HOUR, PARIS, 'fr', 360);
    const labels = ticks.map((tick) => tick.label);

    // 12:00 and 18:00 appear on both days, at the same clock reading.
    expect(labels.filter((label) => label === '12:00')).toHaveLength(2);
  });

  it('refuses a tick interval that is not a positive number of minutes', () => {
    expect(() => axisTicks(FRI_10H, FRI_10H + HOUR, PARIS, 'fr', 0)).toThrow();
  });
});
