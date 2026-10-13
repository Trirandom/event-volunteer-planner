// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The review sub-page: each waiting submission beside who it could be, and
 * each decision sent as the body `POST …/resolve` reads.
 */
import { flushPromises, mount } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as eventsApi from '../api/events';
import * as festivals from '../api/festivals';
import type * as festivalsApi from '../api/festivals';
import * as intakeReview from '../api/intakeReview';
import * as sessionApi from '../api/session';
import PlanSubmissionsReviewView from './PlanSubmissionsReviewView.vue';

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

const OPEN_AIR: eventsApi.Event = {
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
};

const FESTIVAL: festivalsApi.FestivalDetail = {
  id: 'festival-1',
  name: 'Soundclash 26',
  slug: 'soundclash-26',
  timezone: 'Europe/Paris',
  period: { start: '2026-09-05T06:00:00Z', end: '2026-09-14T16:00:00Z' },
  status: 'planning',
  event_count: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  version: 1,
  events: [OPEN_AIR],
};

const NAMESAKE: intakeReview.ReviewItem = {
  id: 'sub-1',
  received_at: '2026-08-04T13:09:35Z',
  claimed: {
    display_name: 'Ada Lovelace',
    first_name: 'Ada',
    last_name: 'Lovelace',
    email: 'ada@example.org',
  },
  answers: [{ question: 'Nom de famille', value: 'Lovelace' }],
  availability: [
    {
      event_id: 'open-air',
      start: '2026-09-05T08:00:00Z',
      end: '2026-09-05T12:00:00Z',
    },
  ],
  reasons: [],
  candidates: [
    {
      volunteer_id: 'vol-1',
      score: 0.92,
      last_name_agrees: false,
      phone_agrees: false,
      display_name: 'Ada L.',
      email: 'old@example.org',
    },
  ],
};

const HELD: intakeReview.ReviewItem = {
  id: 'sub-2',
  received_at: '2026-08-05T09:00:00Z',
  claimed: { display_name: 'Grace' },
  answers: [],
  availability: [],
  reasons: [{ field: 'elapsed_ms', code: 'too_fast' }],
  candidates: [],
};

async function mountView() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/:orgId/festivals/:festivalId',
        component: { template: '<RouterView />' },
        children: [
          {
            path: 'submissions',
            name: 'org-festival-submissions',
            component: { template: '<p />' },
          },
          {
            path: 'submissions/review',
            name: 'org-festival-submissions-review',
            component: PlanSubmissionsReviewView,
          },
        ],
      },
    ],
  });
  await router.push('/org-1/festivals/festival-1/submissions/review');
  await router.isReady();
  const wrapper = mount(
    { template: '<RouterView />' },
    {
      attachTo: document.body,
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
  return wrapper;
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function showModal(
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '');
  });
  HTMLDialogElement.prototype.close = vi.fn(function close(
    this: HTMLDialogElement,
  ) {
    this.removeAttribute('open');
  });
  vi.spyOn(sessionApi, 'fetchSession').mockResolvedValue(SESSION);
  vi.spyOn(festivals, 'fetchFestival').mockResolvedValue({
    ok: true,
    value: FESTIVAL,
  });
  vi.spyOn(intakeReview, 'fetchReviewQueue').mockResolvedValue({
    ok: true,
    value: [NAMESAKE, HELD],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

function applied(): intakeReview.ResolveResult {
  return {
    ok: true,
    resolved: {
      state: 'applied',
      volunteer_id: 'vol-1',
      match_kind: 'manual',
      email_withheld: false,
      operation_id: 'op-1',
    },
  };
}

describe('PlanSubmissionsReviewView', () => {
  it('shows what was sent beside the volunteer it could be', async () => {
    const wrapper = await mountView();
    const items = wrapper.findAll('.evp-review-item');
    expect(items).toHaveLength(2);

    const first = items[0];
    expect(first?.find('h3').text()).toBe('Ada Lovelace');
    expect(first?.text()).toContain('ada@example.org');
    expect(first?.text()).toContain('Open Air');
    expect(first?.find('.evp-candidate').text()).toContain('Ada L.');
    expect(first?.find('.evp-candidate').text()).toContain('92%');
    expect(first?.text()).toContain('Name close to an existing volunteer');

    expect(items[1]?.text()).toContain('Sent in under 3 seconds');
    expect(items[1]?.text()).toContain('No volunteer looks like this person');
  });

  it('matches to the chosen volunteer and says so', async () => {
    const resolve = vi
      .spyOn(intakeReview, 'resolveSubmission')
      .mockResolvedValue(applied());
    const wrapper = await mountView();

    await wrapper.find('.evp-candidate button').trigger('click');
    await flushPromises();

    expect(resolve).toHaveBeenCalledWith('org-1', 'sub-1', {
      action: 'match',
      volunteer_id: 'vol-1',
    });
    expect(wrapper.text()).toContain(
      'Ada Lovelace’s submission joined the pool',
    );
  });

  it('offers to run matching again only for one never compared', async () => {
    const resolve = vi
      .spyOn(intakeReview, 'resolveSubmission')
      .mockResolvedValue(applied());
    const wrapper = await mountView();
    const [namesake, held] = wrapper.findAll('.evp-review-item');

    expect(namesake?.text()).not.toContain('Run matching again');
    const rerun = held
      ?.findAll('button')
      .find((button) => button.text() === 'Run matching again');
    await rerun?.trigger('click');
    await flushPromises();

    expect(resolve).toHaveBeenCalledWith('org-1', 'sub-2', {
      action: 'reconcile',
    });
  });

  it('asks before rejecting, and sends the reason', async () => {
    const resolve = vi
      .spyOn(intakeReview, 'resolveSubmission')
      .mockResolvedValue({
        ok: true,
        resolved: {
          state: 'rejected',
          email_withheld: false,
          operation_id: 'op-2',
        },
      });
    const wrapper = await mountView();

    const reject = wrapper
      .findAll('.evp-review-item')[1]
      ?.findAll('button')
      .find((button) => button.text() === 'Reject');
    await reject?.trigger('click');
    expect(resolve).not.toHaveBeenCalled();

    await wrapper.find('dialog textarea').setValue('bot');
    const confirm = wrapper
      .findAll('dialog button')
      .find((button) => button.text() === 'Reject');
    await confirm?.trigger('click');
    await flushPromises();

    expect(resolve).toHaveBeenCalledWith('org-1', 'sub-2', {
      action: 'reject',
      reason: 'bot',
    });
    expect(wrapper.text()).toContain('Grace’s submission was rejected');
  });

  it('says when someone else got there first', async () => {
    vi.spyOn(intakeReview, 'resolveSubmission').mockResolvedValue({
      ok: false,
      rejection: { reason: 'conflict', detail: 'no longer waiting' },
    });
    const wrapper = await mountView();

    await wrapper.find('.evp-candidate button').trigger('click');
    await flushPromises();

    expect(wrapper.find('[role="alert"]').text()).toContain(
      'Someone else already handled this submission',
    );
  });

  it('says there is nothing to review', async () => {
    vi.spyOn(intakeReview, 'fetchReviewQueue').mockResolvedValue({
      ok: true,
      value: [],
    });
    const wrapper = await mountView();
    expect(wrapper.text()).toContain('Everything is handled.');
    expect(wrapper.find('.evp-review-item').exists()).toBe(false);
  });
});
