// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The submissions section, mounted through the router.
 *
 * Three claims are worth a component test rather than leaving to
 * `plan/submissions`'s unit tests. That one URL asks for the festival's
 * submissions and the other asks for the *same* ones and then narrows them —
 * that is the reason this section exists at both URLs. That a night lapping
 * midnight prints both of its dates, which is the bug docs/16 exists to
 * prevent and is invisible in a test that only counts rows. And that a
 * standalone event says so instead of firing a request for the empty string.
 */
import { flushPromises, mount } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as eventsApi from '../api/events';
import * as events from '../api/events';
import type * as festivalsApi from '../api/festivals';
import * as festivals from '../api/festivals';
import * as intakeReview from '../api/intakeReview';
import * as sessionApi from '../api/session';
import type * as submissionsApi from '../api/submissions';
import * as submissions from '../api/submissions';
import PlanSubmissionsView from './PlanSubmissionsView.vue';

const SESSION: sessionApi.Session = {
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

function event(overrides: Partial<eventsApi.Event> = {}): eventsApi.Event {
  return {
    id: 'open-air',
    festival_id: 'festival-1',
    name: 'Open Air',
    slug: 'open-air',
    timezone: 'Europe/Paris',
    period: { start: '2026-09-05T08:00:00Z', end: '2026-09-05T22:00:00Z' },
    status: 'draft',
    color: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    version: 1,
    ...overrides,
  };
}

const OPEN_AIR = event();
const DUB = event({
  id: 'dub',
  name: 'Dub & 2step',
  slug: 'dub-2step',
  color: 5,
  period: { start: '2026-09-11T18:00:00Z', end: '2026-09-12T06:00:00Z' },
});

const FESTIVAL: festivalsApi.FestivalDetail = {
  id: 'festival-1',
  name: 'Soundclash 26',
  slug: 'soundclash-26',
  timezone: 'Europe/Paris',
  period: { start: '2026-09-05T06:00:00Z', end: '2026-09-14T16:00:00Z' },
  status: 'planning',
  event_count: 2,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  version: 1,
  events: [OPEN_AIR, DUB],
};

const CAMILLE: submissionsApi.Submission = {
  id: 'submission-1',
  display_name: 'Camille',
  first_name: 'Camille',
  last_name: null,
  submitted_at: '2026-08-04T13:09:35Z',
  answers: [{ question: 'Postes préférés', value: 'Bar, Entrées' }],
  availability: [
    {
      event_id: 'open-air',
      start: '2026-09-05T08:00:00Z',
      end: '2026-09-05T12:00:00Z',
    },
  ],
};

/** The overnight case: 20:00 to 05:00 in Paris, so the end falls on the next
 * calendar day and both dates have to be printed. */
const AUREL: submissionsApi.Submission = {
  id: 'submission-2',
  display_name: 'MARCHAND Aurel',
  first_name: 'Aurel',
  last_name: 'Marchand',
  submitted_at: '2026-08-05T09:22:56Z',
  answers: [],
  availability: [
    {
      event_id: 'dub',
      start: '2026-09-11T18:00:00Z',
      end: '2026-09-12T03:00:00Z',
    },
  ],
};

function testRouter(): Router {
  const section = (scope: 'festival' | 'event') => ({
    path: 'submissions',
    name: `org-${scope}-submissions`,
    component: PlanSubmissionsView,
  });

  // The expanded row links here; only its name has to resolve.
  const availability = (scope: 'festival' | 'event') => ({
    path: 'availability',
    name: `org-${scope}-availability`,
    component: { template: '<p />' },
  });

  // The review callout links here.
  const review = (scope: 'festival' | 'event') => ({
    path: 'submissions/review',
    name: `org-${scope}-submissions-review`,
    component: { template: '<p />' },
  });

  return createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/:orgId/festivals/:festivalId',
        component: { template: '<RouterView />' },
        children: [
          section('festival'),
          availability('festival'),
          review('festival'),
        ],
      },
      {
        path: '/:orgId/events/:eventId',
        component: { template: '<RouterView />' },
        children: [section('event'), availability('event'), review('event')],
      },
    ],
  });
}

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

beforeEach(() => {
  vi.spyOn(sessionApi, 'fetchSession').mockResolvedValue(SESSION);
  vi.spyOn(festivals, 'fetchFestival').mockResolvedValue({
    ok: true,
    value: FESTIVAL,
  });
  vi.spyOn(events, 'fetchEvent').mockResolvedValue({ ok: true, value: DUB });
  vi.spyOn(submissions, 'fetchSubmissions').mockResolvedValue({
    ok: true,
    value: [CAMILLE, AUREL],
  });
  vi.spyOn(intakeReview, 'fetchReviewQueue').mockResolvedValue({
    ok: true,
    value: [],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PlanSubmissionsView', () => {
  it('asks the festival for its submissions, from the festival URL', async () => {
    const { wrapper } = await mountView(
      '/org-1/festivals/festival-1/submissions',
    );

    expect(submissions.fetchSubmissions).toHaveBeenCalledWith(
      'org-1',
      'festival-1',
      expect.anything(),
    );
    expect(wrapper.findAll('.evp-submission')).toHaveLength(2);
  });

  /** The point of one festival-scoped query: reaching a day is reaching the
   * production it is part of, so the day URL asks for the same rows rather
   * than for a per-day submission nobody ever submitted. */
  it('asks for the same festival rows from a day URL, and narrows them', async () => {
    const { wrapper } = await mountView('/org-1/events/dub/submissions');

    expect(submissions.fetchSubmissions).toHaveBeenCalledWith(
      'org-1',
      'festival-1',
      expect.anything(),
    );

    const names = wrapper
      .findAll('.evp-submission-name')
      .map((heading) => heading.text());
    expect(names).toEqual(['MARCHAND Aurel · Marchand']);
    expect(wrapper.text()).toContain('1 of 2 submissions');
  });

  it('prints both dates of a night that laps midnight', async () => {
    const { wrapper } = await mountView('/org-1/events/dub/submissions');
    await wrapper.find('.evp-disclosure').trigger('click');

    const window = wrapper.find('.evp-window-time').text();
    // Both dates, spelled out: the end is on the 12th even though the shift
    // is Friday night's, and a same-day pair here would print 20:00–05:00 on
    // the 11th — nine hours of bar shrunk to a negative one.
    expect(window).toContain('September 11, 2026');
    expect(window).toContain('September 12, 2026');
  });

  it('names the day on every window, and colours it like the board', async () => {
    const { wrapper } = await mountView(
      '/org-1/festivals/festival-1/submissions',
    );
    for (const toggle of wrapper.findAll('.evp-disclosure')) {
      await toggle.trigger('click');
    }

    expect(wrapper.findAll('.evp-window-day').map((day) => day.text())).toEqual(
      ['Open Air', 'Dub & 2step'],
    );
  });

  /** The windows are the availability page's detail: the table carries the
   * total and folds the rest out on demand. */
  it('folds the windows away until the row is opened', async () => {
    const { wrapper } = await mountView(
      '/org-1/festivals/festival-1/submissions',
    );

    expect(wrapper.findAll('.evp-window')).toHaveLength(0);
    const toggle = wrapper.find('.evp-disclosure');
    expect(toggle.attributes('aria-expanded')).toBe('false');

    await toggle.trigger('click');
    expect(toggle.attributes('aria-expanded')).toBe('true');
    expect(wrapper.findAll('.evp-window')).toHaveLength(1);
    expect(wrapper.find('.evp-submission-detail a').text()).toContain(
      'Availability page',
    );
  });

  it('gives each question its own column, blank where it was not asked', async () => {
    const { wrapper } = await mountView(
      '/org-1/festivals/festival-1/submissions',
    );

    const headers = wrapper
      .findAll('thead tr:first-child th')
      .map((header) => header.text());
    expect(headers).toEqual([
      'Name',
      'Submitted',
      'Availability',
      'Postes préférés',
    ]);
    const cells = wrapper
      .findAll('.evp-submission .evp-answer')
      .map((cell) => cell.text());
    expect(cells).toEqual(['Bar, Entrées', '']);
  });

  it('narrows the rows with a column filter and counts what is left', async () => {
    const { wrapper } = await mountView(
      '/org-1/festivals/festival-1/submissions',
    );
    expect(wrapper.find('.evp-table-count').text()).toBe(
      'Showing 2 submissions of 2',
    );

    await wrapper.find('.evp-filter-row input').setValue('marchand');
    expect(
      wrapper.findAll('.evp-submission-name').map((name) => name.text()),
    ).toEqual(['MARCHAND Aurel · Marchand']);
    expect(wrapper.find('.evp-table-count').text()).toBe(
      'Showing 1 submission of 2',
    );

    await wrapper.find('.evp-table-toolbar button').trigger('click');
    expect(wrapper.findAll('.evp-submission')).toHaveLength(2);
  });

  it('filters on the day a volunteer offered time', async () => {
    const { wrapper } = await mountView(
      '/org-1/festivals/festival-1/submissions',
    );

    const availability = wrapper.findAll('.evp-filter-row select')[0];
    await availability?.setValue('dub');
    expect(
      wrapper.findAll('.evp-submission-name').map((name) => name.text()),
    ).toEqual(['MARCHAND Aurel · Marchand']);
  });

  it('says so when no row matches the filters', async () => {
    const { wrapper } = await mountView(
      '/org-1/festivals/festival-1/submissions',
    );

    await wrapper.find('.evp-filter-row input').setValue('nobody by that name');
    expect(wrapper.findAll('.evp-submission')).toHaveLength(0);
    expect(wrapper.text()).toContain('No submission matches these filters');
  });

  it('says so when the form has had no answers', async () => {
    vi.spyOn(submissions, 'fetchSubmissions').mockResolvedValue({
      ok: true,
      value: [],
    });
    const { wrapper } = await mountView(
      '/org-1/festivals/festival-1/submissions',
    );

    expect(wrapper.findAll('.evp-submission')).toHaveLength(0);
    expect(wrapper.text()).toContain('Nobody has answered the form yet');
  });

  it('reports a failed load rather than an empty list', async () => {
    vi.spyOn(submissions, 'fetchSubmissions').mockResolvedValue({
      ok: false,
      failure: { reason: 'unavailable' },
    });
    const { wrapper } = await mountView(
      '/org-1/festivals/festival-1/submissions',
    );

    expect(wrapper.find('[role="alert"]').text()).toContain(
      'could not be loaded',
    );
  });

  /** A standalone event has no production behind it, so there is no form to
   * have answered — and no request to make. */
  it('asks for nothing at all for a standalone event', async () => {
    vi.spyOn(events, 'fetchEvent').mockResolvedValue({
      ok: true,
      value: event({ id: 'solo', festival_id: null, name: 'Solo' }),
    });
    const { wrapper } = await mountView('/org-1/events/solo/submissions');

    expect(submissions.fetchSubmissions).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('No form behind this event');
  });

  /** What could not join the table has to be findable from it. */
  it('points at the submissions waiting for review, with their count', async () => {
    vi.spyOn(intakeReview, 'fetchReviewQueue').mockResolvedValue({
      ok: true,
      value: [
        {
          id: 'held-1',
          received_at: '2026-09-01T10:00:00Z',
          claimed: { display_name: 'Ada' },
          answers: [],
          availability: [],
          reasons: [{ field: 'elapsed_ms', code: 'too_fast' }],
          candidates: [],
        },
      ],
    });
    const { wrapper } = await mountView(
      '/org-1/festivals/festival-1/submissions',
    );

    const link = wrapper.find('.evp-review-callout a');
    expect(link.text()).toContain('1 submission to review');
    expect(link.attributes('href')).toBe(
      '/org-1/festivals/festival-1/submissions/review',
    );
    expect(wrapper.find('.evp-review-callout--waiting').exists()).toBe(true);
  });
});
