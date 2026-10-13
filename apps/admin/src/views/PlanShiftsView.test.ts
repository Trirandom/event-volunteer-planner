// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { eventColor } from '@evp/shared';
import { Temporal } from '@evp/shared/time';
import { flushPromises, mount } from '@vue/test-utils';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
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

import type * as eventsApi from '../api/events';
import * as events from '../api/events';
import type * as festivalsApi from '../api/festivals';
import * as festivals from '../api/festivals';
import type * as locationsApi from '../api/locations';
import * as locations from '../api/locations';
import * as sessionApi from '../api/session';
import type * as shiftsApi from '../api/shifts';
import * as shifts from '../api/shifts';
import { setLocale, t } from '../i18n';
import PlanShiftsView from './PlanShiftsView.vue';

const AUTHENTICATED_USER: sessionApi.Session = {
  status: 'authenticated',
  user: {
    id: 'user-1',
    email: 'coordinator@example.org',
    display_name: 'Coordinator',
    locale: 'en',
    memberships: [
      { org_id: 'org-1', slug: 'org-1', name: 'Org One', role: 'owner' },
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
    period: { start: '2026-08-01T08:00:00Z', end: '2026-08-01T18:00:00Z' },
    status: 'draft',
    color: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    version: 1,
    ...overrides,
  };
}

const OPEN_AIR = event('open-air', 'Open Air');
/** A different palette index from the Open Air's, because telling the two
 * apart at a glance is exactly what the strip and the chips are for. */
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

function post(id: string, eventId: string, name: string): locationsApi.Post {
  return {
    id,
    event_id: eventId,
    parent_id: `zone-${eventId}`,
    kind: 'post',
    name,
    sort_order: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    version: 1,
  };
}

function zone(
  eventId: string,
  name: string,
  posts: locationsApi.Post[],
): locationsApi.Zone {
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
    posts,
  };
}

function shift(
  id: string,
  eventId: string,
  locationId: string,
  start: string,
  end: string,
): shiftsApi.Shift {
  return {
    id,
    event_id: eventId,
    location_id: locationId,
    period: { start, end },
    required_count: 2,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    version: 1,
  };
}

/** Both days run a bar; only the Open Air has an entrance. */
const TREES: Readonly<Record<string, readonly locationsApi.Zone[]>> = {
  'open-air': [
    zone('open-air', 'Site', [
      post('oa-bar', 'open-air', 'Bar'),
      post('oa-door', 'open-air', 'Entrée'),
      post('oa-tech', 'open-air', 'Technique'),
    ]),
  ],
  dub: [zone('dub', 'Club', [post('dub-bar', 'dub', 'Bar')])],
};

const SHIFTS: Readonly<Record<string, readonly shiftsApi.Shift[]>> = {
  'open-air': [
    shift(
      's1',
      'open-air',
      'oa-bar',
      '2026-08-01T10:00:00Z',
      '2026-08-01T12:00:00Z',
    ),
    shift(
      's2',
      'open-air',
      'oa-door',
      '2026-08-01T10:00:00Z',
      '2026-08-01T12:00:00Z',
    ),
  ],
  dub: [
    shift(
      's3',
      'dub',
      'dub-bar',
      '2026-08-02T20:00:00Z',
      '2026-08-02T23:00:00Z',
    ),
  ],
};

function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/:orgId/festivals/:festivalId/shifts',
        name: 'org-festival-shifts',
        component: PlanShiftsView,
      },
      {
        path: '/:orgId/events/:eventId/shifts',
        name: 'org-event-shifts',
        component: PlanShiftsView,
      },
      // The board's hint links to the details section, where door times are
      // set. Named routes are resolved at render, so a router without these
      // fails every test in this file rather than the one about the hint.
      {
        path: '/:orgId/festivals/:festivalId/details',
        name: 'org-festival-details',
        component: { template: '<p>details</p>' },
      },
      {
        path: '/:orgId/events/:eventId/details',
        name: 'org-event-details',
        component: { template: '<p>details</p>' },
      },
    ],
  });
}

async function mountView(path: string) {
  const router = testRouter();
  await router.push(path);
  await router.isReady();

  const wrapper = mount(PlanShiftsView, {
    global: {
      plugins: [
        router,
        // A fresh store per mount: the slot length is deliberately sticky
        // across navigations (`stores/board.ts`), which between two tests
        // would be one test deciding another one's answer.
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

beforeEach(() => {
  vi.spyOn(sessionApi, 'fetchSession').mockResolvedValue(AUTHENTICATED_USER);
  vi.spyOn(festivals, 'fetchFestival').mockResolvedValue({
    ok: true,
    value: festivalDetail(),
  });
  // `Promise.resolve` rather than an `async` arrow with nothing to await:
  // these stubs answer from a table, and `require-await` is right that an
  // `async` with no `await` in it is a promise-shaped lie.
  vi.spyOn(events, 'fetchEvent').mockImplementation((_org, eventId) =>
    Promise.resolve({ ok: true, value: eventId === 'dub' ? DUB : OPEN_AIR }),
  );
  vi.spyOn(locations, 'fetchLocations').mockImplementation((_org, eventId) =>
    Promise.resolve({ ok: true, value: TREES[eventId] ?? [] }),
  );
  vi.spyOn(shifts, 'fetchShifts').mockImplementation((_org, eventId) =>
    Promise.resolve({ ok: true, value: SHIFTS[eventId] ?? [] }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PlanShiftsView — the board', () => {
  it('draws one row per mission', async () => {
    const wrapper = await mountView('/org-1/festivals/festival-1/shifts');

    const names = wrapper
      .findAll('.evp-mission-name')
      .map((node) => node.text());
    expect(names).toEqual(['Bar', 'Entrée', 'Technique']);
  });

  it('draws a bar per contiguous run, on the day it is worked', async () => {
    const wrapper = await mountView('/org-1/festivals/festival-1/shifts');

    // Bar runs on both days, so its row carries two separate bars.
    const bars = wrapper.findAll('[aria-label^="Start of Bar,"]');
    expect(bars.map((node) => node.attributes('aria-label'))).toEqual([
      // 12-hour, because this viewer's locale is `en`. The harness pins no
      // locale on purpose (`vitest.config.ts`), so the reading a test asserts
      // is the reading the session asked for.
      'Start of Bar, Open Air, 12:00 PM to 02:00 PM',
      'Start of Bar, Dub & 2step, 10:00 PM to 01:00 AM',
    ]);
  });

  /** The clock is the *event's*, never the browser's (docs/16 §1): 10:00Z is
   * 12:00 in Paris, and a board that said 10:00 would send somebody to a bar
   * two hours early. */
  it('announces each edge in the timezone its day is worked in', async () => {
    const wrapper = await mountView('/org-1/festivals/festival-1/shifts');

    const end = wrapper.find('[aria-label^="End of Bar, Open Air"]');
    expect(end.attributes('aria-valuetext')).toBe('02:00 PM');
  });

  it('marks the joins between adjacent shifts, and not the bar ends', async () => {
    vi.spyOn(shifts, 'fetchShifts').mockImplementation((_org, eventId) =>
      Promise.resolve({
        ok: true,
        value:
          eventId === 'open-air'
            ? [
                shift(
                  's1',
                  'open-air',
                  'oa-bar',
                  '2026-08-01T10:00:00Z',
                  '2026-08-01T12:00:00Z',
                ),
                shift(
                  's2',
                  'open-air',
                  'oa-bar',
                  '2026-08-01T12:00:00Z',
                  '2026-08-01T14:00:00Z',
                ),
                shift(
                  's3',
                  'open-air',
                  'oa-bar',
                  '2026-08-01T14:00:00Z',
                  '2026-08-01T16:00:00Z',
                ),
              ]
            : [],
      }),
    );

    const wrapper = await mountView('/org-1/events/open-air/shifts');

    // Three shifts in one run: two interior joins.
    expect(wrapper.findAll('.evp-cut-mark')).toHaveLength(2);
  });

  describe('a mission nobody has cut yet', () => {
    it('is drawn across its whole event, and says so in words', async () => {
      const wrapper = await mountView('/org-1/events/open-air/shifts');

      const proposed = wrapper.find('.evp-run--proposed');
      expect(proposed.exists()).toBe(true);
      // Never style alone (docs/14 §2): the dashes are backed by a label.
      expect(proposed.text()).toContain('not cut yet');
      expect(
        wrapper
          .find('[aria-label^="Start of Technique,"]')
          .attributes('aria-valuetext'),
      ).toBe('10:00 AM');
    });

    it('offers no removal, because there is nothing stored to remove', async () => {
      const wrapper = await mountView('/org-1/events/open-air/shifts');

      expect(wrapper.find('.evp-run--proposed .evp-remove').exists()).toBe(
        false,
      );
    });
  });
});

/**
 * The palette as the CSSOM hands it back.
 *
 * `background` is a colour property, so jsdom reparses the hex and serialises
 * it as `rgb(…)`; a custom property is not a colour to the CSSOM and comes
 * back verbatim, which is why only the strip's fill needs this and the chips'
 * `--evp-run-color` does not.
 */
function cssRgb(hex: string): string {
  const channel = (at: number): number =>
    Number.parseInt(hex.slice(at, at + 2), 16);
  return `rgb(${String(channel(1))}, ${String(channel(3))}, ${String(channel(5))})`;
}

describe('PlanShiftsView — the event strip', () => {
  it("draws one line per day, in that day's own palette colour", async () => {
    const wrapper = await mountView('/org-1/festivals/festival-1/shifts');

    const lines = wrapper.findAll('.evp-event-line');
    expect(lines.map((node) => node.text())).toEqual([
      'Open Air',
      'Dub & 2step',
    ]);
    // `eventColor`, not a literal: the palette's order is schema (the column
    // stores the index), and a test that hard-coded the hex would be a second
    // copy of it to drift from.
    expect(lines[0]?.attributes('style')).toContain(cssRgb(eventColor(0)));
    expect(lines[1]?.attributes('style')).toContain(cssRgb(eventColor(5)));
  });

  /** Consecutive days share a row — a plain festival must not read as several
   * parallel productions. */
  it('keeps a festival of consecutive days on one line', async () => {
    const wrapper = await mountView('/org-1/festivals/festival-1/shifts');

    const tops = wrapper
      .findAll('.evp-event-line')
      .map((node) => node.attributes('style'));
    expect(tops[0]).toContain('top: 3.5rem');
    expect(tops[1]).toContain('top: 3.5rem');
  });

  it('stacks two events that genuinely run at once', async () => {
    const afterparty = event('after', 'Afterparty', {
      // Overlaps the Open Air's last four hours.
      period: { start: '2026-08-01T14:00:00Z', end: '2026-08-01T22:00:00Z' },
      color: 9,
    });
    vi.spyOn(festivals, 'fetchFestival').mockResolvedValue({
      ok: true,
      value: { ...festivalDetail(), events: [OPEN_AIR, afterparty] },
    });

    const wrapper = await mountView('/org-1/festivals/festival-1/shifts');

    const lines = wrapper.findAll('.evp-event-line');
    expect(lines[0]?.attributes('style')).toContain('top: 3.5rem');
    expect(lines[1]?.attributes('style')).toContain('top: 4.5rem');
    // The ruler's three rows plus the two the strip needs.
    expect(wrapper.find('.evp-axis-track').attributes('style')).toContain(
      'height: 5.5rem',
    );
  });

  /**
   * The pairing is the feature: the axis is one continuous line, so the only
   * thing that says *whose* work a chip is, is that it is the colour of a line
   * on the strip. A club night's 01:00 bar shift sits under a date band naming
   * the next calendar day.
   */
  it('draws each chip in the colour of the day it is worked on', async () => {
    const wrapper = await mountView('/org-1/festivals/festival-1/shifts');

    const chips = wrapper
      .findAll('.evp-run:not(.evp-run--proposed)')
      .map((node) => node.attributes('style'));
    // Bar on the Open Air, Bar on the club night, Entrée on the Open Air.
    expect(chips[0]).toContain(`--evp-run-color: ${eventColor(0)}`);
    expect(chips[1]).toContain(`--evp-run-color: ${eventColor(5)}`);
    expect(chips[2]).toContain(`--evp-run-color: ${eventColor(0)}`);
  });

  /** A mission nobody has cut yet carries its day's colour too — the
   * stylesheet spends it on a dashed outline rather than a fill, which is the
   * part that says nothing is stored for it yet. */
  it('colours an uncut proposal as well', async () => {
    // Technique is declared on the Open Air and has no shifts against it.
    const wrapper = await mountView('/org-1/events/open-air/shifts');

    const proposed = wrapper.find('.evp-run--proposed');
    expect(proposed.attributes('style')).toContain(
      `--evp-run-color: ${eventColor(0)}`,
    );
  });
});

describe('PlanShiftsView — geometry', () => {
  /**
   * The axis reaches two hours past the first and last day so that a bar can
   * be dragged out of its day and take the day with it. At 40 px/hour that
   * margin is 80 px, and it is where the axis — and therefore every `left`
   * below — begins.
   */
  const MARGIN_PX = 80;

  /**
   * The board positions bars on a continuous time scale (docs/02 §7), so the
   * only thing that makes it readable is that pixels are proportional to
   * hours. At the default 40 px/hour, a two-hour slot is 80 px and a bar
   * starting two hours into the day begins 80 px past the day's own start.
   */
  it('positions a bar in proportion to when it runs', async () => {
    const wrapper = await mountView('/org-1/events/open-air/shifts');

    // The day opens at 08:00Z and the bar runs 10:00Z–12:00Z.
    const bar = wrapper.find('.evp-run:not(.evp-run--proposed)');
    expect(bar.attributes('style')).toContain(
      `left: ${String(MARGIN_PX + 80)}px`,
    );
    expect(bar.attributes('style')).toContain('width: 80px');
  });

  /** A cut mark is an offset *inside* its bar, which is a difference of two
   * positions and not the position of a difference — getting that wrong puts
   * every tick somewhere in 1970. */
  it('places cut marks at their offset within the bar', async () => {
    vi.spyOn(shifts, 'fetchShifts').mockImplementation((_org, eventId) =>
      Promise.resolve({
        ok: true,
        value:
          eventId === 'open-air'
            ? [
                shift(
                  's1',
                  'open-air',
                  'oa-bar',
                  '2026-08-01T10:00:00Z',
                  '2026-08-01T12:00:00Z',
                ),
                shift(
                  's2',
                  'open-air',
                  'oa-bar',
                  '2026-08-01T12:00:00Z',
                  '2026-08-01T14:00:00Z',
                ),
                shift(
                  's3',
                  'open-air',
                  'oa-bar',
                  '2026-08-01T14:00:00Z',
                  '2026-08-01T16:00:00Z',
                ),
              ]
            : [],
      }),
    );

    const wrapper = await mountView('/org-1/events/open-air/shifts');

    const offsets = wrapper
      .findAll('.evp-cut-mark')
      .map((node) => node.attributes('style'));
    expect(offsets).toEqual(['left: 80px;', 'left: 160px;']);
  });

  it('lays a proposal across the whole width of its event', async () => {
    const wrapper = await mountView('/org-1/events/open-air/shifts');

    // 08:00Z–18:00Z at 40 px/hour, laid on an axis that starts two hours
    // earlier — the proposal covers its day, not the whole board.
    const proposed = wrapper.find('.evp-run--proposed');
    expect(proposed.attributes('style')).toContain(
      `left: ${String(MARGIN_PX)}px`,
    );
    expect(proposed.attributes('style')).toContain('width: 400px');
  });

  /**
   * The margin is the whole reason the outward drag is reachable: every bar is
   * born spanning its day, so without room past the day's edge there is no
   * pixel to pull it to.
   */
  it('draws blank axis past the first and last day', async () => {
    const wrapper = await mountView('/org-1/events/open-air/shifts');

    const outside = wrapper
      .findAll('.evp-lane-outside')
      .map((node) => node.attributes('style'));

    expect(outside.slice(0, 2)).toEqual([
      `left: 0px; width: ${String(MARGIN_PX)}px;`,
      `left: ${String(MARGIN_PX + 400)}px; width: ${String(MARGIN_PX)}px;`,
    ]);
  });
});

describe('PlanShiftsView — editing without a pointer', () => {
  /**
   * WCAG 2.2 AA 2.5.7 and a CI gate (ADR-0017): every drag has a non-drag
   * equivalent. These are that equivalent, so they are specified rather than
   * left to the exploratory budget docs/13 §2 grants the drag itself.
   */
  function edge(wrapper: Awaited<ReturnType<typeof mountView>>, label: string) {
    return wrapper.find(`[aria-label^="${label}"]`);
  }

  it('lengthens a bar by one step, tiling the new stretch', async () => {
    const create = vi
      .spyOn(shifts, 'createShift')
      .mockResolvedValue({ ok: false, rejection: { reason: 'unavailable' } });

    const wrapper = await mountView('/org-1/events/open-air/shifts');
    await edge(wrapper, 'End of Bar, Open Air').trigger('keydown', {
      key: 'ArrowRight',
    });
    await flushPromises();

    expect(create).toHaveBeenCalledWith('org-1', 'open-air', {
      locationId: 'oa-bar',
      period: {
        start: '2026-08-01T12:00:00Z',
        end: '2026-08-01T12:15:00Z',
      },
      // Inherited from the slot it grew out of, not reset to one.
      requiredCount: 2,
    });
  });

  it('lengthens by a whole slot when Shift is held', async () => {
    const create = vi
      .spyOn(shifts, 'createShift')
      .mockResolvedValue({ ok: false, rejection: { reason: 'unavailable' } });

    const wrapper = await mountView('/org-1/events/open-air/shifts');
    await edge(wrapper, 'End of Bar, Open Air').trigger('keydown', {
      key: 'ArrowRight',
      shiftKey: true,
    });
    await flushPromises();

    expect(create.mock.calls[0]?.[2].period).toEqual({
      start: '2026-08-01T12:00:00Z',
      end: '2026-08-01T14:00:00Z',
    });
  });

  it('shortens a bar by truncating the slot the edge lands in', async () => {
    const patch = vi
      .spyOn(shifts, 'patchShiftPeriod')
      .mockResolvedValue({ ok: false, rejection: { reason: 'unavailable' } });

    const wrapper = await mountView('/org-1/events/open-air/shifts');
    await edge(wrapper, 'End of Bar, Open Air').trigger('keydown', {
      key: 'ArrowLeft',
    });
    await flushPromises();

    expect(patch).toHaveBeenCalledWith('org-1', 'open-air', 's1', 1, {
      start: '2026-08-01T10:00:00Z',
      end: '2026-08-01T11:45:00Z',
    });
  });

  it('runs an edge to the end of its own day on End', async () => {
    const create = vi
      .spyOn(shifts, 'createShift')
      .mockResolvedValue({ ok: false, rejection: { reason: 'unavailable' } });

    const wrapper = await mountView('/org-1/events/open-air/shifts');
    await edge(wrapper, 'End of Bar, Open Air').trigger('keydown', {
      key: 'End',
    });
    await flushPromises();

    // The event closes at 18:00Z; the first new slot starts where the bar did.
    expect(create.mock.calls[0]?.[2].period.start).toBe('2026-08-01T12:00:00Z');
  });

  /** The hard rule `shift_outside_event` is enforced by a constraint trigger.
   * Feeling the edge of the day beats collecting a 422 from it. */
  it('never asks for a slot outside its own day', async () => {
    const create = vi
      .spyOn(shifts, 'createShift')
      .mockResolvedValue({ ok: false, rejection: { reason: 'unavailable' } });

    const wrapper = await mountView('/org-1/events/open-air/shifts');
    await edge(wrapper, 'End of Bar, Open Air').trigger('keydown', {
      key: 'End',
    });
    await flushPromises();

    const ends = create.mock.calls.map((call) => call[2].period.end);
    expect(ends.every((end) => end <= '2026-08-01T18:00:00Z')).toBe(true);
  });
});

describe('PlanShiftsView — cutting', () => {
  it('writes a proposal into slots at the mission length', async () => {
    const create = vi
      .spyOn(shifts, 'createShift')
      .mockResolvedValue({ ok: false, rejection: { reason: 'unavailable' } });

    const wrapper = await mountView('/org-1/events/open-air/shifts');
    // One Cut per bar, and one bar per row here: Bar, Entrée, Technique, of
    // which Technique is the uncut one.
    const buttons = wrapper.findAll('.evp-cut-button');
    await buttons[2]?.trigger('click');
    await flushPromises();

    expect(create.mock.calls[0]?.[2]).toMatchObject({
      locationId: 'oa-tech',
      period: {
        start: '2026-08-01T08:00:00Z',
        end: '2026-08-01T10:00:00Z',
      },
    });
  });
});

describe('PlanShiftsView — when a write does not land', () => {
  it('explains the refusal inline rather than in a toast', async () => {
    vi.spyOn(shifts, 'createShift').mockResolvedValue({
      ok: false,
      rejection: {
        reason: 'validation-failed',
        detail: 'A shift cannot be longer than 24 hours.',
      },
    });

    const wrapper = await mountView('/org-1/events/open-air/shifts');
    await wrapper
      .find('[aria-label^="End of Bar, Open Air"]')
      .trigger('keydown', { key: 'ArrowRight' });
    await flushPromises();

    const alert = wrapper.find('[role="alert"]');
    expect(alert.text()).toContain('A shift cannot be longer than 24 hours.');
  });

  it('says how much of a half-applied plan did land', async () => {
    vi.spyOn(shifts, 'createShift')
      .mockResolvedValueOnce({
        ok: true,
        shift: shift(
          'new',
          'open-air',
          'oa-tech',
          '2026-08-01T08:00:00Z',
          '2026-08-01T10:00:00Z',
        ),
        operationId: 'op-1',
      })
      .mockResolvedValue({
        ok: false,
        rejection: { reason: 'conflict', detail: 'now at version 9' },
      });

    const wrapper = await mountView('/org-1/events/open-air/shifts');
    const buttons = wrapper.findAll('.evp-cut-button');
    await buttons[2]?.trigger('click');
    await flushPromises();

    expect(wrapper.find('[role="alert"]').text()).toContain(
      '1 of the changes were already saved',
    );
  });

  it('keeps showing the days that did load when one fails', async () => {
    vi.spyOn(locations, 'fetchLocations').mockImplementation((_org, eventId) =>
      Promise.resolve(
        eventId === 'dub'
          ? { ok: false, failure: { reason: 'unavailable' } }
          : { ok: true, value: TREES[eventId] ?? [] },
      ),
    );

    const wrapper = await mountView('/org-1/festivals/festival-1/shifts');

    expect(wrapper.text()).toContain('could not be loaded');
    expect(wrapper.findAll('.evp-mission-name').length).toBeGreaterThan(0);
  });
});

describe('PlanShiftsView — scope', () => {
  it('lays only the day in view on the axis, at day scope', async () => {
    const wrapper = await mountView('/org-1/events/open-air/shifts');

    const bars = wrapper.findAll('[aria-label^="Start of Bar,"]');
    expect(bars).toHaveLength(1);
    expect(bars[0]?.attributes('aria-label')).toContain('Open Air');
  });

  it('lays every day of the festival on one axis, at festival scope', async () => {
    const wrapper = await mountView('/org-1/festivals/festival-1/shifts');

    expect(wrapper.findAll('[aria-label^="Start of Bar,"]')).toHaveLength(2);
  });
});

describe('PlanShiftsView — while an edit is still landing', () => {
  /**
   * The bug these guard: the dragged geometry was released at `pointerup`,
   * which put the bar back at its stored length for the whole round trip —
   * and one drag is several sequential writes plus a re-read
   * (`api/useShiftWrites.ts`). A bar that springs back on release reads as an
   * edit the board threw away, so the coordinator drags again, against shifts
   * the first plan has already changed.
   *
   * Specified rather than felt, unlike the drag geometry docs/13 §2 exempts:
   * what is asserted here is *when the board stops showing an answer it does
   * not have yet*, which is a correctness question about writes.
   */
  const END_OF_BAR = '[aria-label^="End of Bar, Open Air"]';

  const msOf = (iso: string): number =>
    Temporal.Instant.from(iso).epochMilliseconds;

  /**
   * jsdom implements no pointer capture, so the handle is given one. It is a
   * stub rather than an omission: without capture a real board would lose
   * every pointer that left the 24 px handle, which is every drag worth
   * making, so a test that skipped it would be testing a board nobody uses.
   */
  function grab(wrapper: Awaited<ReturnType<typeof mountView>>): HTMLElement {
    const element = wrapper.find(END_OF_BAR).element;
    if (!(element instanceof HTMLElement)) {
      throw new TypeError('expected the end handle to be an element');
    }
    Object.assign(element, {
      setPointerCapture: () => undefined,
      releasePointerCapture: () => undefined,
    });
    return element;
  }

  /**
   * `@vue/test-utils` cannot set `button` on the event it synthesises, and the
   * board answers the primary button only.
   *
   * The lane sits at x=0 in jsdom and the board draws 40 px to the hour. The
   * axis opens two hours before the day does — the margin a bar is lengthened
   * into — so on a day starting at 08:00 the origin is 06:00, which puts the
   * bar's 12:00 end at 240 px and 14:00 at 320 px.
   */
  function pointer(handle: HTMLElement, type: string, clientX: number): void {
    handle.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX }),
    );
  }

  /** A write that has been sent and not yet answered. */
  function pendingWrite() {
    let settle = (): void => undefined;
    const sent = new Promise<shiftsApi.ShiftWriteResult>((resolve) => {
      settle = () => {
        resolve({ ok: false, rejection: { reason: 'unavailable' } });
      };
    });
    return { sent, settle };
  }

  it('holds a dragged edge where it was dropped until the writes land', async () => {
    const { sent, settle } = pendingWrite();
    vi.spyOn(shifts, 'createShift').mockReturnValue(sent);

    const wrapper = await mountView('/org-1/events/open-air/shifts');
    const handle = grab(wrapper);

    pointer(handle, 'pointerdown', 240);
    pointer(handle, 'pointermove', 320);
    pointer(handle, 'pointerup', 320);
    await flushPromises();

    expect(wrapper.find(END_OF_BAR).attributes('aria-valuenow')).toBe(
      String(msOf('2026-08-01T14:00:00Z')),
    );
    // Held, and saying so: a length nothing has confirmed must not be drawn
    // as though it were stored.
    expect(wrapper.text()).toContain('saving');

    settle();
    await flushPromises();
  });

  it('gives the edge back to the stored shifts once they answer', async () => {
    vi.spyOn(shifts, 'createShift').mockResolvedValue({
      ok: false,
      rejection: { reason: 'unavailable' },
    });

    const wrapper = await mountView('/org-1/events/open-air/shifts');
    const handle = grab(wrapper);

    pointer(handle, 'pointerdown', 240);
    pointer(handle, 'pointermove', 320);
    pointer(handle, 'pointerup', 320);
    await flushPromises();

    expect(wrapper.find(END_OF_BAR).attributes('aria-valuenow')).toBe(
      String(msOf('2026-08-01T12:00:00Z')),
    );
    expect(wrapper.text()).not.toContain('saving');
  });

  it('holds an edge moved by keyboard for the same reason', async () => {
    const { sent, settle } = pendingWrite();
    vi.spyOn(shifts, 'createShift').mockReturnValue(sent);

    const wrapper = await mountView('/org-1/events/open-air/shifts');
    await wrapper.find(END_OF_BAR).trigger('keydown', { key: 'ArrowRight' });
    await flushPromises();

    expect(wrapper.find(END_OF_BAR).attributes('aria-valuenow')).toBe(
      String(msOf('2026-08-01T12:15:00Z')),
    );

    settle();
    await flushPromises();
  });
});

/**
 * A festival is mostly not happening, and the axis says so by not drawing it.
 *
 * The fixture is the shape the feature exists for: the Open Air closes at
 * 18:00Z on the 1st and the club night opens at 18:00Z on the 2nd, a full day
 * apart. At the default 40 px/hour that day is 960 px of blank track between
 * the two rotas a coordinator opened this page to compare.
 */
describe('PlanShiftsView — elided hours', () => {
  /** 40 px/hour, and the axis starts two hours before the first day. */
  const PX_PER_HOUR = 40;
  const FOLD_PX = 40;

  it('elides the day between two nights and says how long it was', async () => {
    const wrapper = await mountView('/org-1/festivals/festival-1/shifts');

    const folds = wrapper.findAll('.evp-fold');
    expect(folds).toHaveLength(1);
    // 08-01 18:00Z + 2 h to 08-02 18:00Z − 2 h.
    expect(folds[0]?.text()).toContain('20 h');
    // The axis opens at 06:00Z on the 1st, so the fold begins 14 hours in.
    expect(folds[0]?.attributes('style')).toContain(
      `left: ${String(14 * PX_PER_HOUR)}px`,
    );
    expect(folds[0]?.attributes('style')).toContain(
      `width: ${String(FOLD_PX)}px`,
    );
  });

  /**
   * The point of the elision, and the only assertion that proves it happened
   * rather than merely being drawn: the club night's bar sits where the folded
   * axis puts it, 760 px in, and not the 1520 px a continuous one would.
   */
  it('pulls the far side of the fold back onto the screen', async () => {
    const wrapper = await mountView('/org-1/festivals/festival-1/shifts');

    const bars = wrapper.findAll('.evp-run:not(.evp-run--proposed)');
    // 14 h of visible axis, one marker, then 4 h of the club night's margin
    // and doors before its 20:00Z shift.
    expect(bars[1]?.attributes('style')).toContain(
      `left: ${String(14 * PX_PER_HOUR + FOLD_PX + 4 * PX_PER_HOUR)}px`,
    );
  });

  /** The ruler must not carry a night's worth of clock readings stacked into
   * forty pixels. Its two edges survive, which is what makes the marker
   * readable as a jump from one time to another. */
  it('drops the clock labels that would land inside the fold', async () => {
    const wrapper = await mountView('/org-1/festivals/festival-1/shifts');

    const positions = wrapper
      .findAll('.evp-tick')
      .map((node) =>
        Number(
          /left: (-?[\d.]+)px/.exec(node.attributes('style') ?? '')?.[1] ??
            Number.NaN,
        ),
      );

    expect(positions.length).toBeGreaterThan(0);
    expect(
      positions.filter(
        (left) => left > 14 * PX_PER_HOUR && left < 14 * PX_PER_HOUR + FOLD_PX,
      ),
    ).toEqual([]);
  });

  /**
   * Elision that could not be undone would be the board deciding what is worth
   * looking at — and it would be wrong the moment somebody staffs a load-out at
   * 04:00 on a night nothing else runs.
   */
  it('opens a folded stretch again when its marker is pressed', async () => {
    const wrapper = await mountView('/org-1/festivals/festival-1/shifts');

    await wrapper.find('.evp-fold').trigger('click');

    expect(wrapper.findAll('.evp-fold:not(.evp-fold--open)')).toHaveLength(0);
    // And the way back is on screen, rather than something to be remembered.
    expect(wrapper.findAll('.evp-fold--open')).toHaveLength(1);
    // The axis is continuous again: the club night's bar is back where an
    // unfolded scale puts it.
    const bars = wrapper.findAll('.evp-run:not(.evp-run--proposed)');
    expect(bars[1]?.attributes('style')).toContain(
      `left: ${String(38 * PX_PER_HOUR)}px`,
    );
  });

  it('folds the stretch back when the marker is pressed again', async () => {
    const wrapper = await mountView('/org-1/festivals/festival-1/shifts');

    await wrapper.find('.evp-fold').trigger('click');
    await wrapper.find('.evp-fold--open').trigger('click');

    expect(wrapper.findAll('.evp-fold--open')).toHaveLength(0);
    expect(wrapper.findAll('.evp-fold')).toHaveLength(1);
  });

  /** One day is one continuous stretch of work. The two hours at each end are
   * the room an edge is dragged into, not empty axis to be reclaimed. */
  it('elides nothing on a single day', async () => {
    const wrapper = await mountView('/org-1/events/open-air/shifts');

    expect(wrapper.findAll('.evp-fold')).toHaveLength(0);
    expect(wrapper.findAll('.evp-lane-fold')).toHaveLength(0);
  });

  /** The break has to read down the board as well as across it, or two chips
   * either side of it look like one continuous afternoon. */
  it('marks the break on every row, not only on the ruler', async () => {
    const wrapper = await mountView('/org-1/festivals/festival-1/shifts');

    const rows = wrapper.findAll('.evp-row');
    expect(rows.length).toBeGreaterThan(0);
    expect(wrapper.findAll('.evp-lane-fold')).toHaveLength(rows.length);
  });
});

/**
 * Every control on a bar acts on that bar alone.
 *
 * A mission row is several days laid on one line (`runs.ts`), so this is not a
 * refinement: the Cut button used to sit in the gutter and re-cut every day of
 * the festival at once, which meant a coordinator who wanted Saturday's bar in
 * 90-minute slots silently re-cut Friday, Sunday and the after as well — and
 * had no way at all to say "Saturday only".
 */
describe('PlanShiftsView — one bar at a time', () => {
  function control(
    wrapper: Awaited<ReturnType<typeof mountView>>,
    label: string,
  ) {
    return wrapper.find(`[aria-label^="${label}"]`);
  }

  it('cuts the day whose bar was pressed, and no other', async () => {
    const create = vi
      .spyOn(shifts, 'createShift')
      .mockResolvedValue({ ok: false, rejection: { reason: 'unavailable' } });
    const patch = vi.spyOn(shifts, 'patchShiftPeriod').mockResolvedValue({
      ok: true,
      shift: shift(
        's3',
        'dub',
        'dub-bar',
        '2026-08-02T20:00:00Z',
        '2026-08-02T22:00:00Z',
      ),
      operationId: 'op-1',
    });

    // The festival-wide board: "Bar" is one row carrying both days.
    const wrapper = await mountView('/org-1/festivals/festival-1/shifts');
    await control(wrapper, 'Cut Bar, Dub & 2step').trigger('click');
    await flushPromises();

    // The club night's bar is one 3-hour shift; at 120 minutes it becomes a
    // 2-hour slot and a 1-hour remainder.
    expect(patch.mock.calls.map((call) => call[1])).toEqual(['dub']);
    expect(create.mock.calls.map((call) => call[1])).toEqual(['dub']);
    expect(create.mock.calls[0]?.[2].period).toEqual({
      start: '2026-08-02T22:00:00Z',
      end: '2026-08-02T23:00:00Z',
    });
  });

  it('offers a cut on every bar of a row, not one for the row', async () => {
    const wrapper = await mountView('/org-1/festivals/festival-1/shifts');

    // Bar on both days, Entrée and Technique on the Open Air alone.
    expect(
      wrapper
        .findAll('.evp-cut-button')
        .map((node) => node.attributes('aria-label')),
    ).toEqual([
      'Cut Bar, Open Air, 12:00 PM to 02:00 PM into 120 minute slots',
      'Cut Bar, Dub & 2step, 10:00 PM to 01:00 AM into 120 minute slots',
      'Cut Entrée, Open Air, 12:00 PM to 02:00 PM into 120 minute slots',
      'Cut Technique, Open Air, 10:00 AM to 08:00 PM into 120 minute slots',
    ]);
    expect(wrapper.find('.evp-gutter .evp-cut-button').exists()).toBe(false);
  });
});

/**
 * Two series at one post in one day — the shape a real bar has when it opens
 * for the apéro, closes for the concert and opens again after it.
 *
 * The pointer gesture is a double click and is exempt from test-first
 * (docs/13 §2); the button beside it is the keyboard path WCAG 2.2 AA 2.5.7
 * requires, and that is what is specified here.
 */
describe('PlanShiftsView — splitting a series', () => {
  it('divides a bar in two, taking one step out of it', async () => {
    const create = vi
      .spyOn(shifts, 'createShift')
      .mockResolvedValue({ ok: false, rejection: { reason: 'unavailable' } });
    const patch = vi.spyOn(shifts, 'patchShiftPeriod').mockResolvedValue({
      ok: true,
      shift: shift(
        's1',
        'open-air',
        'oa-bar',
        '2026-08-01T10:00:00Z',
        '2026-08-01T11:00:00Z',
      ),
      operationId: 'op-1',
    });

    const wrapper = await mountView('/org-1/events/open-air/shifts');
    await wrapper.find('[aria-label^="Split Bar, Open Air"]').trigger('click');
    await flushPromises();

    // One 10:00–12:00Z shift, split at its middle: it ends at 11:00 and a new
    // one picks up a quarter of an hour later.
    expect(patch).toHaveBeenCalledWith('org-1', 'open-air', 's1', 1, {
      start: '2026-08-01T10:00:00Z',
      end: '2026-08-01T11:00:00Z',
    });
    expect(create.mock.calls[0]?.[2].period).toEqual({
      start: '2026-08-01T11:15:00Z',
      end: '2026-08-01T12:00:00Z',
    });
  });

  /** A proposal has no rows to divide: the whole bar is a drawing of the
   * event, and two drawings of one event would be the second record of it
   * ADR-0029 refused. */
  it('offers no split on a mission nobody has cut yet', async () => {
    const wrapper = await mountView('/org-1/events/open-air/shifts');

    expect(wrapper.find('.evp-run--proposed .evp-split-button').exists()).toBe(
      false,
    );
    expect(wrapper.find('.evp-run--proposed .evp-cut-button').exists()).toBe(
      true,
    );
  });
});

/**
 * The joins inside a bar, which is where one shift hands over to the next —
 * the single most-edited fact on a real plan, and until now the one thing on
 * this board that could only be changed by re-cutting the whole bar.
 */
describe('PlanShiftsView — moving a break', () => {
  function threeSlotDay(): void {
    vi.spyOn(shifts, 'fetchShifts').mockImplementation((_org, eventId) =>
      Promise.resolve({
        ok: true,
        value:
          eventId === 'open-air'
            ? [
                shift(
                  's1',
                  'open-air',
                  'oa-bar',
                  '2026-08-01T10:00:00Z',
                  '2026-08-01T12:00:00Z',
                ),
                shift(
                  's2',
                  'open-air',
                  'oa-bar',
                  '2026-08-01T12:00:00Z',
                  '2026-08-01T14:00:00Z',
                ),
              ]
            : [],
      }),
    );
  }

  it('announces itself as a slider on the instant it sits at', async () => {
    threeSlotDay();
    const wrapper = await mountView('/org-1/events/open-air/shifts');

    const bre4k = wrapper.find('[aria-label^="Break 1 of Bar, Open Air"]');
    expect(bre4k.attributes('role')).toBe('slider');
    // Its travel is the two shifts it divides, and nothing beyond them.
    expect(bre4k.attributes('aria-valuetext')).toBe('02:00 PM');
    expect(bre4k.attributes('aria-valuemin')).toBe(
      String(Temporal.Instant.from('2026-08-01T10:00:00Z').epochMilliseconds),
    );
    expect(bre4k.attributes('aria-valuemax')).toBe(
      String(Temporal.Instant.from('2026-08-01T14:00:00Z').epochMilliseconds),
    );
  });

  it('patches both shifts when the break is nudged', async () => {
    threeSlotDay();
    // Landing, rather than refused: a plan stops at its first rejection
    // (`useShiftWrites.ts`), and moving a break is two patches — the whole
    // point of the assertion is that the second one is the other shift.
    const patch = vi.spyOn(shifts, 'patchShiftPeriod').mockResolvedValue({
      ok: true,
      shift: shift(
        's1',
        'open-air',
        'oa-bar',
        '2026-08-01T10:00:00Z',
        '2026-08-01T12:15:00Z',
      ),
      operationId: 'op-1',
    });

    const wrapper = await mountView('/org-1/events/open-air/shifts');
    await wrapper
      .find('[aria-label^="Break 1 of Bar, Open Air"]')
      .trigger('keydown', { key: 'ArrowRight' });
    await flushPromises();

    expect(patch.mock.calls.map((call) => [call[2], call[4]])).toEqual([
      ['s1', { start: '2026-08-01T10:00:00Z', end: '2026-08-01T12:15:00Z' }],
      ['s2', { start: '2026-08-01T12:15:00Z', end: '2026-08-01T14:00:00Z' }],
    ]);
  });

  /** Two breaks that meet leave a shift with no minutes in it, which
   * `shifts_period_sane` refuses — so the row goes, and the board says so
   * rather than appearing to have lost a shift. */
  it('merges the two shifts when a break is pushed onto its neighbour', async () => {
    threeSlotDay();
    const remove = vi
      .spyOn(shifts, 'deleteShift')
      .mockResolvedValue({ ok: false, rejection: { reason: 'unavailable' } });

    const wrapper = await mountView('/org-1/events/open-air/shifts');
    await wrapper
      .find('[aria-label^="Break 1 of Bar, Open Air"]')
      .trigger('keydown', { key: 'End' });
    await flushPromises();

    expect(remove).toHaveBeenCalledWith('org-1', 'open-air', 's2', 1);
    expect(wrapper.find('[role="status"]').text()).toContain('Two breaks met');
  });
});

/**
 * Two days of one festival may genuinely run at once — a club night and the
 * after that laps it — and both may staff the same post. Drawn on one line,
 * one bar hides the other, which on a board whose whole job is showing where
 * the hole is, is the worst thing it can do.
 */
describe('PlanShiftsView — overlapping days on one mission row', () => {
  const AFTER = event('after', 'Afterparty', {
    period: { start: '2026-08-01T11:00:00Z', end: '2026-08-01T22:00:00Z' },
    color: 9,
  });

  beforeEach(() => {
    vi.spyOn(festivals, 'fetchFestival').mockResolvedValue({
      ok: true,
      value: { ...festivalDetail(), events: [OPEN_AIR, AFTER] },
    });
    vi.spyOn(locations, 'fetchLocations').mockImplementation((_org, eventId) =>
      Promise.resolve({
        ok: true,
        value:
          eventId === 'after'
            ? [zone('after', 'Club', [post('after-bar', 'after', 'Bar')])]
            : (TREES[eventId] ?? []),
      }),
    );
    vi.spyOn(shifts, 'fetchShifts').mockImplementation((_org, eventId) =>
      Promise.resolve({
        ok: true,
        value:
          eventId === 'after'
            ? [
                shift(
                  's9',
                  'after',
                  'after-bar',
                  '2026-08-01T11:00:00Z',
                  '2026-08-01T13:00:00Z',
                ),
              ]
            : (SHIFTS[eventId] ?? []),
      }),
    );
  });

  it('gives each of two overlapping bars its own sub-row', async () => {
    const wrapper = await mountView('/org-1/festivals/festival-1/shifts');

    const tops = wrapper
      .findAll('.evp-run')
      .filter((node) =>
        (node.attributes('aria-label') ?? '').startsWith('Bar, '),
      )
      .map((node) => node.attributes('style'));

    expect(tops).toHaveLength(2);
    expect(tops[0]).toContain('top: 0.75rem');
    expect(tops[1]).toContain('top: 3.75rem');
  });

  it('makes the row as deep as the bars it has to hold', async () => {
    const wrapper = await mountView('/org-1/festivals/festival-1/shifts');

    const lanes = wrapper.findAll('.evp-lane');
    // Bar carries both days; Entrée carries one.
    expect(lanes[0]?.attributes('style')).toContain('height: 6rem');
    expect(lanes[1]?.attributes('style')).toContain('height: 3rem');
  });
});

// French puts 0 in the singular, which a hand-rolled `n > 1 ? 's' : ''` gets
// right only by accident (docs/16 §6).
describe('PlanShiftsView — counts in French', () => {
  beforeAll(async () => {
    await setLocale('fr');
  });
  afterAll(async () => {
    await setLocale('en');
  });

  it('pluralises the slots a removal would take', () => {
    expect(
      [0, 1, 2].map((count) =>
        t('shifts.run.removeConfirmLabel', { count, bar: 'Bar' }),
      ),
    ).toEqual([
      'Confirmer la suppression de 0 créneau de Bar',
      'Confirmer la suppression de 1 créneau de Bar',
      'Confirmer la suppression de 2 créneaux de Bar',
    ]);
  });
});
