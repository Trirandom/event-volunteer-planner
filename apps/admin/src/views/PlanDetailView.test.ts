// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { eventColor } from '@evp/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as eventsApi from '../api/events';
import * as events from '../api/events';
import type * as festivalsApi from '../api/festivals';
import * as festivals from '../api/festivals';
import * as sessionApi from '../api/session';
import PlanDetailView from './PlanDetailView.vue';

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

function event(overrides: Partial<eventsApi.Event> = {}): eventsApi.Event {
  return {
    id: 'open-air',
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

function festival(
  eventList: readonly eventsApi.Event[],
): festivalsApi.FestivalDetail {
  return {
    id: 'festival-1',
    name: 'Soundclash 26',
    slug: 'soundclash-26',
    timezone: 'Europe/Paris',
    period: { start: '2026-07-30T08:00:00Z', end: '2026-08-04T18:00:00Z' },
    status: 'planning',
    event_count: eventList.length,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    version: 1,
    events: [...eventList],
  };
}

const DUB = event({
  id: 'dub',
  name: 'Dub & 2step',
  slug: 'dub-2step',
  period: { start: '2026-08-02T18:00:00Z', end: '2026-08-03T06:00:00Z' },
});

/** Mirrors the real router (router/index.ts): both URL shapes mount this one
 * component, and each has the same seven sections under it, in the same order
 * — the rail links to every one of them, so a section missing here is a
 * `No match for` on mount rather than a quiet gap. */
function testRouter(): Router {
  const sections = (scope: 'festival' | 'event') => [
    {
      path: 'details',
      name: `org-${scope}-details`,
      component: { template: '<p>details placeholder</p>' },
      meta: { section: 'details' as const },
    },
    {
      path: 'missions',
      name: `org-${scope}-missions`,
      component: { template: '<p>missions placeholder</p>' },
      meta: { section: 'missions' as const },
    },
    {
      path: 'shifts',
      name: `org-${scope}-shifts`,
      component: { template: '<p>shifts placeholder</p>' },
      meta: { section: 'shifts' as const },
    },
    {
      path: 'form',
      name: `org-${scope}-form`,
      component: { template: '<p>form placeholder</p>' },
      meta: { section: 'form' as const },
    },
    {
      path: 'assignments',
      name: `org-${scope}-assignments`,
      component: { template: '<p>assignments placeholder</p>' },
      meta: { section: 'assignments' as const },
    },
    {
      path: 'submissions',
      name: `org-${scope}-submissions`,
      component: { template: '<p>submissions placeholder</p>' },
      meta: { section: 'submissions' as const },
    },
    {
      path: 'availability',
      name: `org-${scope}-availability`,
      component: { template: '<p>availability placeholder</p>' },
      meta: { section: 'availability' as const },
    },
    {
      path: 'emails',
      name: `org-${scope}-emails`,
      component: { template: '<p>emails placeholder</p>' },
      meta: { section: 'emails' as const },
    },
  ];

  return createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/:orgId/events',
        name: 'org-events',
        component: { template: '<div />' },
      },
      {
        path: '/:orgId/festivals/:festivalId',
        name: 'org-festival-detail',
        component: PlanDetailView,
        children: sections('festival'),
      },
      {
        path: '/:orgId/events/:eventId',
        name: 'org-event-detail',
        component: PlanDetailView,
        children: sections('event'),
      },
    ],
  });
}

/**
 * Mounted through a bare `<RouterView>` rather than as the component itself:
 * `PlanDetailView` renders a `<RouterView>` of its own for the section, and a
 * directly-mounted component sits at view depth 0, so the router would match
 * it a second time inside itself. Going in through the router is also simply
 * what the application does.
 */
async function mountView(path: string) {
  const router = testRouter();
  await router.push(path);
  await router.isReady();

  const wrapper = mount(
    { template: '<RouterView />' },
    {
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
    },
  );
  await flushPromises();
  return { wrapper, router };
}

function dayLinks(wrapper: Awaited<ReturnType<typeof mountView>>['wrapper']) {
  return wrapper.findAll('nav[aria-label="Festival scope"] a');
}

beforeEach(() => {
  vi.spyOn(sessionApi, 'fetchSession').mockResolvedValue(AUTHENTICATED_USER);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PlanDetailView at festival scope', () => {
  beforeEach(() => {
    vi.spyOn(festivals, 'fetchFestival').mockResolvedValue({
      ok: true,
      value: festival([event(), DUB]),
    });
  });

  it('names the festival and offers every day of it', async () => {
    const { wrapper } = await mountView('/org-1/festivals/festival-1/missions');

    expect(wrapper.find('h1').text()).toBe('Soundclash 26');
    expect(dayLinks(wrapper).map((link) => link.text())).toEqual([
      'Whole festival',
      'Open Air',
      'Dub & 2step',
    ]);
  });

  it('asks for no event when the URL named a festival', async () => {
    const fetchEvent = vi.spyOn(events, 'fetchEvent');

    await mountView('/org-1/festivals/festival-1/missions');

    expect(fetchEvent).not.toHaveBeenCalled();
  });

  it('renders the matched section inside the layout', async () => {
    const { wrapper } = await mountView(
      '/org-1/festivals/festival-1/submissions',
    );

    expect(wrapper.text()).toContain('submissions placeholder');
  });

  it('keeps the section when a day is picked', async () => {
    const { wrapper } = await mountView('/org-1/festivals/festival-1/shifts');

    const dub = dayLinks(wrapper).find((link) => link.text() === 'Dub & 2step');
    expect(dub?.attributes('href')).toBe('/org-1/events/dub/shifts');
  });

  it('leaves the dates to the details section', async () => {
    const { wrapper } = await mountView('/org-1/festivals/festival-1/missions');

    expect(wrapper.find('.evp-rail').text()).not.toContain('2026');
    expect(wrapper.find('.evp-content > .evp-muted').exists()).toBe(false);
  });

  /** The form is the festival's (ADR-0035) and its submissions table carries
   * its own day filter, so a strip of days there narrows nothing useful. */
  it.each(['form', 'submissions'])(
    'offers no day strip on the %s section',
    async (named) => {
      const { wrapper } = await mountView(
        `/org-1/festivals/festival-1/${named}`,
      );

      expect(dayLinks(wrapper)).toHaveLength(0);
    },
  );

  it('reports the failure rather than an empty page', async () => {
    vi.spyOn(festivals, 'fetchFestival').mockResolvedValue({
      ok: false,
      failure: { reason: 'unavailable' },
    });

    const { wrapper } = await mountView('/org-1/festivals/festival-1/missions');

    expect(wrapper.find('[role="alert"]').text()).toContain(
      'This page could not be loaded.',
    );
  });
});

describe('PlanDetailView at day scope', () => {
  it('still names the festival, and shows the day it is narrowed to', async () => {
    vi.spyOn(events, 'fetchEvent').mockResolvedValue({ ok: true, value: DUB });
    vi.spyOn(festivals, 'fetchFestival').mockResolvedValue({
      ok: true,
      value: festival([event(), DUB]),
    });

    const { wrapper } = await mountView('/org-1/events/dub/missions');

    expect(wrapper.find('h1').text()).toBe('Soundclash 26');
    expect(wrapper.find('.evp-day-summary').text()).toContain('Dub & 2step');
    expect(dayLinks(wrapper)).toHaveLength(3);
  });

  it('loads the festival the day belongs to without being told which', async () => {
    vi.spyOn(events, 'fetchEvent').mockResolvedValue({ ok: true, value: DUB });
    const fetchFestival = vi
      .spyOn(festivals, 'fetchFestival')
      .mockResolvedValue({ ok: true, value: festival([event(), DUB]) });

    await mountView('/org-1/events/dub/missions');

    expect(fetchFestival).toHaveBeenCalledWith(
      'org-1',
      'festival-1',
      expect.anything(),
    );
  });

  /**
   * The strip is where a coordinator learns which colour is which day, so a
   * chip that dropped the colour would leave the board, the cards and the
   * roster keyed to something nothing on screen explains. Asserted as the
   * custom property the stylesheet reads rather than as a rendered
   * background, which jsdom does not compute.
   */
  it('draws each day chip in that day’s own colour', async () => {
    vi.spyOn(events, 'fetchEvent').mockResolvedValue({ ok: true, value: DUB });
    vi.spyOn(festivals, 'fetchFestival').mockResolvedValue({
      ok: true,
      value: festival([event({ color: 0 }), event({ ...DUB, color: 5 })]),
    });

    const { wrapper } = await mountView('/org-1/events/dub/missions');

    const styles = dayLinks(wrapper).map((link) => link.attributes('style'));
    // "Whole festival" is first and carries none: a festival has no colour of
    // its own, and giving it one would make the strip read as three peers.
    expect(styles[0]).toBeUndefined();
    expect(styles[1]).toContain(eventColor(0));
    expect(styles[2]).toContain(eventColor(5));
  });

  it('shows a standalone event alone, with no scope switch to make', async () => {
    vi.spyOn(events, 'fetchEvent').mockResolvedValue({
      ok: true,
      value: event({ id: 'solo', name: 'August Fete', festival_id: null }),
    });
    const fetchFestival = vi.spyOn(festivals, 'fetchFestival');

    const { wrapper } = await mountView('/org-1/events/solo/missions');

    expect(wrapper.find('h1').text()).toBe('August Fete');
    expect(dayLinks(wrapper)).toHaveLength(0);
    expect(fetchFestival).not.toHaveBeenCalled();
  });

  it('shows the day alone, and says so, when its festival cannot be loaded', async () => {
    vi.spyOn(events, 'fetchEvent').mockResolvedValue({ ok: true, value: DUB });
    vi.spyOn(festivals, 'fetchFestival').mockResolvedValue({
      ok: false,
      failure: { reason: 'unavailable' },
    });

    const { wrapper } = await mountView('/org-1/events/dub/missions');

    expect(wrapper.find('h1').text()).toBe('Dub & 2step');
    expect(wrapper.find('[role="alert"]').text()).toContain(
      'could not be loaded, so only this day is shown',
    );
    expect(wrapper.text()).toContain('missions placeholder');
  });
});
