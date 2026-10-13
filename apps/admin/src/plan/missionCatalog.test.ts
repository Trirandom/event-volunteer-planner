// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Event } from '../api/events';
import type { Post, Zone } from '../api/locations';
import { setLocale } from '../i18n';
import {
  buildMissionCatalog,
  groupByZone,
  volunteerBoundsLabel,
  missionExists,
  missionKey,
  missionKind,
  type CatalogSource,
} from './missionCatalog';

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

interface Described {
  readonly description?: string;
  readonly address?: string;
  readonly minVolunteers?: number;
  readonly maxVolunteers?: number;
  readonly checkedByDefault?: boolean;
  readonly adultsOnly?: boolean;
  readonly version?: number;
}

function post(
  id: string,
  eventId: string,
  parentId: string,
  name: string,
  extra: Described = {},
): Post {
  return {
    id,
    event_id: eventId,
    parent_id: parentId,
    kind: 'post',
    name,
    ...(extra.description === undefined
      ? {}
      : { description: extra.description }),
    ...(extra.address === undefined ? {} : { address: extra.address }),
    ...(extra.minVolunteers === undefined
      ? {}
      : { min_volunteers: extra.minVolunteers }),
    ...(extra.maxVolunteers === undefined
      ? {}
      : { max_volunteers: extra.maxVolunteers }),
    sort_order: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    version: extra.version ?? 1,
  };
}

function zone(
  id: string,
  eventId: string,
  name: string,
  posts: Post[] = [],
  extra: Described = {},
): Zone {
  return {
    id,
    event_id: eventId,
    parent_id: null,
    kind: 'zone',
    name,
    ...(extra.description === undefined
      ? {}
      : { description: extra.description }),
    ...(extra.address === undefined ? {} : { address: extra.address }),
    ...(extra.checkedByDefault === undefined
      ? {}
      : { checked_by_default: extra.checkedByDefault }),
    ...(extra.adultsOnly === undefined
      ? {}
      : { adults_only: extra.adultsOnly }),
    sort_order: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    version: extra.version ?? 1,
    posts,
  };
}

/** Two days of one festival, each with a "Site" zone. */
function twoDays(
  openAirPosts: Post[],
  clubPosts: Post[],
): readonly CatalogSource[] {
  return [
    {
      event: event('event-1', 'Open Air'),
      zones: [zone('zone-1', 'event-1', 'Site', openAirPosts)],
    },
    {
      event: event('event-2', 'Club night'),
      zones: [zone('zone-2', 'event-2', 'Site', clubPosts)],
    },
  ];
}

describe('missionKey', () => {
  it('folds case and surrounding whitespace, which is what makes two days one mission', () => {
    expect(missionKey('  Bar  ')).toBe('bar');
    expect(missionKey('BAR')).toBe(missionKey('bar'));
  });
});

describe('buildMissionCatalog', () => {
  it('folds the same post on two days into one mission', () => {
    const catalog = buildMissionCatalog(
      twoDays(
        [post('post-1', 'event-1', 'zone-1', 'Bar')],
        [post('post-2', 'event-2', 'zone-2', 'Bar')],
      ),
    );

    const bar = catalog.missions.find((mission) => mission.key === 'bar');
    expect(bar?.placements.map((placement) => placement.eventName)).toEqual([
      'Open Air',
      'Club night',
    ]);
    expect(bar?.missingFrom).toEqual([]);
  });

  it('keeps a zone even when it holds posts, because somebody named it', () => {
    const catalog = buildMissionCatalog(
      twoDays([post('post-1', 'event-1', 'zone-1', 'Bar')], []),
    );

    // `missions.ts` drops a container zone; this module must not — a zone that
    // cannot be renamed here can only be reached through psql.
    expect(catalog.missions.map((mission) => mission.key)).toEqual([
      'bar',
      'site',
    ]);
  });

  it('records which zone a post sits in, and nothing for a zone', () => {
    const catalog = buildMissionCatalog(
      twoDays([post('post-1', 'event-1', 'zone-1', 'Bar')], []),
    );

    const bar = catalog.missions.find((mission) => mission.key === 'bar');
    const site = catalog.missions.find((mission) => mission.key === 'site');
    expect(bar?.placements[0]?.zoneName).toBe('Site');
    expect(bar?.placements[0]?.kind).toBe('post');
    expect(site?.placements[0]?.zoneName).toBeNull();
    expect(site?.placements[0]?.kind).toBe('zone');
  });

  it('carries each rowid and version, because a write asserts against them', () => {
    const catalog = buildMissionCatalog(
      twoDays(
        [post('post-1', 'event-1', 'zone-1', 'Bar', { version: 4 })],
        [post('post-2', 'event-2', 'zone-2', 'Bar', { version: 9 })],
      ),
    );

    const bar = catalog.missions.find((mission) => mission.key === 'bar');
    expect(
      bar?.placements.map((placement) => [
        placement.locationId,
        placement.version,
      ]),
    ).toEqual([
      ['post-1', 4],
      ['post-2', 9],
    ]);
  });

  it('names the days that do not run a mission', () => {
    const catalog = buildMissionCatalog(
      twoDays([post('post-1', 'event-1', 'zone-1', 'Bar')], []),
    );

    const bar = catalog.missions.find((mission) => mission.key === 'bar');
    expect(bar?.missingFrom.map((day) => day.eventName)).toEqual([
      'Club night',
    ]);
  });

  it('sorts on the normalised key, so the order does not depend on the host locale', () => {
    const catalog = buildMissionCatalog([
      {
        event: event('event-1', 'Open Air'),
        zones: [
          zone('zone-1', 'event-1', 'Site', [
            post('post-2', 'event-1', 'zone-1', 'accueil'),
            post('post-1', 'event-1', 'zone-1', 'Bar'),
          ]),
        ],
      },
    ]);

    expect(catalog.missions.map((mission) => mission.key)).toEqual([
      'accueil',
      'bar',
      'site',
    ]);
  });

  it('keeps the first day’s spelling as the mission name', () => {
    const catalog = buildMissionCatalog(
      twoDays(
        [post('post-1', 'event-1', 'zone-1', 'Bar')],
        [post('post-2', 'event-2', 'zone-2', 'BAR')],
      ),
    );

    const bar = catalog.missions.find((mission) => mission.key === 'bar');
    expect(bar?.name).toBe('Bar');
    expect(bar?.placements.map((placement) => placement.name)).toEqual([
      'Bar',
      'BAR',
    ]);
  });

  it('lists the days in the order they were given', () => {
    const catalog = buildMissionCatalog(twoDays([], []));
    expect(catalog.days.map((day) => day.eventName)).toEqual([
      'Open Air',
      'Club night',
    ]);
  });
});

describe('buildMissionCatalog — description and address', () => {
  it('reports a value the days agree on as the mission’s own', () => {
    const catalog = buildMissionCatalog(
      twoDays(
        [
          post('post-1', 'event-1', 'zone-1', 'Bar', {
            description: 'Serving and glass return.',
            address: 'Halle 3',
          }),
        ],
        [
          post('post-2', 'event-2', 'zone-2', 'Bar', {
            description: 'Serving and glass return.',
            address: 'Halle 3',
          }),
        ],
      ),
    );

    const bar = catalog.missions.find((mission) => mission.key === 'bar');
    expect(bar?.description).toBe('Serving and glass return.');
    expect(bar?.address).toBe('Halle 3');
    expect(bar?.descriptionVaries).toBe(false);
    expect(bar?.addressVaries).toBe(false);
  });

  it('flags a field the days disagree about rather than picking one', () => {
    const catalog = buildMissionCatalog(
      twoDays(
        [post('post-1', 'event-1', 'zone-1', 'Bar', { address: 'Halle 3' })],
        [post('post-2', 'event-2', 'zone-2', 'Bar', { address: 'The club' })],
      ),
    );

    const bar = catalog.missions.find((mission) => mission.key === 'bar');
    expect(bar?.addressVaries).toBe(true);
    // Not 'Halle 3': showing one of two in a single box is how a form
    // overwrites the other one without anybody deciding to.
    expect(bar?.address).toBeNull();
  });

  it('treats present-on-one-day-only as a disagreement, not as a value', () => {
    const catalog = buildMissionCatalog(
      twoDays(
        [post('post-1', 'event-1', 'zone-1', 'Bar', { address: 'Halle 3' })],
        [post('post-2', 'event-2', 'zone-2', 'Bar')],
      ),
    );

    const bar = catalog.missions.find((mission) => mission.key === 'bar');
    expect(bar?.addressVaries).toBe(true);
  });

  it('is not a disagreement when nobody has said anything', () => {
    const catalog = buildMissionCatalog(
      twoDays(
        [post('post-1', 'event-1', 'zone-1', 'Bar')],
        [post('post-2', 'event-2', 'zone-2', 'Bar')],
      ),
    );

    const bar = catalog.missions.find((mission) => mission.key === 'bar');
    expect(bar?.description).toBeNull();
    expect(bar?.descriptionVaries).toBe(false);
  });
});

describe('buildMissionCatalog — volunteer bounds', () => {
  it('folds bounds the days agree on, and flags one they do not', () => {
    const catalog = buildMissionCatalog(
      twoDays(
        [
          post('post-1', 'event-1', 'zone-1', 'Bar', {
            minVolunteers: 2,
            maxVolunteers: 6,
          }),
        ],
        [
          post('post-2', 'event-2', 'zone-2', 'Bar', {
            minVolunteers: 2,
            maxVolunteers: 4,
          }),
        ],
      ),
    );

    const bar = catalog.missions.find((mission) => mission.key === 'bar');
    expect(bar?.minVolunteers).toBe('2');
    expect(bar?.minVolunteersVaries).toBe(false);
    expect(bar?.maxVolunteers).toBeNull();
    expect(bar?.maxVolunteersVaries).toBe(true);
  });
});

describe('buildMissionCatalog — form flags', () => {
  function bar(
    openAir: Described,
    club: Described,
  ): ReturnType<typeof buildMissionCatalog>['missions'][number] | undefined {
    return buildMissionCatalog([
      {
        event: event('event-1', 'Open Air'),
        zones: [zone('zone-1', 'event-1', 'Bar', [], openAir)],
      },
      {
        event: event('event-2', 'Club night'),
        zones: [zone('zone-2', 'event-2', 'Bar', [], club)],
      },
    ]).missions.find((mission) => mission.key === 'bar');
  }

  it('folds flags the days agree on, and flags one they do not', () => {
    const mission = bar(
      { checkedByDefault: false, adultsOnly: true },
      { checkedByDefault: true, adultsOnly: true },
    );
    expect(mission?.adultsOnly).toBe(true);
    expect(mission?.adultsOnlyVaries).toBe(false);
    expect(mission?.checkedByDefault).toBeNull();
    expect(mission?.checkedByDefaultVaries).toBe(true);
  });

  it('reads an absent key on a zone as the server default, not as a disagreement', () => {
    const mission = bar({}, { checkedByDefault: true, adultsOnly: false });
    expect(mission?.checkedByDefault).toBe(true);
    expect(mission?.checkedByDefaultVaries).toBe(false);
    expect(mission?.adultsOnly).toBe(false);
    expect(mission?.adultsOnlyVaries).toBe(false);
  });

  it('gives a post no flags of its own', () => {
    const catalog = buildMissionCatalog(
      twoDays(
        [post('post-1', 'event-1', 'zone-1', 'Caisse')],
        [post('post-2', 'event-2', 'zone-2', 'Caisse')],
      ),
    );
    const caisse = catalog.missions.find((m) => m.key === 'caisse');
    expect(caisse?.checkedByDefault).toBeNull();
    expect(caisse?.adultsOnly).toBeNull();
    expect(caisse?.checkedByDefaultVaries).toBe(false);
    expect(caisse?.placements[0]?.adultsOnly).toBeNull();
  });
});

describe('volunteerBoundsLabel', () => {
  function labelFor(extra: Described): string | null {
    const catalog = buildMissionCatalog(
      twoDays(
        [post('post-1', 'event-1', 'zone-1', 'Bar', extra)],
        [post('post-2', 'event-2', 'zone-2', 'Bar', extra)],
      ),
    );
    const bar = catalog.missions.find((mission) => mission.key === 'bar');
    return bar === undefined ? null : volunteerBoundsLabel(bar);
  }

  it.each([
    [{ minVolunteers: 2, maxVolunteers: 5 }, '2–5 volunteers'],
    [{ minVolunteers: 3, maxVolunteers: 3 }, '3 volunteers'],
    [{ minVolunteers: 1 }, 'At least 1 volunteer'],
    [{ maxVolunteers: 4 }, 'Up to 4 volunteers'],
    [{}, null],
  ])('reads %o as %s', (extra, expected) => {
    expect(labelFor(extra)).toBe(expected);
  });

  // docs/16 §6: French puts 0 in the singular, which is exactly what the
  // hand-rolled `count === '1'` this replaced got wrong.
  describe('in French', () => {
    beforeAll(async () => {
      await setLocale('fr');
    });
    afterAll(async () => {
      await setLocale('en');
    });

    it.each([
      [{ minVolunteers: 0 }, 'Au moins 0 bénévole'],
      [{ minVolunteers: 1 }, 'Au moins 1 bénévole'],
      [{ minVolunteers: 2 }, 'Au moins 2 bénévoles'],
      [{ minVolunteers: 2, maxVolunteers: 5 }, '2–5 bénévoles'],
    ])('reads %o as %s', (extra, expected) => {
      expect(labelFor(extra)).toBe(expected);
    });
  });
});

describe('missionExists', () => {
  it('answers on the normalised name, so “bar” collides with “Bar”', () => {
    const catalog = buildMissionCatalog(
      twoDays([post('post-1', 'event-1', 'zone-1', 'Bar')], []),
    );

    expect(missionExists(catalog, '  bar ')).toBe(true);
    expect(missionExists(catalog, 'Buvette')).toBe(false);
  });
});

describe('missionKind', () => {
  it('reads a zone mission as a zone and a post mission as a post', () => {
    const catalog = buildMissionCatalog(
      twoDays([post('post-1', 'event-1', 'zone-1', 'Bar')], []),
    );

    const bar = catalog.missions.find((mission) => mission.key === 'bar');
    const site = catalog.missions.find((mission) => mission.key === 'site');
    expect(bar).toBeDefined();
    expect(site).toBeDefined();
    if (bar === undefined || site === undefined) {
      return;
    }
    expect(missionKind(bar)).toBe('post');
    expect(missionKind(site)).toBe('zone');
  });
});

describe('groupByZone', () => {
  it('nests a post under its zone', () => {
    const catalog = buildMissionCatalog(
      twoDays([post('post-1', 'event-1', 'zone-1', 'Bar')], []),
    );

    const grouped = groupByZone(catalog.missions);
    expect(grouped.zones).toHaveLength(1);
    expect(grouped.zones[0]?.zone.key).toBe('site');
    expect(grouped.zones[0]?.posts.map((post) => post.key)).toEqual(['bar']);
    expect(grouped.orphans).toEqual([]);
  });

  it('gives a zone with no posts an empty group rather than dropping it', () => {
    const catalog = buildMissionCatalog(twoDays([], []));

    const grouped = groupByZone(catalog.missions);
    expect(grouped.zones).toHaveLength(1);
    expect(grouped.zones[0]?.posts).toEqual([]);
  });

  it('keeps several posts under the same zone, each their own group entry', () => {
    const catalog = buildMissionCatalog([
      {
        event: event('event-1', 'Open Air'),
        zones: [
          zone('zone-1', 'event-1', 'Site', [
            post('post-1', 'event-1', 'zone-1', 'Bar'),
            post('post-2', 'event-1', 'zone-1', 'Entrance'),
          ]),
        ],
      },
    ]);

    const grouped = groupByZone(catalog.missions);
    expect(grouped.zones[0]?.posts.map((post) => post.key).sort()).toEqual([
      'bar',
      'entrance',
    ]);
  });

  it('treats a post whose placements disagree on which zone it sits in as an orphan, not as dropped', () => {
    // A post named "Site" behind Backstage on day one, and — a coincidence of
    // the name fold, not a real relationship — a zone also named "Site" on
    // day two. `missionCatalog.ts` folds them into one mission by name
    // regardless; `groupByZone` refuses to guess which zone it belongs under
    // when the placements do not agree, rather than nesting it somewhere
    // wrong.
    const catalog = buildMissionCatalog([
      {
        event: event('event-1', 'Open Air'),
        zones: [
          zone('zone-1', 'event-1', 'Backstage', [
            post('post-1', 'event-1', 'zone-1', 'Site'),
          ]),
        ],
      },
      {
        event: event('event-2', 'Club night'),
        zones: [zone('zone-2', 'event-2', 'Site', [])],
      },
    ]);

    const grouped = groupByZone(catalog.missions);
    expect(grouped.zones.map((group) => group.zone.key)).toEqual(['backstage']);
    expect(grouped.zones[0]?.posts).toEqual([]);
    expect(grouped.orphans.map((mission) => mission.key)).toEqual(['site']);
  });
});
