// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The details form's arithmetic, without a form.
 *
 * Two of these are the reason the module exists rather than living in the
 * component: "typing a value back to what it was sends nothing", and "the
 * fields round-trip through a DST boundary". Neither is visible on screen and
 * both are wrong by default.
 */
import { describe, expect, it } from 'vitest';

import { draftChanges, draftOf, draftProblem } from './eventDraft';
import type { Event } from '../api/events';

function event(overrides: Partial<Event> = {}): Event {
  return {
    id: 'event-1',
    festival_id: 'festival-1',
    name: 'Open Air',
    slug: 'open-air',
    timezone: 'Europe/Paris',
    // 10:00–23:00 Paris time, which is UTC+2 in August.
    period: { start: '2026-08-01T08:00:00Z', end: '2026-08-01T21:00:00Z' },
    status: 'draft',
    color: 3,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    version: 1,
    ...overrides,
  };
}

describe('draftOf', () => {
  it('reads the stored instants as wall-clock in the event zone', () => {
    expect(draftOf(event())).toEqual({
      start: '2026-08-01T10:00',
      end: '2026-08-01T23:00',
      doorsOpen: '',
      doorsClose: '',
      color: 3,
    });
  });

  it('leaves the door fields empty when none are published', () => {
    const draft = draftOf(event());
    expect(draft.doorsOpen).toBe('');
    expect(draft.doorsClose).toBe('');
  });

  it('fills the door fields from the stored public period', () => {
    const draft = draftOf(
      event({
        public_period: {
          start: '2026-08-01T16:00:00Z',
          end: '2026-08-01T20:00:00Z',
        },
      }),
    );
    expect(draft.doorsOpen).toBe('2026-08-01T18:00');
    expect(draft.doorsClose).toBe('2026-08-01T22:00');
  });
});

describe('draftChanges', () => {
  it('sends nothing when the draft still says what the event says', () => {
    const stored = event();
    expect(draftChanges(stored, draftOf(stored))).toBeNull();
  });

  it('sends nothing when the doors were unset and still are', () => {
    const stored = event();
    const draft = { ...draftOf(stored), doorsOpen: '', doorsClose: '' };
    expect(draftChanges(stored, draft)).toBeNull();
  });

  it('sends only the period when only the period moved', () => {
    const stored = event();
    const draft = { ...draftOf(stored), end: '2026-08-02T02:00' };
    expect(draftChanges(stored, draft)).toEqual({
      period: { start: '2026-08-01T08:00:00Z', end: '2026-08-02T00:00:00Z' },
    });
  });

  it('sends the doors as a period when they are stated', () => {
    const stored = event();
    const draft = {
      ...draftOf(stored),
      doorsOpen: '2026-08-01T18:00',
      doorsClose: '2026-08-01T22:00',
    };
    expect(draftChanges(stored, draft)).toEqual({
      publicPeriod: {
        start: '2026-08-01T16:00:00Z',
        end: '2026-08-01T20:00:00Z',
      },
    });
  });

  /** The half of the tri-state a `Period | undefined` could not express: the
   * coordinator has decided there are no published hours, which is a write. */
  it('sends null when stated doors are emptied', () => {
    const stored = event({
      public_period: {
        start: '2026-08-01T16:00:00Z',
        end: '2026-08-01T20:00:00Z',
      },
    });
    const draft = { ...draftOf(stored), doorsOpen: '', doorsClose: '' };
    expect(draftChanges(stored, draft)).toEqual({ publicPeriod: null });
  });

  it('sends only the colour when only the colour changed', () => {
    const stored = event();
    expect(draftChanges(stored, { ...draftOf(stored), color: 12 })).toEqual({
      color: 12,
    });
  });

  it('sends nothing at all for a draft it would refuse', () => {
    const stored = event();
    const draft = { ...draftOf(stored), end: '2026-07-01T09:00' };
    expect(draftChanges(stored, draft)).toBeNull();
  });
});

describe('draftProblem', () => {
  it('accepts a draft that says what the event says', () => {
    const stored = event();
    expect(draftProblem(draftOf(stored), stored.timezone)).toBeNull();
  });

  it('refuses an event that ends before it starts', () => {
    const stored = event();
    const draft = { ...draftOf(stored), end: '2026-08-01T09:00' };
    expect(draftProblem(draft, stored.timezone)).toBe('period-inverted');
  });

  it('refuses one door time without the other', () => {
    const stored = event();
    const draft = { ...draftOf(stored), doorsOpen: '2026-08-01T18:00' };
    expect(draftProblem(draft, stored.timezone)).toBe('doors-half-stated');
  });

  it('refuses doors that close before they open', () => {
    const stored = event();
    const draft = {
      ...draftOf(stored),
      doorsOpen: '2026-08-01T20:00',
      doorsClose: '2026-08-01T18:00',
    };
    expect(draftProblem(draft, stored.timezone)).toBe('doors-inverted');
  });

  /** `events_public_period_valid`, caught before the round trip. */
  it('refuses doors that reach outside the event', () => {
    const stored = event();
    const draft = {
      ...draftOf(stored),
      doorsOpen: '2026-08-01T09:00',
      doorsClose: '2026-08-01T22:00',
    };
    expect(draftProblem(draft, stored.timezone)).toBe('doors-outside-period');
  });

  it('accepts doors that exactly fill the event', () => {
    const stored = event();
    const base = draftOf(stored);
    const draft = { ...base, doorsOpen: base.start, doorsClose: base.end };
    expect(draftProblem(draft, stored.timezone)).toBeNull();
  });

  it('refuses an empty start', () => {
    const stored = event();
    expect(
      draftProblem({ ...draftOf(stored), start: '' }, stored.timezone),
    ).toBe('start-missing');
  });
});

/**
 * The hour that happens twice.
 *
 * Europe/Paris falls back at 03:00 on 2026-10-25, so 02:30 that morning is two
 * different instants. Whichever one `instantFromLocal` resolves to, reading it
 * back must produce the same field text — otherwise the form reports a change
 * nobody made, every time it is opened, on one day a year.
 */
describe('across a DST fall-back', () => {
  it('round-trips a wall-clock reading inside the repeated hour', () => {
    const stored = event({
      timezone: 'Europe/Paris',
      period: { start: '2026-10-25T00:30:00Z', end: '2026-10-25T10:00:00Z' },
    });
    const draft = draftOf(stored);
    expect(draftChanges(stored, draft)).toBeNull();
  });
});
