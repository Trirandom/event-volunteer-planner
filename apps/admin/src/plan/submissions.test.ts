// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The narrowing is the whole module, so it is what these prove: a day in
 * front of the coordinator has to remove the volunteers who offered nothing
 * on it, and the festival-wide reading has to keep them — including whoever
 * declared nothing at all, who is the person to chase.
 *
 * No wall clock anywhere: every instant is a literal (docs/13 §8).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Event } from '../api/events';
import type { Submission } from '../api/submissions';
import { setLocale, t } from '../i18n';
import { buildSubmissionBoard, durationLabel } from './submissions';

function event(overrides: Partial<Event> = {}): Event {
  return {
    id: 'open-air',
    festival_id: 'festival-1',
    name: 'Open Air',
    slug: 'open-air',
    timezone: 'Europe/Paris',
    period: { start: '2026-09-05T08:00:00Z', end: '2026-09-05T22:00:00Z' },
    status: 'draft',
    color: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    version: 1,
    ...overrides,
  };
}

const OPEN_AIR = event();

/** The club night that laps midnight — 20:00 to 05:00 Paris, which is the
 * case a same-day pair would silently shorten. */
const DUB = event({
  id: 'dub',
  name: 'Dub & 2step',
  slug: 'dub-2step',
  color: 5,
  period: { start: '2026-09-11T18:00:00Z', end: '2026-09-12T06:00:00Z' },
});

const DAYS: readonly Event[] = [OPEN_AIR, DUB];

function submission(overrides: Partial<Submission> = {}): Submission {
  return {
    id: 'submission-1',
    display_name: 'Camille',
    first_name: 'Camille',
    last_name: null,
    submitted_at: '2026-08-04T13:09:35Z',
    answers: [{ question: 'Postes préférés', value: 'Bar, Entrées' }],
    availability: [],
    ...overrides,
  };
}

describe('buildSubmissionBoard', () => {
  it('resolves each window against the day it names', () => {
    const board = buildSubmissionBoard(
      [
        submission({
          availability: [
            {
              event_id: 'dub',
              start: '2026-09-11T18:00:00Z',
              end: '2026-09-12T03:00:00Z',
            },
          ],
        }),
      ],
      DAYS,
      null,
    );

    expect(board.rows[0]?.windows).toEqual([
      {
        eventId: 'dub',
        eventName: 'Dub & 2step',
        timezone: 'Europe/Paris',
        color: 5,
        period: {
          start: '2026-09-11T18:00:00Z',
          end: '2026-09-12T03:00:00Z',
        },
        // 20:00–05:00 in Paris. Nine hours, not the "same day" three a
        // date-dropping reading would give.
        minutes: 540,
      },
    ]);
  });

  it('keeps a volunteer who declared nothing, at festival scope', () => {
    const board = buildSubmissionBoard([submission()], DAYS, null);

    expect(board.rows).toHaveLength(1);
    expect(board.rows[0]?.windows).toEqual([]);
    expect(board.hiddenByScope).toBe(0);
  });

  it('drops the volunteers who offered nothing on the selected day', () => {
    const board = buildSubmissionBoard(
      [
        submission({
          id: 'open-air-only',
          availability: [
            {
              event_id: 'open-air',
              start: '2026-09-05T08:00:00Z',
              end: '2026-09-05T12:00:00Z',
            },
          ],
        }),
        submission({
          id: 'dub-only',
          display_name: 'Moustache',
          availability: [
            {
              event_id: 'dub',
              start: '2026-09-11T20:00:00Z',
              end: '2026-09-11T22:00:00Z',
            },
          ],
        }),
        submission({ id: 'nothing-at-all' }),
      ],
      DAYS,
      'dub',
    );

    expect(board.rows.map((row) => row.id)).toEqual(['dub-only']);
    expect(board.total).toBe(3);
    expect(board.hiddenByScope).toBe(2);
  });

  it('narrows a kept volunteer to that day’s windows only', () => {
    const board = buildSubmissionBoard(
      [
        submission({
          availability: [
            {
              event_id: 'open-air',
              start: '2026-09-05T08:00:00Z',
              end: '2026-09-05T12:00:00Z',
            },
            {
              event_id: 'dub',
              start: '2026-09-11T20:00:00Z',
              end: '2026-09-11T22:00:00Z',
            },
          ],
        }),
      ],
      DAYS,
      'dub',
    );

    expect(board.rows[0]?.windows.map((window) => window.eventId)).toEqual([
      'dub',
    ]);
    expect(board.rows[0]?.minutes).toBe(120);
    expect(board.rows[0]?.dayCount).toBe(1);
  });

  /** The race `scope.ts` resolves the same way: a day added in another tab is
   * not yet in `days`, and a chip reading "unknown day, 22:00–05:00" is worse
   * than no chip. */
  it('discards a window naming a day this page does not have', () => {
    const board = buildSubmissionBoard(
      [
        submission({
          availability: [
            {
              event_id: 'after',
              start: '2026-09-13T08:00:00Z',
              end: '2026-09-13T10:00:00Z',
            },
          ],
        }),
      ],
      DAYS,
      null,
    );

    expect(board.rows[0]?.windows).toEqual([]);
  });

  it('orders a volunteer’s windows soonest first, and totals them', () => {
    const board = buildSubmissionBoard(
      [
        submission({
          availability: [
            {
              event_id: 'dub',
              start: '2026-09-11T20:00:00Z',
              end: '2026-09-11T22:00:00Z',
            },
            {
              event_id: 'open-air',
              start: '2026-09-05T08:00:00Z',
              end: '2026-09-05T12:00:00Z',
            },
          ],
        }),
      ],
      DAYS,
      null,
    );

    expect(board.rows[0]?.windows.map((window) => window.eventId)).toEqual([
      'open-air',
      'dub',
    ]);
    expect(board.rows[0]?.minutes).toBe(360);
    expect(board.rows[0]?.dayCount).toBe(2);
  });
});

describe('durationLabel', () => {
  it('reads as hours and minutes, never as a decimal', () => {
    expect(durationLabel(750)).toBe('12 h 30');
    expect(durationLabel(420)).toBe('7 h');
    expect(durationLabel(45)).toBe('45 min');
    expect(durationLabel(0)).toBe('0 min');
  });
});

/** French puts 0 in "one" — the reason counts go through ICU plurals and not
 * a hand-rolled `s`. */
describe('in French', () => {
  beforeAll(async () => {
    await setLocale('fr');
  });
  afterAll(async () => {
    await setLocale('en');
  });

  it('pluralises the day count the French way', () => {
    const total = (days: number) =>
      t('submissions.card.total', { duration: '7 h', days });
    expect(total(0)).toBe('7 h proposées sur 0 jour');
    expect(total(1)).toBe('7 h proposées sur 1 jour');
    expect(total(2)).toBe('7 h proposées sur 2 jours');
  });

  it('reads durations the same way', () => {
    expect(durationLabel(750)).toBe('12 h 30');
    expect(durationLabel(45)).toBe('45 min');
  });
});
