// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { describe, expect, it } from 'vitest';

import type { Event } from '../api/events';
import type { Post, Zone } from '../api/locations';
import {
  buildMissionCatalog,
  groupByZone,
  type CatalogSource,
  type ZoneGroup,
} from './missionCatalog';
import { canRemoveDay, dayCopy, dayRemoval } from './missionDays';

function event(id: string, name: string): Event {
  return {
    id,
    festival_id: 'festival-1',
    name,
    slug: id,
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
  extra: Partial<Post> = {},
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
    ...extra,
  };
}

function zone(
  id: string,
  eventId: string,
  name: string,
  posts: Post[] = [],
  extra: Partial<Zone> = {},
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
    ...extra,
  };
}

/** The one zone group of a catalog built from `sources`. */
function onlyGroup(sources: readonly CatalogSource[]): ZoneGroup {
  const [group] = groupByZone(buildMissionCatalog(sources).missions).zones;
  if (group === undefined) {
    throw new Error('expected one zone in the catalog');
  }
  return group;
}

const OPEN_AIR = event('open-air', 'Open Air');
const CLUB = event('club', 'Club night');

describe('dayCopy', () => {
  it('copies every field the zone states on its first day', () => {
    const group = onlyGroup([
      {
        event: OPEN_AIR,
        zones: [
          zone('bar-oa', 'open-air', 'Bar', [], {
            description: 'Serve drinks',
            address: 'Behind the main stage',
            exact_address: '1 rue du Port',
            latitude: 48.8566,
            longitude: 2.3522,
            min_volunteers: 2,
            max_volunteers: 6,
            checked_by_default: false,
            adults_only: true,
          }),
        ],
      },
    ]);

    expect(dayCopy(group).zone).toEqual({
      kind: 'zone',
      name: 'Bar',
      description: 'Serve drinks',
      address: 'Behind the main stage',
      exactAddress: '1 rue du Port',
      latitude: 48.8566,
      longitude: 2.3522,
      minVolunteers: 2,
      maxVolunteers: 6,
      checkedByDefault: false,
      adultsOnly: true,
    });
  });

  it('leaves out what the zone does not state, rather than sending it empty', () => {
    const group = onlyGroup([
      { event: OPEN_AIR, zones: [zone('bar-oa', 'open-air', 'Bar')] },
    ]);

    expect(dayCopy(group).zone).toEqual({
      kind: 'zone',
      name: 'Bar',
      checkedByDefault: true,
      adultsOnly: false,
    });
  });

  it('copies each post as it stands on the zone’s first day', () => {
    const group = onlyGroup([
      {
        event: OPEN_AIR,
        zones: [
          zone('bar-oa', 'open-air', 'Bar', [
            post('till-oa', 'open-air', 'bar-oa', 'Till', {
              description: 'Open-air till',
              min_volunteers: 1,
            }),
          ]),
        ],
      },
      {
        event: CLUB,
        zones: [
          zone('bar-cl', 'club', 'Bar', [
            post('till-cl', 'club', 'bar-cl', 'Till', {
              description: 'Club till',
            }),
          ]),
        ],
      },
    ]);

    expect(dayCopy(group).posts).toEqual([
      {
        kind: 'post',
        name: 'Till',
        description: 'Open-air till',
        minVolunteers: 1,
      },
    ]);
  });

  it('copies a post that does not run on the zone’s first day from its own first day', () => {
    const group = onlyGroup([
      { event: OPEN_AIR, zones: [zone('bar-oa', 'open-air', 'Bar')] },
      {
        event: CLUB,
        zones: [
          zone('bar-cl', 'club', 'Bar', [
            post('vip-cl', 'club', 'bar-cl', 'VIP corner', {
              address: 'Mezzanine',
            }),
          ]),
        ],
      },
    ]);

    expect(dayCopy(group).posts).toEqual([
      { kind: 'post', name: 'VIP corner', address: 'Mezzanine' },
    ]);
  });
});

describe('canRemoveDay', () => {
  it('refuses the last day, which is deleting the zone, not narrowing it', () => {
    const group = onlyGroup([
      { event: OPEN_AIR, zones: [zone('bar-oa', 'open-air', 'Bar')] },
    ]);

    expect(canRemoveDay(group.zone)).toBe(false);
  });

  it('allows any day while another remains', () => {
    const group = onlyGroup([
      { event: OPEN_AIR, zones: [zone('bar-oa', 'open-air', 'Bar')] },
      { event: CLUB, zones: [zone('bar-cl', 'club', 'Bar')] },
    ]);

    expect(canRemoveDay(group.zone)).toBe(true);
  });
});

describe('dayRemoval', () => {
  const sources: readonly CatalogSource[] = [
    {
      event: OPEN_AIR,
      zones: [
        zone('bar-oa', 'open-air', 'Bar', [
          post('till-oa', 'open-air', 'bar-oa', 'Till'),
        ]),
      ],
    },
    { event: CLUB, zones: [zone('bar-cl', 'club', 'Bar')] },
  ];

  it('names the posts that day holds, and counts the shifts of the zone and its posts', () => {
    const removal = dayRemoval(onlyGroup(sources), 'open-air', [
      { location_id: 'bar-oa' },
      { location_id: 'till-oa' },
      { location_id: 'till-oa' },
      { location_id: 'somewhere-else' },
    ]);

    expect(removal).toMatchObject({
      placement: { locationId: 'bar-oa', eventId: 'open-air' },
      postNames: ['Till'],
      shiftCount: 3,
      cascades: true,
    });
  });

  it('does not cascade from a day with no posts and no shifts', () => {
    const removal = dayRemoval(onlyGroup(sources), 'club', []);

    expect(removal).toMatchObject({
      placement: { locationId: 'bar-cl' },
      postNames: [],
      shiftCount: 0,
      cascades: false,
    });
  });

  it('cascades for a post alone, with no shift anywhere', () => {
    expect(dayRemoval(onlyGroup(sources), 'open-air', [])?.cascades).toBe(true);
  });

  it('is null for a day the zone does not run on', () => {
    expect(dayRemoval(onlyGroup(sources), 'after', [])).toBeNull();
  });
});
