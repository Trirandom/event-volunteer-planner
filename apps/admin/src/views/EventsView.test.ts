// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { flushPromises, mount } from '@vue/test-utils';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Temporal } from '@evp/shared/time';

import * as eventsApi from '../api/events';
import * as festivalsApi from '../api/festivals';
import * as sessionApi from '../api/session';
import * as clock from '../time/clock';
import EventsView from './EventsView.vue';

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

/** Fixed: docs/13 §8 — no test reads the wall clock, including through the
 * view. `nowInstant` exists precisely so this is one stub rather than a
 * fake-timer dance around `Temporal.Now`. */
const NOW = '2026-06-15T12:00:00Z';

function event(
  id: string,
  name: string,
  start: string,
  end: string,
  festivalId: string | null = null,
): eventsApi.Event {
  return {
    id,
    festival_id: festivalId,
    name,
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

function festival(
  id: string,
  name: string,
  start: string,
  end: string,
): festivalsApi.Festival {
  return {
    id,
    name,
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

/** Mirrors the real router's `/:orgId/...` shape (router/index.ts) rather than
 * hard-coding `org-1` into the path: a `RouterLink` built with an `orgId` param
 * that the matched route never declared is silently dropped by vue-router,
 * which is exactly the bug a router that does not match production would
 * hide. */
function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/:orgId/events', name: 'org-events', component: EventsView },
      {
        path: '/:orgId/festivals/:festivalId',
        name: 'org-festival-detail',
        component: { template: '<div />' },
      },
      {
        path: '/:orgId/events/:eventId',
        name: 'org-event-detail',
        component: { template: '<div />' },
      },
    ],
  });
}

async function mountView() {
  const router = testRouter();
  await router.push('/org-1/events');
  await router.isReady();

  const wrapper = mount(EventsView, {
    global: {
      plugins: [
        router,
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

/** The names in the order they appear on the page — festival headings and
 * event rows alike, which is the whole claim this view makes. */
function orderOnPage(wrapper: {
  findAll: (s: string) => { text: () => string }[];
}) {
  return wrapper
    .findAll('.evp-group-title, .evp-row-name')
    .map((w) => w.text());
}

beforeEach(() => {
  vi.spyOn(clock, 'nowInstant').mockReturnValue(Temporal.Instant.from(NOW));
  vi.spyOn(sessionApi, 'fetchSession').mockResolvedValue(AUTHENTICATED_USER);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EventsView', () => {
  it('offers both create forms above the list, before anything exists', async () => {
    vi.spyOn(eventsApi, 'fetchEvents').mockResolvedValue({
      ok: true,
      value: [],
    });
    vi.spyOn(festivalsApi, 'fetchFestivals').mockResolvedValue({
      ok: true,
      value: [],
    });

    const wrapper = await mountView();

    expect(wrapper.text()).toContain('Nothing planned yet');
    const labels = wrapper.findAll('button').map((button) => button.text());
    expect(labels).toContain('New event');
    expect(labels).toContain('New festival');
    expect(wrapper.text()).toContain('Load the example festival');
    expect(wrapper.text()).toContain('Load the example event');
  });

  it('opens the event form on demand, without a festival picker', async () => {
    vi.spyOn(eventsApi, 'fetchEvents').mockResolvedValue({
      ok: true,
      value: [],
    });
    vi.spyOn(festivalsApi, 'fetchFestivals').mockResolvedValue({
      ok: true,
      value: [
        festival(
          'f1',
          'Midsummer Nights',
          '2026-07-01T00:00:00Z',
          '2026-07-04T00:00:00Z',
        ),
      ],
    });

    const wrapper = await mountView();
    expect(wrapper.find('#create-form').exists()).toBe(false);

    const newEvent = wrapper
      .findAll('button')
      .find((button) => button.text() === 'New event');
    await newEvent?.trigger('click');

    expect(wrapper.find('#create-form').exists()).toBe(true);
    expect(wrapper.find('#create-form select').exists()).toBe(false);
  });

  it('adds an event to a festival from that festival’s card', async () => {
    vi.spyOn(eventsApi, 'fetchEvents').mockResolvedValue({
      ok: true,
      value: [],
    });
    vi.spyOn(festivalsApi, 'fetchFestivals').mockResolvedValue({
      ok: true,
      value: [
        festival(
          'f1',
          'Midsummer Nights',
          '2026-07-01T00:00:00Z',
          '2026-07-04T00:00:00Z',
        ),
      ],
    });
    const createEvent = vi.spyOn(eventsApi, 'createEvent').mockResolvedValue({
      ok: true,
      event: event(
        'e-new',
        'Friday',
        '2026-07-01T08:00:00Z',
        '2026-07-01T18:00:00Z',
        'f1',
      ),
      operationId: 'op-1',
    });

    const wrapper = await mountView();
    const add = wrapper
      .findAll('.evp-group-add button')
      .find((button) => button.text() === 'Add an event');
    await add?.trigger('click');

    const form = wrapper.find('.evp-group-add form');
    expect(form.text()).toContain('Midsummer Nights');
    const inputs = form.findAll('input');
    await inputs[0]?.setValue('Friday');
    await form
      .find('input[type="datetime-local"]')
      .setValue('2026-07-01T10:00');
    await form
      .findAll('input[type="datetime-local"]')[1]
      ?.setValue('2026-07-01T20:00');
    await form.trigger('submit');
    await flushPromises();

    expect(createEvent).toHaveBeenCalledOnce();
    expect(createEvent.mock.calls[0]?.[1]).toMatchObject({
      name: 'Friday',
      festivalId: 'f1',
    });
  });

  it('switches the submit target when the festival form is the one open', async () => {
    vi.spyOn(eventsApi, 'fetchEvents').mockResolvedValue({
      ok: true,
      value: [],
    });
    vi.spyOn(festivalsApi, 'fetchFestivals').mockResolvedValue({
      ok: true,
      value: [],
    });

    const wrapper = await mountView();
    const newFestival = wrapper
      .findAll('button')
      .find((button) => button.text() === 'New festival');
    await newFestival?.trigger('click');

    expect(wrapper.find('#create-form').exists()).toBe(true);
    expect(wrapper.find('button[type="submit"]').text()).toBe(
      'Create festival',
    );
  });

  it('lists what is coming up first and what has finished at the bottom', async () => {
    vi.spyOn(eventsApi, 'fetchEvents').mockResolvedValue({
      ok: true,
      value: [
        event(
          'e-late',
          'August Fete',
          '2026-08-01T08:00:00Z',
          '2026-08-01T18:00:00Z',
        ),
        event(
          'e-old',
          'Last Winter',
          '2026-01-10T08:00:00Z',
          '2026-01-10T18:00:00Z',
        ),
        event(
          'e-soon',
          'Next Weekend',
          '2026-06-20T08:00:00Z',
          '2026-06-20T18:00:00Z',
        ),
      ],
    });
    vi.spyOn(festivalsApi, 'fetchFestivals').mockResolvedValue({
      ok: true,
      value: [],
    });

    const wrapper = await mountView();

    expect(orderOnPage(wrapper)).toEqual([
      'Next Weekend',
      'August Fete',
      'Last Winter',
    ]);
    // The heading order is the other half of the claim: "Past" is a section of
    // its own, below.
    const headings = wrapper.findAll('h2').map((h) => h.text());
    expect(headings.indexOf('Coming up')).toBeLessThan(
      headings.indexOf('Past'),
    );
  });

  it('nests a festival’s events under a heading linking to the festival', async () => {
    vi.spyOn(eventsApi, 'fetchEvents').mockResolvedValue({
      ok: true,
      value: [
        event(
          'e-day2',
          'Saturday',
          '2026-07-02T08:00:00Z',
          '2026-07-02T18:00:00Z',
          'f1',
        ),
        event(
          'e-day1',
          'Friday',
          '2026-07-01T08:00:00Z',
          '2026-07-01T18:00:00Z',
          'f1',
        ),
        event(
          'e-solo',
          'Next Weekend',
          '2026-06-20T08:00:00Z',
          '2026-06-20T18:00:00Z',
        ),
      ],
    });
    vi.spyOn(festivalsApi, 'fetchFestivals').mockResolvedValue({
      ok: true,
      value: [
        festival(
          'f1',
          'Midsummer Nights',
          '2026-07-01T00:00:00Z',
          '2026-07-04T00:00:00Z',
        ),
      ],
    });

    const wrapper = await mountView();

    expect(orderOnPage(wrapper)).toEqual([
      'Next Weekend',
      'Midsummer Nights',
      'Friday',
      'Saturday',
    ]);
    expect(wrapper.find('.evp-group-title').attributes('href')).toBe(
      '/org-1/festivals/f1',
    );
  });

  it('keeps a festival with no events yet, in its own chronological place', async () => {
    vi.spyOn(eventsApi, 'fetchEvents').mockResolvedValue({
      ok: true,
      value: [],
    });
    vi.spyOn(festivalsApi, 'fetchFestivals').mockResolvedValue({
      ok: true,
      value: [
        festival(
          'f1',
          'Midsummer Nights',
          '2026-07-01T00:00:00Z',
          '2026-07-04T00:00:00Z',
        ),
      ],
    });

    const wrapper = await mountView();

    expect(orderOnPage(wrapper)).toEqual(['Midsummer Nights']);
    expect(wrapper.text()).toContain('No events yet.');
    expect(wrapper.text()).not.toContain('Nothing planned yet');
  });

  it('offers to load the example event once a festival exists, and vice versa', async () => {
    // The two loaders are independent server calls, each 409ing only once its
    // own resource is non-empty (docs/04). A festival already on the org must
    // not hide the "load the example event" button, and an event already on
    // the org must not hide "load the example festival".
    vi.spyOn(eventsApi, 'fetchEvents').mockResolvedValue({
      ok: true,
      value: [],
    });
    vi.spyOn(festivalsApi, 'fetchFestivals').mockResolvedValue({
      ok: true,
      value: [
        festival(
          'f1',
          'Midsummer Nights',
          '2026-07-01T00:00:00Z',
          '2026-07-04T00:00:00Z',
        ),
      ],
    });

    const wrapper = await mountView();
    const labels = wrapper.findAll('button').map((button) => button.text());

    expect(labels).toContain('Load the example event');
    expect(labels).not.toContain('Load the example festival');
  });

  it('renders the club night period across two dates in the event zone', async () => {
    // 22:00 to 05:00 the next day in Europe/Paris (CEST, +2) — the
    // midnight-crossing shape `format/period.ts` exists not to collapse.
    vi.spyOn(eventsApi, 'fetchEvents').mockResolvedValue({
      ok: true,
      value: [
        event(
          'e1',
          'Club Night',
          '2026-07-03T20:00:00Z',
          '2026-07-04T03:00:00Z',
        ),
      ],
    });
    vi.spyOn(festivalsApi, 'fetchFestivals').mockResolvedValue({
      ok: true,
      value: [],
    });

    const wrapper = await mountView();

    // `formatTime`'s `'en'` formatter renders a 12-hour clock (period.test.ts).
    expect(wrapper.text()).toContain('10:00 PM');
    expect(wrapper.text()).toContain('05:00 AM');
  });

  it('treats a 409 on the example as informational, not an error', async () => {
    vi.spyOn(eventsApi, 'fetchEvents').mockResolvedValue({
      ok: true,
      value: [],
    });
    vi.spyOn(festivalsApi, 'fetchFestivals')
      .mockResolvedValueOnce({ ok: true, value: [] })
      .mockResolvedValue({
        ok: true,
        value: [
          festival(
            'f1',
            'Midsummer Nights',
            '2026-07-01T00:00:00Z',
            '2026-07-04T00:00:00Z',
          ),
        ],
      });
    vi.spyOn(festivalsApi, 'loadExampleFestival').mockResolvedValue({
      ok: false,
      rejection: { reason: 'conflict', detail: 'already has a festival' },
    });

    const wrapper = await mountView();
    const loadButton = wrapper
      .findAll('button')
      .find((button) => button.text().includes('Load the example festival'));
    await loadButton?.trigger('click');
    await flushPromises();

    const status = wrapper.find('[role="status"]');
    expect(status.exists()).toBe(true);
    expect(status.text()).toContain(
      'Another coordinator already loaded a festival',
    );
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it('still lists events, and says so, when festivals could not be loaded', async () => {
    vi.spyOn(eventsApi, 'fetchEvents').mockResolvedValue({
      ok: true,
      value: [
        event(
          'e1',
          'Next Weekend',
          '2026-06-20T08:00:00Z',
          '2026-06-20T18:00:00Z',
          'f1',
        ),
      ],
    });
    vi.spyOn(festivalsApi, 'fetchFestivals').mockResolvedValue({
      ok: false,
      failure: { reason: 'unavailable' },
    });

    const wrapper = await mountView();

    expect(wrapper.find('[role="alert"]').text()).toContain(
      'Festivals could not be loaded',
    );
    expect(orderOnPage(wrapper)).toEqual(['Next Weekend']);
  });
});
