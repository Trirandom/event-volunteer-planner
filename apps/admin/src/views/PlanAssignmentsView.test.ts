// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The assignation board, mounted through the router.
 *
 * `plan/roster.ts` proves the arithmetic without a component anywhere near it.
 * What is worth a component test is the part that is only true once the page
 * is assembled: that a seat's dropdown is built from the *day's own* roster
 * and not the festival's, that choosing a name writes one placement and
 * choosing a different one writes a cancellation before it, and that a refusal
 * — which is a normal outcome here, because three hard rules guard the write —
 * is put on screen rather than swallowed.
 */
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type * as assignmentsApi from '../api/assignments';
import * as assignments from '../api/assignments';
import type * as eventsApi from '../api/events';
import * as events from '../api/events';
import type * as festivalsApi from '../api/festivals';
import * as festivals from '../api/festivals';
import type * as locationsApi from '../api/locations';
import * as locations from '../api/locations';
import type * as participationsApi from '../api/participations';
import * as participations from '../api/participations';
import * as sessionApi from '../api/session';
import type * as shiftsApi from '../api/shifts';
import * as shifts from '../api/shifts';
import { setLocale } from '../i18n';
import PlanAssignmentsView from './PlanAssignmentsView.vue';

const AUTHENTICATED_USER: sessionApi.Session = {
  status: 'authenticated',
  user: {
    id: 'user-1',
    email: 'coordinator@example.org',
    display_name: 'Coordinator',
    locale: 'en',
    memberships: [
      { org_id: 'org-1', slug: 'org-1', name: 'Org One', role: 'coordinator' },
    ],
  },
};

function event(
  id: string,
  name: string,
  overrides: Partial<eventsApi.Event> = {},
): eventsApi.Event {
  return {
    id,
    festival_id: 'festival-1',
    name,
    slug: id,
    timezone: 'Europe/Paris',
    period: { start: '2026-08-01T08:00:00Z', end: '2026-08-01T22:00:00Z' },
    status: 'draft',
    color: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    version: 1,
    ...overrides,
  };
}

const OPEN_AIR = event('open-air', 'Open Air');
const DUB = event('dub', 'Dub & 2step', {
  period: { start: '2026-08-02T18:00:00Z', end: '2026-08-03T06:00:00Z' },
  color: 5,
});

function festivalDetail(): festivalsApi.FestivalDetail {
  return {
    id: 'festival-1',
    name: 'Soundclash 26',
    slug: 'soundclash-26',
    timezone: 'Europe/Paris',
    period: { start: '2026-07-30T08:00:00Z', end: '2026-08-04T18:00:00Z' },
    status: 'planning',
    event_count: 2,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    version: 1,
    events: [OPEN_AIR, DUB],
  };
}

function zone(eventId: string, name: string): locationsApi.Zone {
  return {
    id: `zone-${eventId}`,
    event_id: eventId,
    parent_id: null,
    kind: 'zone',
    name,
    sort_order: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    version: 1,
    posts: [
      {
        id: `${eventId}-bar`,
        event_id: eventId,
        parent_id: `zone-${eventId}`,
        kind: 'post',
        name: 'Bar',
        sort_order: 0,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        version: 1,
      },
    ],
  };
}

function shift(
  id: string,
  eventId: string,
  start: string,
  end: string,
  requiredCount = 2,
): shiftsApi.Shift {
  return {
    id,
    event_id: eventId,
    location_id: `${eventId}-bar`,
    period: { start, end },
    required_count: requiredCount,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    version: 1,
  };
}

function person(
  id: string,
  name: string,
  overrides: Partial<participationsApi.Participation> = {},
): participationsApi.Participation {
  return {
    id,
    volunteer_id: `volunteer-${id}`,
    display_name: name,
    status: 'invited',
    availability: [],
    ...overrides,
  };
}

const TREES: Readonly<Record<string, readonly locationsApi.Zone[]>> = {
  'open-air': [zone('open-air', 'Site')],
  dub: [zone('dub', 'Club')],
};

const SHIFTS: Readonly<Record<string, readonly shiftsApi.Shift[]>> = {
  'open-air': [
    shift('s1', 'open-air', '2026-08-01T10:00:00Z', '2026-08-01T12:00:00Z'),
  ],
  dub: [shift('s3', 'dub', '2026-08-02T20:00:00Z', '2026-08-02T23:00:00Z')],
};

/** Each day has its own roster: enrolment is per edition, and offering
 * Saturday's volunteers for Sunday is a click the server refuses. */
const ROSTERS: Readonly<
  Record<string, readonly participationsApi.Participation[]>
> = {
  'open-air': [
    person('p-camille', 'Camille', {
      availability: [
        {
          kind: 'available',
          period: {
            start: '2026-08-01T08:00:00Z',
            end: '2026-08-01T18:00:00Z',
          },
        },
      ],
    }),
    person('p-aurel', 'Aurel'),
  ],
  dub: [person('p-jon', 'Jon')],
};

function assignment(
  overrides: Partial<assignmentsApi.Assignment> = {},
): assignmentsApi.Assignment {
  return {
    id: 'a1',
    event_id: 'open-air',
    shift_id: 's1',
    participation_id: 'p-camille',
    volunteer_id: 'volunteer-p-camille',
    period: { start: '2026-08-01T10:00:00Z', end: '2026-08-01T12:00:00Z' },
    status: 'draft',
    assigned_at: '2026-08-01T09:00:00Z',
    version: 3,
    ...overrides,
  };
}

let roster: Readonly<Record<string, readonly assignmentsApi.Assignment[]>> = {};

function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/:orgId/festivals/:festivalId/assignments',
        name: 'org-festival-assignments',
        component: PlanAssignmentsView,
      },
      {
        path: '/:orgId/events/:eventId/assignments',
        name: 'org-event-assignments',
        component: PlanAssignmentsView,
      },
      // The hint and both empty states link to these. Named routes resolve at
      // render, so a router without them fails every test here rather than
      // the one about the link.
      {
        path: '/:orgId/festivals/:festivalId/shifts',
        name: 'org-festival-shifts',
        component: { template: '<p>shifts</p>' },
      },
      {
        path: '/:orgId/events/:eventId/shifts',
        name: 'org-event-shifts',
        component: { template: '<p>shifts</p>' },
      },
      {
        path: '/:orgId/festivals/:festivalId/missions',
        name: 'org-festival-missions',
        component: { template: '<p>missions</p>' },
      },
      {
        path: '/:orgId/events/:eventId/missions',
        name: 'org-event-missions',
        component: { template: '<p>missions</p>' },
      },
    ],
  });
}

async function mountView(path: string) {
  const router = testRouter();
  await router.push(path);
  await router.isReady();

  const wrapper = mount(PlanAssignmentsView, {
    global: {
      plugins: [
        router,
        createPinia(),
        [
          VueQueryPlugin,
          {
            queryClient: new QueryClient({
              defaultOptions: { queries: { retry: false } },
            }),
          },
        ],
      ],
    },
  });
  await flushPromises();
  return wrapper;
}

/** The seat's own trigger button — its `role="combobox"` — never the
 * listbox, which only exists once opened and lives outside this element
 * entirely (`<Teleport to="body">`, so the slot's own `overflow: hidden`
 * cannot clip it). */
function comboAt(
  wrapper: Awaited<ReturnType<typeof mountView>>,
  index: number,
) {
  return wrapper.findAll('[role="combobox"]')[index];
}

async function openCombo(
  wrapper: Awaited<ReturnType<typeof mountView>>,
  index: number,
): Promise<void> {
  await comboAt(wrapper, index)?.trigger('click');
  await flushPromises();
}

/** Whatever the currently open seat's listbox is showing — teleported to
 * `document.body`, so it is read from there and not from the component's own
 * wrapper. */
function listboxOptions() {
  return new DOMWrapper(document.body).findAll('[role="option"]');
}

async function chooseByText(
  wrapper: Awaited<ReturnType<typeof mountView>>,
  index: number,
  text: string,
): Promise<void> {
  await openCombo(wrapper, index);
  const option = listboxOptions().find((row) => row.text().includes(text));
  await option?.trigger('click');
  await flushPromises();
}

beforeEach(() => {
  roster = {};
  vi.spyOn(sessionApi, 'fetchSession').mockResolvedValue(AUTHENTICATED_USER);
  vi.spyOn(festivals, 'fetchFestival').mockResolvedValue({
    ok: true,
    value: festivalDetail(),
  });
  vi.spyOn(events, 'fetchEvent').mockImplementation((_org, eventId) =>
    Promise.resolve({ ok: true, value: eventId === 'dub' ? DUB : OPEN_AIR }),
  );
  vi.spyOn(locations, 'fetchLocations').mockImplementation((_org, eventId) =>
    Promise.resolve({ ok: true, value: TREES[eventId] ?? [] }),
  );
  vi.spyOn(shifts, 'fetchShifts').mockImplementation((_org, eventId) =>
    Promise.resolve({ ok: true, value: SHIFTS[eventId] ?? [] }),
  );
  vi.spyOn(participations, 'fetchParticipations').mockImplementation(
    (_org, eventId) =>
      Promise.resolve({ ok: true, value: ROSTERS[eventId] ?? [] }),
  );
  vi.spyOn(assignments, 'fetchAssignments').mockImplementation(
    (_org, eventId) =>
      Promise.resolve({ ok: true, value: roster[eventId] ?? [] }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  // Only one seat is ever open at a time, but nothing here unmounts the
  // previous test's app, and a listbox left open teleports straight into the
  // real `document.body` — which the next test's queries would otherwise see.
  document.body.innerHTML = '';
});

describe('PlanAssignmentsView — the grid', () => {
  it('draws a slot per shift with a dropdown per place it needs', async () => {
    const wrapper = await mountView('/org-1/events/open-air/assignments');

    const slots = wrapper.findAll('.evp-slot');
    expect(slots).toHaveLength(1);
    // Two required, and no spare seat until both are filled.
    expect(slots[0]?.findAll('[role="combobox"]')).toHaveLength(2);
    expect(slots[0]?.text()).toContain('0/2');
    expect(slots[0]?.text()).not.toContain('add somebody (extra)');
  });

  /** The count and the dropdowns follow the mission's `min_volunteers`, not
   * the `required_count = 1` every freshly cut shift carries. */
  it('staffs each slot against its mission’s own minimum', async () => {
    const [site] = TREES['open-air'] ?? [];
    const [bar] = site?.posts ?? [];
    if (site === undefined || bar === undefined) {
      throw new Error('fixture missing');
    }
    vi.spyOn(locations, 'fetchLocations').mockResolvedValue({
      ok: true,
      value: [{ ...site, posts: [{ ...bar, min_volunteers: 4 }] }],
    });
    vi.spyOn(shifts, 'fetchShifts').mockResolvedValue({
      ok: true,
      value: [
        shift(
          's1',
          'open-air',
          '2026-08-01T10:00:00Z',
          '2026-08-01T12:00:00Z',
          1,
        ),
      ],
    });

    const wrapper = await mountView('/org-1/events/open-air/assignments');

    const slot = wrapper.find('.evp-slot');
    expect(slot.text()).toContain('0/4');
    expect(slot.findAll('[role="combobox"]')).toHaveLength(4);
    expect(slot.text()).not.toContain('add somebody (extra)');
  });

  it('offers an extra seat once every required one is filled', async () => {
    roster = {
      'open-air': [
        assignment(),
        assignment({
          id: 'a2',
          participation_id: 'p-aurel',
          volunteer_id: 'volunteer-p-aurel',
        }),
      ],
    };

    const wrapper = await mountView('/org-1/events/open-air/assignments');

    const slot = wrapper.find('.evp-slot');
    expect(slot.text()).toContain('2/2');
    expect(slot.findAll('[role="combobox"]')).toHaveLength(3);
    expect(slot.text()).toContain('add somebody (extra)');
  });

  it('marks a slot nobody is on as a hole', async () => {
    const wrapper = await mountView('/org-1/events/open-air/assignments');

    expect(wrapper.find('.evp-slot--empty').exists()).toBe(true);
  });

  it('seats whoever is already placed, and says the slot is short', async () => {
    roster = { 'open-air': [assignment()] };

    const wrapper = await mountView('/org-1/events/open-air/assignments');

    const slot = wrapper.find('.evp-slot');
    expect(slot.classes()).toContain('evp-slot--short');
    expect(slot.text()).toContain('1/2');
    expect(slot.text()).toContain('Camille');
  });

  /** The reason the roster is fetched per event and not per festival. */
  it('offers only the volunteers enrolled on that day', async () => {
    const wrapper = await mountView('/org-1/events/dub/assignments');

    await openCombo(wrapper, 0);

    const labels = listboxOptions().map((option) => option.text());
    expect(labels.join(' ')).toContain('Jon');
    expect(labels.join(' ')).not.toContain('Camille');
  });

  /** Somebody who declared these hours comes before somebody who said
   * nothing — the whole reason the form asks (docs/09 §3). */
  it('ranks the volunteers who said they are free first', async () => {
    const wrapper = await mountView('/org-1/events/open-air/assignments');

    await openCombo(wrapper, 0);

    const names = listboxOptions()
      .map((option) => option.text())
      .filter((text) => text.includes('—') && !text.includes('nobody'));
    expect(names[0]).toContain('Camille');
    expect(names[0]).toContain('free');
    expect(names[1]).toContain('Aurel');
    expect(names[1]).toContain('no answer');
  });

  /** A listbox per seat holding six hundred names is a hundred thousand DOM
   * nodes. Only the seat in use carries its list, and only one seat is ever
   * open at a time. */
  it('builds a seat’s option list only once it is used', async () => {
    const wrapper = await mountView('/org-1/events/open-air/assignments');

    expect(listboxOptions()).toHaveLength(0);

    await openCombo(wrapper, 0);

    expect(
      new DOMWrapper(document.body).findAll('[role="listbox"]'),
    ).toHaveLength(1);
    expect(listboxOptions().length).toBeGreaterThan(1);
  });

  it('says so when the missions are not cut into shifts yet', async () => {
    vi.spyOn(shifts, 'fetchShifts').mockResolvedValue({ ok: true, value: [] });

    const wrapper = await mountView('/org-1/events/open-air/assignments');

    expect(wrapper.text()).toContain('not cut into shifts yet');
    expect(wrapper.find('.evp-slot').exists()).toBe(false);
  });

  /** A roster that failed to load looks exactly like a day nobody signed up
   * for, which is the one reading a coordinator must not be left with. */
  it('says so when a day’s volunteers could not be loaded', async () => {
    vi.spyOn(participations, 'fetchParticipations').mockResolvedValue({
      ok: false,
      failure: { reason: 'unavailable' },
    });

    const wrapper = await mountView('/org-1/events/open-air/assignments');

    expect(wrapper.text()).toContain('volunteers could not be loaded');
  });
});

describe('PlanAssignmentsView — writing', () => {
  it('rosters the volunteer a coordinator picks', async () => {
    const create = vi.spyOn(assignments, 'createAssignment').mockResolvedValue({
      ok: true,
      assignment: assignment(),
      operationId: 'op-1',
    });

    const wrapper = await mountView('/org-1/events/open-air/assignments');
    await chooseByText(wrapper, 0, 'Camille');

    expect(create).toHaveBeenCalledWith('org-1', 'open-air', {
      shiftId: 's1',
      participationId: 'p-camille',
    });
  });

  /** A swap is a cancellation and then a placement, in that order: the
   * outgoing volunteer holds the hours the incoming one wants, so sending
   * both at once means the exclusion constraint refuses the new name for
   * clashing with the person it replaces. */
  it('takes the previous volunteer off before putting the new one on', async () => {
    roster = { 'open-air': [assignment()] };
    const order: string[] = [];
    const cancel = vi
      .spyOn(assignments, 'cancelAssignment')
      .mockImplementation(() => {
        order.push('cancel');
        return Promise.resolve({ ok: true });
      });
    const create = vi
      .spyOn(assignments, 'createAssignment')
      .mockImplementation(() => {
        order.push('create');
        return Promise.resolve({
          ok: true,
          assignment: assignment({ id: 'a2', participation_id: 'p-aurel' }),
          operationId: 'op-2',
        });
      });

    const wrapper = await mountView('/org-1/events/open-air/assignments');
    await chooseByText(wrapper, 0, 'Aurel');

    expect(order).toStrictEqual(['cancel', 'create']);
    // The version the seat was read at travels as `If-Match` (docs/02 §7).
    expect(cancel).toHaveBeenCalledWith('org-1', 'open-air', 'a1', 3);
    expect(create).toHaveBeenCalledWith('org-1', 'open-air', {
      shiftId: 's1',
      participationId: 'p-aurel',
    });
  });

  it('takes somebody off when a coordinator picks nobody', async () => {
    roster = { 'open-air': [assignment()] };
    const cancel = vi
      .spyOn(assignments, 'cancelAssignment')
      .mockResolvedValue({ ok: true });
    const create = vi.spyOn(assignments, 'createAssignment');

    const wrapper = await mountView('/org-1/events/open-air/assignments');
    await openCombo(wrapper, 0);
    // The first row of a filled seat's list is always "— remove —"
    // (`emptyOptionLabel`).
    await listboxOptions()[0]?.trigger('click');
    await flushPromises();

    expect(cancel).toHaveBeenCalledWith('org-1', 'open-air', 'a1', 3);
    expect(create).not.toHaveBeenCalled();
  });

  /** A refusal is the normal case on this page — the database has the last
   * word on who can work when — so it is explained inline, in the server's own
   * sentence, rather than thrown or reduced to a code. */
  it('shows the refusal when the database says no', async () => {
    vi.spyOn(assignments, 'createAssignment').mockResolvedValue({
      ok: false,
      rejection: {
        reason: 'validation-failed',
        detail: 'That volunteer is already working during those hours.',
      },
    });

    const wrapper = await mountView('/org-1/events/open-air/assignments');
    await chooseByText(wrapper, 0, 'Camille');

    expect(wrapper.find('[role="alert"]').text()).toContain(
      'already working during those hours',
    );
  });

  it('says the place is now empty when only half a swap went through', async () => {
    roster = { 'open-air': [assignment()] };
    vi.spyOn(assignments, 'cancelAssignment').mockResolvedValue({ ok: true });
    vi.spyOn(assignments, 'createAssignment').mockResolvedValue({
      ok: false,
      rejection: { reason: 'validation-failed', detail: 'Already working.' },
    });

    const wrapper = await mountView('/org-1/events/open-air/assignments');
    await chooseByText(wrapper, 0, 'Aurel');

    expect(wrapper.find('[role="alert"]').text()).toContain(
      'the place is now empty',
    );
  });
});

describe('PlanAssignmentsView — the coverage count', () => {
  it('counts the places filled against those required', async () => {
    const wrapper = await mountView('/org-1/events/open-air/assignments');

    expect(wrapper.find('.evp-coverage').text()).toBe('0 of 2 places filled');
  });

  /** French puts 0 in the singular, which a hand-rolled `n > 1` got right
   * only by accident and an English-shaped `n === 1` gets wrong. */
  describe('in French', () => {
    beforeAll(async () => {
      await setLocale('fr');
    });
    afterAll(async () => {
      await setLocale('en');
    });

    it.each([
      [0, '0 place pourvue sur 2'],
      [1, '1 place pourvue sur 2'],
      [2, '2 places pourvues sur 2'],
    ])('says %i filled as “%s”', async (filled, expected) => {
      roster = {
        'open-air': [
          assignment(),
          assignment({
            id: 'a2',
            participation_id: 'p-aurel',
            volunteer_id: 'volunteer-p-aurel',
          }),
        ].slice(0, filled),
      };

      const wrapper = await mountView('/org-1/events/open-air/assignments');

      expect(wrapper.find('.evp-coverage').text()).toBe(expected);
    });
  });
});
