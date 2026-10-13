// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { describe, expect, it } from 'vitest';

import { Temporal } from '@evp/shared/time';

import type { Event } from '../api/events';
import type { Festival } from '../api/festivals';
import { buildAgenda, hasPassed } from './agenda';

/** Fixed, never `Temporal.Now`: docs/13 §8 — no test reads the wall clock. */
const NOW = Temporal.Instant.from('2026-06-15T12:00:00Z');

function event(
  id: string,
  start: string,
  end: string,
  festivalId: string | null = null,
): Event {
  return {
    id,
    festival_id: festivalId,
    name: id,
    slug: id,
    timezone: 'Europe/Paris',
    period: { start, end },
    status: 'draft',
    color: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    version: 1,
  };
}

function festival(id: string, start: string, end: string): Festival {
  return {
    id,
    name: id,
    slug: id,
    timezone: 'Europe/Paris',
    period: { start, end },
    status: 'draft',
    event_count: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    version: 1,
  };
}

describe('buildAgenda', () => {
  it('puts the soonest upcoming group first and the most recent past group first', () => {
    const soon = event('soon', '2026-06-20T10:00:00Z', '2026-06-20T18:00:00Z');
    const later = event(
      'later',
      '2026-08-01T10:00:00Z',
      '2026-08-01T18:00:00Z',
    );
    const old = event('old', '2026-01-10T10:00:00Z', '2026-01-10T18:00:00Z');
    const recent = event(
      'recent',
      '2026-06-01T10:00:00Z',
      '2026-06-01T18:00:00Z',
    );

    const agenda = buildAgenda([later, old, soon, recent], [], NOW);

    expect(agenda.upcoming.map((group) => group.key)).toEqual([
      'event:soon',
      'event:later',
    ]);
    expect(agenda.past.map((group) => group.key)).toEqual([
      'event:recent',
      'event:old',
    ]);
  });

  it('counts an event that has started but not ended as upcoming', () => {
    const running = event(
      'running',
      '2026-06-15T08:00:00Z',
      '2026-06-15T23:00:00Z',
    );

    const agenda = buildAgenda([running], [], NOW);

    expect(agenda.upcoming).toHaveLength(1);
    expect(agenda.past).toHaveLength(0);
  });

  it('treats an event ending exactly now as past — the period is half-open', () => {
    const justOver = event(
      'just',
      '2026-06-15T08:00:00Z',
      '2026-06-15T12:00:00Z',
    );

    const agenda = buildAgenda([justOver], [], NOW);

    expect(agenda.past.map((group) => group.key)).toEqual(['event:just']);
  });

  it('groups events under their festival, chronologically inside the block', () => {
    const fest = festival(
      'fest',
      '2026-07-01T00:00:00Z',
      '2026-07-04T00:00:00Z',
    );
    const day2 = event(
      'day2',
      '2026-07-02T10:00:00Z',
      '2026-07-02T18:00:00Z',
      'fest',
    );
    const day1 = event(
      'day1',
      '2026-07-01T10:00:00Z',
      '2026-07-01T18:00:00Z',
      'fest',
    );
    const loose = event(
      'loose',
      '2026-06-20T10:00:00Z',
      '2026-06-20T18:00:00Z',
    );

    const agenda = buildAgenda([day2, loose, day1], [fest], NOW);

    expect(agenda.upcoming.map((group) => group.key)).toEqual([
      'event:loose',
      'festival:fest',
    ]);
    const [, block] = agenda.upcoming;
    expect(block?.kind).toBe('festival');
    if (block?.kind !== 'festival') {
      throw new Error('expected a festival group');
    }
    expect(block.events.map((e) => e.id)).toEqual(['day1', 'day2']);
  });

  it('keeps a festival with no events yet, ordered by its own period', () => {
    const empty = festival(
      'empty',
      '2026-06-18T00:00:00Z',
      '2026-06-19T00:00:00Z',
    );
    const after = event(
      'after',
      '2026-06-25T10:00:00Z',
      '2026-06-25T18:00:00Z',
    );

    const agenda = buildAgenda([after], [empty], NOW);

    expect(agenda.upcoming.map((group) => group.key)).toEqual([
      'festival:empty',
      'event:after',
    ]);
  });

  it('keeps a festival upcoming while any of its events is still to come', () => {
    // The festival's own window closed yesterday; one event overruns it.
    const overrun = festival(
      'overrun',
      '2026-06-10T00:00:00Z',
      '2026-06-14T00:00:00Z',
    );
    const late = event(
      'late',
      '2026-06-20T10:00:00Z',
      '2026-06-20T18:00:00Z',
      'overrun',
    );

    const agenda = buildAgenda([late], [overrun], NOW);

    expect(agenda.upcoming.map((group) => group.key)).toEqual([
      'festival:overrun',
    ]);
    expect(agenda.past).toHaveLength(0);
  });

  it('renders an event whose festival is not in the list as standalone', () => {
    // Happens when the two queries are momentarily out of step. Dropping the
    // event would hide work somebody still has to staff.
    const orphan = event(
      'orphan',
      '2026-06-20T10:00:00Z',
      '2026-06-20T18:00:00Z',
      'not-loaded',
    );

    const agenda = buildAgenda([orphan], [], NOW);

    expect(agenda.upcoming.map((group) => group.key)).toEqual(['event:orphan']);
  });
});

describe('hasPassed', () => {
  it('is false for an event still running and true once it has ended', () => {
    expect(
      hasPassed(
        event('a', '2026-06-15T08:00:00Z', '2026-06-15T20:00:00Z').period,
        NOW,
      ),
    ).toBe(false);
    expect(
      hasPassed(
        event('b', '2026-06-14T08:00:00Z', '2026-06-14T20:00:00Z').period,
        NOW,
      ),
    ).toBe(true);
  });
});
