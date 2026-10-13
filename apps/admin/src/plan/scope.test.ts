// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Event } from '../api/events';
import type { FestivalDetail } from '../api/festivals';
import { setLocale } from '../i18n';
import {
  chronological,
  eventScope,
  festivalScope,
  focusedEventId,
  planSubject,
  statusLabel,
} from './scope';

function event(overrides: Partial<Event> = {}): Event {
  return {
    id: 'event-1',
    festival_id: 'festival-1',
    name: 'Open Air',
    slug: 'open-air',
    timezone: 'Europe/Paris',
    period: { start: '2026-08-01T08:00:00Z', end: '2026-08-01T18:00:00Z' },
    status: 'draft',
    color: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    version: 1,
    ...overrides,
  };
}

function festival(events: readonly Event[]): FestivalDetail {
  return {
    id: 'festival-1',
    name: 'Soundclash 26',
    slug: 'soundclash-26',
    timezone: 'Europe/Paris',
    period: { start: '2026-07-30T08:00:00Z', end: '2026-08-04T18:00:00Z' },
    status: 'planning',
    event_count: events.length,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    version: 1,
    events: [...events],
  };
}

describe('chronological', () => {
  it('orders days by when they start, not by the order the server sent', () => {
    const late = event({
      id: 'b',
      period: { start: '2026-08-03T10:00:00Z', end: '2026-08-03T18:00:00Z' },
    });
    const early = event({
      id: 'a',
      period: { start: '2026-07-30T10:00:00Z', end: '2026-07-30T18:00:00Z' },
    });

    expect(chronological([late, early]).map((day) => day.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('does not reorder the array it was given', () => {
    const days = [
      event({
        id: 'b',
        period: { start: '2026-08-03T10:00:00Z', end: '2026-08-03T18:00:00Z' },
      }),
      event({
        id: 'a',
        period: { start: '2026-07-30T10:00:00Z', end: '2026-07-30T18:00:00Z' },
      }),
    ];

    chronological(days);

    expect(days.map((day) => day.id)).toEqual(['b', 'a']);
  });
});

describe('festivalScope', () => {
  it('covers every day of the festival with none of them selected', () => {
    const scope = festivalScope(
      festival([event({ id: 'a' }), event({ id: 'b' })]),
    );

    expect(scope.kind).toBe('festival');
    expect(scope.days.map((day) => day.id)).toEqual(['a', 'b']);
    expect(focusedEventId(scope)).toBeNull();
  });

  it('describes the festival, not one of its days', () => {
    const scope = festivalScope(festival([event()]));

    expect(planSubject(scope).name).toBe('Soundclash 26');
  });
});

describe('eventScope', () => {
  it('still covers the whole festival when one day is selected', () => {
    const selected = event({ id: 'b' });
    const scope = eventScope(
      selected,
      festival([event({ id: 'a' }), selected]),
    );

    expect(scope.days.map((day) => day.id)).toEqual(['a', 'b']);
    expect(focusedEventId(scope)).toBe('b');
  });

  it('describes the selected day, while still knowing its festival', () => {
    const selected = event({ id: 'b', name: 'Dub & 2step' });
    const scope = eventScope(selected, festival([selected]));

    expect(planSubject(scope).name).toBe('Dub & 2step');
    expect(scope.festival?.name).toBe('Soundclash 26');
  });

  it('scopes a standalone event to itself alone', () => {
    const standalone = event({ id: 'solo', festival_id: null });
    const scope = eventScope(standalone, null);

    expect(scope.festival).toBeNull();
    expect(scope.days.map((day) => day.id)).toEqual(['solo']);
    expect(focusedEventId(scope)).toBe('solo');
  });

  it('keeps a day the festival has not caught up with rather than dropping it', () => {
    // The two queries are momentarily out of step — an event created in
    // another tab. The coordinator is standing on that day; a strip without
    // it would say they are nowhere.
    const fresh = event({
      id: 'fresh',
      period: { start: '2026-08-02T10:00:00Z', end: '2026-08-02T18:00:00Z' },
    });
    const scope = eventScope(fresh, festival([event({ id: 'a' })]));

    expect(scope.days.map((day) => day.id)).toEqual(['a', 'fresh']);
    expect(focusedEventId(scope)).toBe('fresh');
  });
});

describe('statusLabel', () => {
  it('names a known status, and shows an unknown one as sent', () => {
    expect(statusLabel('draft')).toBe('draft');
    expect(statusLabel('postponed')).toBe('postponed');
  });

  describe('in French', () => {
    beforeAll(async () => {
      await setLocale('fr');
    });
    afterAll(async () => {
      await setLocale('en');
    });

    it('translates the stored value, and only the known ones', () => {
      expect(statusLabel('draft')).toBe('brouillon');
      expect(statusLabel('running')).toBe('en cours');
      expect(statusLabel('postponed')).toBe('postponed');
    });
  });
});
