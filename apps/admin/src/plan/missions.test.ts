// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { describe, expect, it } from 'vitest';

import type { Event } from '../api/events';
import type { Post, Zone } from '../api/locations';
import type { Shift } from '../api/shifts';
import {
  buildMissionBoard,
  narrowToEvent,
  type MissionSource,
} from './missions';

function event(id: string, name: string): Event {
  return {
    id,
    festival_id: 'festival-1',
    name,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    timezone: 'Europe/Paris',
    period: { start: '2026-08-01T08:00:00Z', end: '2026-08-01T18:00:00Z' },
    status: 'draft',
    color: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    version: 1,
  };
}

function post(
  id: string,
  eventId: string,
  parentId: string,
  name: string,
): Post {
  return {
    id,
    event_id: eventId,
    parent_id: parentId,
    kind: 'post',
    name,
    sort_order: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    version: 1,
  };
}

function zone(
  id: string,
  eventId: string,
  name: string,
  posts: Post[] = [],
): Zone {
  return {
    id,
    event_id: eventId,
    parent_id: null,
    kind: 'zone',
    name,
    sort_order: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    version: 1,
    posts,
  };
}

function shift(
  id: string,
  eventId: string,
  locationId: string,
  start: string,
  end: string,
  requiredCount = 2,
): Shift {
  return {
    id,
    event_id: eventId,
    location_id: locationId,
    period: { start, end },
    required_count: requiredCount,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    version: 1,
  };
}

/** Two days of one festival that each run a bar, which is the whole point:
 * the schema stores two rows, a coordinator means one mission. */
function twoDayFestival(): readonly MissionSource[] {
  return [
    {
      event: event('open-air', 'Open Air'),
      zones: [
        zone('z1', 'open-air', 'Site', [
          post('p1', 'open-air', 'z1', 'Bar'),
          post('p2', 'open-air', 'z1', 'Entrée'),
        ]),
      ],
      shifts: [
        shift(
          's1',
          'open-air',
          'p1',
          '2026-08-01T10:00:00Z',
          '2026-08-01T12:00:00Z',
        ),
        shift(
          's2',
          'open-air',
          'p1',
          '2026-08-01T12:00:00Z',
          '2026-08-01T14:00:00Z',
          3,
        ),
        shift(
          's3',
          'open-air',
          'p2',
          '2026-08-01T10:00:00Z',
          '2026-08-01T12:00:00Z',
        ),
      ],
    },
    {
      event: event('dub', 'Dub & 2step'),
      zones: [zone('z2', 'dub', 'Club', [post('p3', 'dub', 'z2', 'Bar')])],
      shifts: [
        shift(
          's4',
          'dub',
          'p3',
          '2026-08-02T20:00:00Z',
          '2026-08-02T23:00:00Z',
          4,
        ),
      ],
    },
  ];
}

describe('buildMissionBoard', () => {
  it('folds a mission of the same name across days into one', () => {
    const board = buildMissionBoard(twoDayFestival());

    const bar = board.missions.find((mission) => mission.name === 'Bar');
    expect(bar?.occurrences.map((occurrence) => occurrence.eventName)).toEqual([
      'Open Air',
      'Dub & 2step',
    ]);
    expect(bar?.shiftCount).toBe(3);
    expect(bar?.requiredTotal).toBe(9);
  });

  it('matches missions on the name a coordinator typed, ignoring case and padding', () => {
    const board = buildMissionBoard([
      {
        event: event('a', 'Day A'),
        zones: [zone('z1', 'a', 'Site', [post('p1', 'a', 'z1', 'Bar')])],
        shifts: [],
      },
      {
        event: event('b', 'Day B'),
        zones: [zone('z2', 'b', 'Site', [post('p2', 'b', 'z2', ' bar ')])],
        shifts: [],
      },
    ]);

    expect(board.missions).toHaveLength(1);
    expect(board.missions[0]?.occurrences).toHaveLength(2);
    // The first spelling seen is the one shown: it is as good a guess as the
    // second and stays stable while the list is re-rendered.
    expect(board.missions[0]?.name).toBe('Bar');
  });

  it('orders missions by name so the same festival always reads the same way', () => {
    const board = buildMissionBoard(twoDayFestival());

    expect(board.missions.map((mission) => mission.name)).toEqual([
      'Bar',
      'Entrée',
    ]);
  });

  it('names a shift by its location when it carries no title of its own', () => {
    const board = buildMissionBoard(twoDayFestival());

    const bar = board.missions.find((mission) => mission.name === 'Bar');
    expect(bar?.occurrences[0]?.shifts[0]?.title).toBe('Bar');
  });

  it('keeps a shift its own title when it has one', () => {
    const board = buildMissionBoard([
      {
        event: event('a', 'Day A'),
        zones: [zone('z1', 'a', 'Site', [post('p1', 'a', 'z1', 'Bar')])],
        shifts: [
          {
            ...shift(
              's1',
              'a',
              'p1',
              '2026-08-01T10:00:00Z',
              '2026-08-01T12:00:00Z',
            ),
            title: 'Bar — mise en place',
          },
        ],
      },
    ]);

    expect(board.missions[0]?.occurrences[0]?.shifts[0]?.title).toBe(
      'Bar — mise en place',
    );
  });

  it('carries the timezone of the day a shift is worked on', () => {
    const board = buildMissionBoard([
      {
        event: { ...event('a', 'Day A'), timezone: 'Indian/Reunion' },
        zones: [zone('z1', 'a', 'Site', [post('p1', 'a', 'z1', 'Bar')])],
        shifts: [
          shift(
            's1',
            'a',
            'p1',
            '2026-08-01T10:00:00Z',
            '2026-08-01T12:00:00Z',
          ),
        ],
      },
    ]);

    expect(board.missions[0]?.occurrences[0]?.shifts[0]?.timezone).toBe(
      'Indian/Reunion',
    );
  });

  it('orders a mission shifts by when they start', () => {
    const board = buildMissionBoard([
      {
        event: event('a', 'Day A'),
        zones: [zone('z1', 'a', 'Site', [post('p1', 'a', 'z1', 'Bar')])],
        shifts: [
          shift(
            'late',
            'a',
            'p1',
            '2026-08-01T14:00:00Z',
            '2026-08-01T16:00:00Z',
          ),
          shift(
            'early',
            'a',
            'p1',
            '2026-08-01T10:00:00Z',
            '2026-08-01T12:00:00Z',
          ),
        ],
      },
    ]);

    expect(
      board.missions[0]?.occurrences[0]?.shifts.map(
        (shiftLine) => shiftLine.id,
      ),
    ).toEqual(['early', 'late']);
  });

  it('counts a post with no shifts as a mission that is not staffed yet', () => {
    const board = buildMissionBoard([
      {
        event: event('a', 'Day A'),
        zones: [zone('z1', 'a', 'Site', [post('p1', 'a', 'z1', 'Prévention')])],
        shifts: [],
      },
    ]);

    expect(board.missions.map((mission) => mission.name)).toEqual([
      'Prévention',
    ]);
    expect(board.missions[0]?.shiftCount).toBe(0);
  });

  it('treats a zone with posts as a container, not a mission of its own', () => {
    const board = buildMissionBoard(twoDayFestival());

    expect(board.missions.map((mission) => mission.name)).not.toContain('Site');
  });

  it('treats a zone with no posts as a mission, because shifts can land on it', () => {
    const board = buildMissionBoard([
      {
        event: event('a', 'Day A'),
        zones: [zone('z1', 'a', 'Molo')],
        shifts: [
          shift(
            's1',
            'a',
            'z1',
            '2026-08-01T10:00:00Z',
            '2026-08-01T12:00:00Z',
          ),
        ],
      },
    ]);

    expect(board.missions.map((mission) => mission.name)).toEqual(['Molo']);
    expect(board.missions[0]?.occurrences[0]?.zoneName).toBeNull();
  });

  it('records the zone a post sits in', () => {
    const board = buildMissionBoard(twoDayFestival());

    const bar = board.missions.find((mission) => mission.name === 'Bar');
    expect(bar?.occurrences[0]?.zoneName).toBe('Site');
  });

  it('surfaces a shift whose location is missing rather than dropping it', () => {
    // The locations query failed for this day while the shifts query did not.
    // Work that still has to be staffed must not vanish from the page.
    const board = buildMissionBoard([
      {
        event: event('a', 'Day A'),
        zones: [],
        shifts: [
          shift(
            's1',
            'a',
            'ghost',
            '2026-08-01T10:00:00Z',
            '2026-08-01T12:00:00Z',
          ),
        ],
      },
    ]);

    expect(board.missions).toHaveLength(0);
    expect(board.unplacedShifts.map((shiftLine) => shiftLine.id)).toEqual([
      's1',
    ]);
  });
});

describe('narrowToEvent', () => {
  it('keeps only the selected day, and says how many other days run the mission', () => {
    const narrowed = narrowToEvent(buildMissionBoard(twoDayFestival()), 'dub');

    const bar = narrowed.missions.find((mission) => mission.name === 'Bar');
    expect(bar?.occurrences.map((occurrence) => occurrence.eventId)).toEqual([
      'dub',
    ]);
    expect(bar?.alsoAtDays).toBe(1);
    expect(bar?.shiftCount).toBe(1);
    expect(bar?.requiredTotal).toBe(4);
  });

  it('drops a mission the selected day does not run at all', () => {
    const narrowed = narrowToEvent(buildMissionBoard(twoDayFestival()), 'dub');

    expect(narrowed.missions.map((mission) => mission.name)).toEqual(['Bar']);
  });

  it('reports no other days for a mission only one day runs', () => {
    const narrowed = narrowToEvent(
      buildMissionBoard(twoDayFestival()),
      'open-air',
    );

    const entrance = narrowed.missions.find(
      (mission) => mission.name === 'Entrée',
    );
    expect(entrance?.alsoAtDays).toBe(0);
  });

  it('narrows the unplaced shifts to the selected day too', () => {
    const board = buildMissionBoard([
      {
        event: event('a', 'Day A'),
        zones: [],
        shifts: [
          shift(
            's1',
            'a',
            'ghost',
            '2026-08-01T10:00:00Z',
            '2026-08-01T12:00:00Z',
          ),
        ],
      },
      {
        event: event('b', 'Day B'),
        zones: [],
        shifts: [
          shift(
            's2',
            'b',
            'ghost',
            '2026-08-02T10:00:00Z',
            '2026-08-02T12:00:00Z',
          ),
        ],
      },
    ]);

    expect(
      narrowToEvent(board, 'b').unplacedShifts.map((shiftLine) => shiftLine.id),
    ).toEqual(['s2']);
  });
});
