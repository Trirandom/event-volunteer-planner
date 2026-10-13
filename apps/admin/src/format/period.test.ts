// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setLocale } from '../i18n';
import {
  formatPeriod,
  instantFromLocal,
  periodDatesText,
  periodText,
  type PeriodDisplay,
} from './period';

describe('formatPeriod', () => {
  it('keeps a same-day period on one date', () => {
    const display = formatPeriod(
      { start: '2026-07-04T12:00:00Z', end: '2026-07-04T16:00:00Z' },
      'Europe/Paris',
      'en',
    );

    expect(display.startDate).toBe(display.endDate);
    expect(display.spansMultipleDays).toBe(false);
    // `@evp/shared/intl`'s `formatTime` uses the platform's ICU default for
    // bare `'en'`, which is a 12-hour clock — this asserts that real,
    // slightly surprising behaviour rather than the 24-hour reading a
    // European reader might expect.
    expect(display.startTime).toBe('02:00 PM');
    expect(display.endTime).toBe('06:00 PM');
  });

  it('reports a club night that runs past midnight as spanning two days', () => {
    // 22:00 to 05:00 local (CEST, UTC+2) — the shape docs/16 calls out and a
    // naive "format the date once" implementation gets wrong.
    const display = formatPeriod(
      { start: '2026-07-03T20:00:00Z', end: '2026-07-04T03:00:00Z' },
      'Europe/Paris',
      'en',
    );

    expect(display.spansMultipleDays).toBe(true);
    expect(display.startTime).toBe('10:00 PM');
    expect(display.endTime).toBe('05:00 AM');
    expect(display.startDate).not.toBe(display.endDate);
  });

  it('renders in the event zone, not whatever zone the test runner happens to use', () => {
    // Réunion is UTC+4 with no DST — a fixed offset that makes the assertion
    // independent of the host's own timezone (docs/13 §8: never read the wall
    // clock, and by the same logic never rely on it either).
    const display = formatPeriod(
      { start: '2026-07-04T20:00:00Z', end: '2026-07-04T22:00:00Z' },
      'Indian/Reunion',
      'en',
    );

    expect(display.startTime).toBe('12:00 AM');
    expect(display.endTime).toBe('02:00 AM');
  });

  it('formats in French when the viewer locale is fr', () => {
    const display = formatPeriod(
      { start: '2026-07-04T12:00:00Z', end: '2026-07-04T16:00:00Z' },
      'Europe/Paris',
      'fr',
    );

    expect(display.startDate).toContain('juillet');
  });

  it('labels the timezone rather than leaving it implicit', () => {
    const display = formatPeriod(
      { start: '2026-07-04T12:00:00Z', end: '2026-07-04T16:00:00Z' },
      'Indian/Reunion',
      'en',
    );

    expect(display.timeZoneLabel.length).toBeGreaterThan(0);
    expect(display.timeZoneLabel).not.toBe('Indian/Reunion');
  });
});

describe('instantFromLocal', () => {
  it('converts a wall-clock reading in the event zone to a UTC instant', () => {
    // 22:00 in Paris in July (CEST, UTC+2) is 20:00 UTC.
    expect(instantFromLocal('2026-07-03T22:00', 'Europe/Paris')).toBe(
      '2026-07-03T20:00:00Z',
    );
  });

  it('round-trips through formatPeriod back to the same local time', () => {
    const instant = instantFromLocal('2026-07-03T22:00', 'Europe/Paris');
    const display = formatPeriod(
      { start: instant, end: instant },
      'Europe/Paris',
      'en',
    );
    expect(display.startTime).toBe('10:00 PM');
  });
});

describe('periodText', () => {
  const clubNight: PeriodDisplay = {
    startDate: 'Sat 1 Aug',
    startTime: '22:00',
    endDate: 'Sun 2 Aug',
    endTime: '05:00',
    spansMultipleDays: true,
    timeZoneLabel: 'CEST',
  };

  it('names the end date only when the period crosses midnight', () => {
    expect(periodText(clubNight)).toBe(
      'Sat 1 Aug, 22:00 – Sun 2 Aug, 05:00 (CEST)',
    );
    expect(periodText({ ...clubNight, spansMultipleDays: false })).toBe(
      'Sat 1 Aug, 22:00 – 05:00 (CEST)',
    );
    expect(periodDatesText(clubNight)).toBe('Sat 1 Aug – Sun 2 Aug');
  });

  describe('in French', () => {
    beforeAll(async () => {
      await setLocale('fr');
    });
    afterAll(async () => {
      await setLocale('en');
    });

    it('follows the interface language at call time', () => {
      expect(periodText({ ...clubNight, spansMultipleDays: false })).toBe(
        'Sat 1 Aug, 22:00 – 05:00 (CEST)',
      );
    });
  });
});
