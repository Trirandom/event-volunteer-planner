// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The missions section, mounted through the router.
 *
 * `missionCatalog` and `missionDraft` already prove the fold and the patch
 * arithmetic without a component anywhere near them. What is only true once
 * the page is assembled is the *reach* of a gesture: one card, N rows, and a
 * fan-out that has to hit every one of them with the right version. A page
 * that rendered the fold correctly and then patched a single day would pass
 * both unit suites and be useless, so the claims tested here are about which
 * requests leave and what happens when some of them are refused.
 */
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as eventsApi from '../api/events';
import * as events from '../api/events';
import type * as festivalsApi from '../api/festivals';
import * as festivals from '../api/festivals';
import * as locations from '../api/locations';
import * as sessionApi from '../api/session';
import PlanMissionsView from './PlanMissionsView.vue';

function session(): sessionApi.Session {
  return {
    status: 'authenticated',
    user: {
      id: 'user-1',
      email: 'coordinator@example.org',
      display_name: 'Coordinator',
      locale: 'en',
      memberships: [
        {
          org_id: 'org-1',
          slug: 'org-1',
          name: 'Org One',
          role: 'coordinator',
        },
      ],
    },
  };
}

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

const OPEN_AIR = event();
const DUB = event({
  id: 'dub',
  name: 'Dub & 2step',
  slug: 'dub-2step',
  color: 1,
  period: { start: '2026-08-02T18:00:00Z', end: '2026-08-03T06:00:00Z' },
});

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

interface ZoneOptions {
  readonly description?: string;
  readonly address?: string;
  readonly checkedByDefault?: boolean;
  readonly adultsOnly?: boolean;
  readonly version?: number;
  readonly posts?: readonly locations.Post[];
}

function zone(
  id: string,
  eventId: string,
  name: string,
  options: ZoneOptions = {},
): locations.Zone {
  return {
    id,
    event_id: eventId,
    parent_id: null,
    kind: 'zone',
    name,
    ...(options.description === undefined
      ? {}
      : { description: options.description }),
    ...(options.address === undefined ? {} : { address: options.address }),
    ...(options.checkedByDefault === undefined
      ? {}
      : { checked_by_default: options.checkedByDefault }),
    ...(options.adultsOnly === undefined
      ? {}
      : { adults_only: options.adultsOnly }),
    sort_order: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    version: options.version ?? 1,
    posts: [...(options.posts ?? [])],
  };
}

interface PostOptions {
  readonly version?: number;
}

function post(
  id: string,
  eventId: string,
  parentId: string,
  name: string,
  options: PostOptions = {},
): locations.Post {
  return {
    id,
    event_id: eventId,
    parent_id: parentId,
    kind: 'post',
    name,
    sort_order: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    version: options.version ?? 1,
  };
}

/** The bar, on both days, with a different version per row — which is the
 * detail a fan-out has to get right. */
function barOnBothDays(): void {
  vi.spyOn(locations, 'fetchLocations').mockImplementation((_orgId, eventId) =>
    Promise.resolve({
      ok: true,
      value:
        eventId === 'open-air'
          ? [zone('loc-open-air', 'open-air', 'Bar', { version: 3 })]
          : [zone('loc-dub', 'dub', 'Bar', { version: 7 })],
    }),
  );
}

function testRouter(): Router {
  const sections = (scope: 'festival' | 'event') => [
    {
      path: 'missions',
      name: `org-${scope}-missions`,
      component: PlanMissionsView,
    },
    {
      path: 'shifts',
      name: `org-${scope}-shifts`,
      component: { template: '<p>shifts placeholder</p>' },
    },
  ];

  return createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/:orgId/festivals/:festivalId',
        component: { template: '<RouterView />' },
        children: sections('festival'),
      },
      {
        path: '/:orgId/events/:eventId',
        component: { template: '<RouterView />' },
        children: sections('event'),
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

/** Every card starts collapsed; the form is behind its heading. */
async function openCard(wrapper: VueWrapper, index = 0): Promise<void> {
  await wrapper.findAll('.evp-mission-toggle')[index]?.trigger('click');
}

/** jsdom has no `showModal`/`close` — stubbed as `HelpModal.test.ts` does, so
 * what is asserted is the wiring, and `open` is readable off the element. */
function stubDialogs(): void {
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
}

beforeEach(() => {
  stubDialogs();
  vi.spyOn(sessionApi, 'fetchSession').mockResolvedValue(session());
  vi.spyOn(festivals, 'fetchFestival').mockResolvedValue({
    ok: true,
    value: festival([OPEN_AIR, DUB]),
  });
  vi.spyOn(events, 'fetchEvent').mockResolvedValue({ ok: true, value: DUB });
  barOnBothDays();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PlanMissionsView — the fold', () => {
  it('shows one card for a mission that runs on two days, naming both', async () => {
    const { wrapper } = await mountView('/org-1/festivals/festival-1/missions');

    const cards = wrapper.findAll('.evp-mission');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.find('h3').text()).toContain('Bar');
    expect(cards[0]?.find('.evp-days').text()).toContain('Open Air');
    expect(cards[0]?.find('.evp-days').text()).toContain('Dub & 2step');
  });

  it('shows only the selected day’s rows at event scope', async () => {
    const { wrapper } = await mountView('/org-1/events/dub/missions');

    const card = wrapper.find('.evp-mission');
    expect(card.find('.evp-days').text()).toContain('Dub & 2step');
    expect(card.find('.evp-days').text()).not.toContain('Open Air');
  });

  it('names the days a mission is missing from', async () => {
    vi.spyOn(locations, 'fetchLocations').mockImplementation(
      (_orgId, eventId) =>
        Promise.resolve({
          ok: true,
          value:
            eventId === 'open-air' ? [zone('loc-1', 'open-air', 'Bar')] : [],
        }),
    );
    const { wrapper } = await mountView('/org-1/festivals/festival-1/missions');

    expect(wrapper.find('.evp-mission .evp-hint').text()).toContain(
      'Not declared on Dub & 2step',
    );
  });

  it('says so when there is nothing declared yet', async () => {
    vi.spyOn(locations, 'fetchLocations').mockResolvedValue({
      ok: true,
      value: [],
    });
    const { wrapper } = await mountView('/org-1/festivals/festival-1/missions');

    expect(wrapper.find('.evp-empty').exists()).toBe(true);
    expect(wrapper.findAll('.evp-mission')).toHaveLength(0);
  });

  /** A day whose tree did not load is indistinguishable from a day that does
   * not run the mission, which is the one failure that could make "add it
   * everywhere" create a duplicate. */
  it('warns loudly when a day’s locations could not be loaded', async () => {
    vi.spyOn(locations, 'fetchLocations').mockImplementation(
      (_orgId, eventId) =>
        Promise.resolve(
          eventId === 'dub'
            ? { ok: false, failure: { reason: 'unavailable' } }
            : { ok: true, value: [zone('loc-1', 'open-air', 'Bar')] },
        ),
    );
    const { wrapper } = await mountView('/org-1/festivals/festival-1/missions');

    expect(wrapper.find('[role="alert"]').text()).toContain(
      'could not be loaded',
    );
  });
});

describe('PlanMissionsView — editing fans out', () => {
  it('patches every day’s row, each against its own version', async () => {
    const patch = vi
      .spyOn(locations, 'patchLocation')
      .mockImplementation((_org, _event, id) =>
        Promise.resolve({ ok: true, location: zone(id, 'open-air', 'Bar') }),
      );

    const { wrapper } = await mountView('/org-1/festivals/festival-1/missions');
    await openCard(wrapper);
    const textarea = wrapper.find('.evp-mission textarea');
    await textarea.setValue('Serving and glass return.');
    await wrapper.find('.evp-mission form').trigger('submit');
    await flushPromises();

    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch).toHaveBeenCalledWith('org-1', 'open-air', 'loc-open-air', 3, {
      description: 'Serving and glass return.',
    });
    expect(patch).toHaveBeenCalledWith('org-1', 'dub', 'loc-dub', 7, {
      description: 'Serving and glass return.',
    });
  });

  it('sends nothing when nothing was typed', async () => {
    const patch = vi.spyOn(locations, 'patchLocation');
    const { wrapper } = await mountView('/org-1/festivals/festival-1/missions');
    await openCard(wrapper);

    await wrapper.find('.evp-mission form').trigger('submit');
    await flushPromises();

    expect(patch).not.toHaveBeenCalled();
  });

  /** Half a fan-out is a real state of the database; the days that did not
   * take the edit have to be named, because the remedy differs per day. */
  it('names the days a partial fan-out did not reach', async () => {
    vi.spyOn(locations, 'patchLocation').mockImplementation(
      (_org, eventId, id) =>
        Promise.resolve(
          eventId === 'dub'
            ? {
                ok: false,
                rejection: {
                  reason: 'conflict',
                  detail: 'Somebody else changed it.',
                },
              }
            : { ok: true, location: zone(id, 'open-air', 'Bar') },
        ),
    );

    const { wrapper } = await mountView('/org-1/festivals/festival-1/missions');
    await openCard(wrapper);
    await wrapper.find('.evp-mission textarea').setValue('Serving.');
    await wrapper.find('.evp-mission form').trigger('submit');
    await flushPromises();

    const error = wrapper.find('.evp-mission .evp-error');
    expect(error.text()).toContain('Dub & 2step');
    expect(error.text()).toContain('Somebody else changed it.');
    expect(error.text()).toContain('1 of 2 days were saved');
  });

  /** The days genuinely disagree, so the form must not offer one box that
   * would flatten them without anybody deciding to. */
  it('refuses to show one box for a field the days disagree about', async () => {
    vi.spyOn(locations, 'fetchLocations').mockImplementation(
      (_orgId, eventId) =>
        Promise.resolve({
          ok: true,
          value:
            eventId === 'open-air'
              ? [zone('loc-1', 'open-air', 'Bar', { address: 'Halle 3' })]
              : [zone('loc-2', 'dub', 'Bar', { address: 'The club' })],
        }),
    );
    const { wrapper } = await mountView('/org-1/festivals/festival-1/missions');
    await openCard(wrapper);

    const varies = wrapper.find('.evp-varies');
    expect(varies.text()).toContain('Halle 3');
    expect(varies.text()).toContain('The club');
    expect(wrapper.find('.evp-mission input[type="text"]').exists()).toBe(true);
    // Name, exact address, coordinates and both volunteer bounds all agree
    // (none of them is set on either day) and show a box; only the address
    // that genuinely disagrees stays hidden behind the "varies" list.
    expect(wrapper.findAll('.evp-mission input[type="text"]')).toHaveLength(5);
  });

  it('gives one box once the coordinator asks to unify the field', async () => {
    vi.spyOn(locations, 'fetchLocations').mockImplementation(
      (_orgId, eventId) =>
        Promise.resolve({
          ok: true,
          value:
            eventId === 'open-air'
              ? [zone('loc-1', 'open-air', 'Bar', { address: 'Halle 3' })]
              : [zone('loc-2', 'dub', 'Bar', { address: 'The club' })],
        }),
    );
    const { wrapper } = await mountView('/org-1/festivals/festival-1/missions');
    await openCard(wrapper);

    await wrapper.find('.evp-mission .evp-button--quiet').trigger('click');

    // Unifying the address adds its box to the five that already agreed.
    expect(wrapper.findAll('.evp-mission input[type="text"]')).toHaveLength(6);
  });
});

describe('PlanMissionsView — adding and removing', () => {
  it('creates the mission on every day of the festival', async () => {
    const create = vi
      .spyOn(locations, 'createLocation')
      .mockImplementation((_org, eventId) =>
        Promise.resolve({
          ok: true,
          location: zone('new', eventId, 'Accueil'),
        }),
      );

    const { wrapper } = await mountView('/org-1/festivals/festival-1/missions');
    await wrapper.find('.evp-add button').trigger('click');
    await wrapper.find('#evp-new-mission-name').setValue('Accueil');
    await wrapper.find('#evp-new-mission-address').setValue('Grille nord');
    await wrapper.find('.evp-add form').trigger('submit');
    await flushPromises();

    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledWith('org-1', 'open-air', {
      kind: 'zone',
      name: 'Accueil',
      address: 'Grille nord',
    });
    expect(create).toHaveBeenCalledWith('org-1', 'dub', {
      kind: 'zone',
      name: 'Accueil',
      address: 'Grille nord',
    });
  });

  it('creates it on the one day at event scope', async () => {
    const create = vi
      .spyOn(locations, 'createLocation')
      .mockImplementation((_org, eventId) =>
        Promise.resolve({
          ok: true,
          location: zone('new', eventId, 'Accueil'),
        }),
      );

    const { wrapper } = await mountView('/org-1/events/dub/missions');
    await wrapper.find('.evp-add button').trigger('click');
    await wrapper.find('#evp-new-mission-name').setValue('Accueil');
    await wrapper.find('.evp-add form').trigger('submit');
    await flushPromises();

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith('org-1', 'dub', {
      kind: 'zone',
      name: 'Accueil',
    });
  });

  /** One duplicate would otherwise come back as one 409 per day. */
  it('refuses a duplicate name without asking the server', async () => {
    const create = vi.spyOn(locations, 'createLocation');
    const { wrapper } = await mountView('/org-1/festivals/festival-1/missions');

    await wrapper.find('.evp-add button').trigger('click');
    await wrapper.find('#evp-new-mission-name').setValue('  bar ');
    await wrapper.find('.evp-add form').trigger('submit');
    await flushPromises();

    expect(create).not.toHaveBeenCalled();
    expect(wrapper.find('.evp-add .evp-error').text()).toContain(
      'already has a mission with that name',
    );
  });

  it('deletes every day’s row, each against its own version', async () => {
    const remove = vi
      .spyOn(locations, 'deleteLocation')
      .mockResolvedValue({ ok: true });

    const { wrapper } = await mountView('/org-1/festivals/festival-1/missions');
    await wrapper
      .find('.evp-mission .evp-icon-button--danger')
      .trigger('click');
    await wrapper.find('.evp-confirm-destroy').trigger('click');
    await flushPromises();

    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledWith('org-1', 'open-air', 'loc-open-air', 3);
    expect(remove).toHaveBeenCalledWith('org-1', 'dub', 'loc-dub', 7);
    expect(
      wrapper.find('.evp-confirm-dialog').attributes('open'),
    ).toBeUndefined();
  });

  /** The trash button asks; it does not act, and it does not reshape the
   * card it sits on. */
  it('asks in a dialog, and cancelling sends nothing', async () => {
    const remove = vi.spyOn(locations, 'deleteLocation');
    const { wrapper } = await mountView('/org-1/festivals/festival-1/missions');

    const dialog = wrapper.find('.evp-confirm-dialog');
    expect(dialog.attributes('open')).toBeUndefined();

    await wrapper
      .find('.evp-mission .evp-icon-button--danger')
      .trigger('click');
    expect(dialog.attributes('open')).toBe('');
    expect(dialog.attributes('role')).toBe('alertdialog');

    await dialog.findAll('button')[0]?.trigger('click');
    expect(dialog.attributes('open')).toBeUndefined();
    expect(remove).not.toHaveBeenCalled();
  });

  /** A partial removal is reported where it was asked for, and the dialog
   * stays up rather than closing on a half-done job. */
  it('keeps the dialog open and names the days a removal did not reach', async () => {
    vi.spyOn(locations, 'deleteLocation').mockImplementation((_org, eventId) =>
      Promise.resolve(
        eventId === 'dub'
          ? {
              ok: false,
              rejection: {
                reason: 'conflict',
                detail: 'Somebody else changed it.',
              },
            }
          : { ok: true },
      ),
    );
    const { wrapper } = await mountView('/org-1/festivals/festival-1/missions');

    await wrapper
      .find('.evp-mission .evp-icon-button--danger')
      .trigger('click');
    await wrapper.find('.evp-confirm-destroy').trigger('click');
    await flushPromises();

    const dialog = wrapper.find('.evp-confirm-dialog');
    expect(dialog.attributes('open')).toBe('');
    const error = dialog.find('.evp-confirm-error').text();
    expect(error).toContain('1 of 2 days were removed');
    expect(error).toContain('Dub & 2step');
  });

  /** The cascade is not obvious and not reversible, so the confirmation says
   * what goes with it and which days it reaches. */
  it('says which days a removal covers before it happens', async () => {
    const { wrapper } = await mountView('/org-1/festivals/festival-1/missions');
    await wrapper
      .find('.evp-mission .evp-icon-button--danger')
      .trigger('click');

    const confirm = wrapper.find('.evp-confirm').text();
    expect(confirm).toContain('Open Air');
    expect(confirm).toContain('Dub & 2step');
    expect(confirm).toContain('every shift already cut on it');
  });
});

/** A zone that already has a post nested under it, on both days — the
 * fixture the hierarchy, add-post and cascade-warning tests all build on. */
function barZoneWithPost(): void {
  vi.spyOn(locations, 'fetchLocations').mockImplementation((_orgId, eventId) =>
    Promise.resolve({
      ok: true,
      value:
        eventId === 'open-air'
          ? [
              zone('loc-open-air', 'open-air', 'Bar', {
                version: 3,
                posts: [
                  post('post-open-air', 'open-air', 'loc-open-air', 'Till'),
                ],
              }),
            ]
          : [
              zone('loc-dub', 'dub', 'Bar', {
                version: 7,
                posts: [post('post-dub', 'dub', 'loc-dub', 'Till')],
              }),
            ],
    }),
  );
}

describe('PlanMissionsView — zone/post hierarchy', () => {
  it('groups a post under its zone, visibly indented, and tags each by kind', async () => {
    barZoneWithPost();
    const { wrapper } = await mountView('/org-1/festivals/festival-1/missions');

    const cards = wrapper.findAll('.evp-mission');
    expect(cards).toHaveLength(2);
    expect(cards[0]?.find('h3').text()).toContain('Bar');
    expect(cards[0]?.find('.evp-tag--kind').text()).toBe('Zone');

    const nested = wrapper.find('.evp-posts');
    expect(nested.exists()).toBe(true);
    const postCard = nested.find('.evp-mission');
    expect(postCard.find('h3').text()).toContain('Till');
    expect(postCard.find('.evp-tag--kind').text()).toBe('Post');
  });

  it('lets a coordinator add a post under an existing zone, fanned out over the zone’s own days', async () => {
    barZoneWithPost();
    const create = vi
      .spyOn(locations, 'createLocation')
      .mockImplementation((_org, eventId) =>
        Promise.resolve({
          ok: true,
          location: post('new-post', eventId, 'loc', 'Cash register'),
        }),
      );

    const { wrapper } = await mountView('/org-1/festivals/festival-1/missions');
    await wrapper.find('.evp-add-post button').trigger('click');
    await wrapper
      .find('.evp-add-post #evp-new-post-loc-open-air-name')
      .setValue('Cash register');
    await wrapper.find('.evp-add-post form').trigger('submit');
    await flushPromises();

    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledWith('org-1', 'open-air', {
      kind: 'post',
      name: 'Cash register',
      parentId: 'loc-open-air',
    });
    expect(create).toHaveBeenCalledWith('org-1', 'dub', {
      kind: 'post',
      name: 'Cash register',
      parentId: 'loc-dub',
    });
  });

  it('deletes a single post without warning about further cascade', async () => {
    barZoneWithPost();
    const remove = vi
      .spyOn(locations, 'deleteLocation')
      .mockResolvedValue({ ok: true });

    const { wrapper } = await mountView('/org-1/festivals/festival-1/missions');
    const postCard = wrapper.find('.evp-posts .evp-mission');
    await postCard.find('.evp-icon-button--danger').trigger('click');

    const confirm = postCard.find('.evp-confirm').text();
    expect(confirm).toContain('Till');
    expect(confirm).not.toContain('nested under it');

    await postCard.find('.evp-confirm-destroy').trigger('click');
    await flushPromises();

    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledWith(
      'org-1',
      'open-air',
      'post-open-air',
      1,
    );
    expect(remove).toHaveBeenCalledWith('org-1', 'dub', 'post-dub', 1);
  });

  /** The incident this page exists to stop happening again: deleting a zone
   * cascades to every post nested under it, and that has to be said before
   * the button is pressed. */
  it('names the nested posts before deleting a zone that holds them', async () => {
    barZoneWithPost();
    const { wrapper } = await mountView('/org-1/festivals/festival-1/missions');

    const zoneCard = wrapper.findAll('.evp-mission')[0];
    expect(zoneCard).toBeDefined();
    if (zoneCard === undefined) {
      return;
    }
    await zoneCard.find('.evp-icon-button--danger').trigger('click');

    const confirm = zoneCard.find('.evp-confirm').text();
    expect(confirm).toContain('1 post nested under it');
    expect(confirm).toContain('Till');
  });
});

describe('PlanMissionsView — condensed cards and volunteer bounds', () => {
  /** A dozen open forms was a dozen screens; closed, a card is one summary
   * line and the form is one press away. */
  it('starts every card collapsed, with a one-line summary', async () => {
    vi.spyOn(locations, 'fetchLocations').mockImplementation(
      (_orgId, eventId) =>
        Promise.resolve({
          ok: true,
          value: [
            {
              ...zone(`loc-${eventId}`, eventId, 'Bar', {
                description: 'Serving and glass return.',
                address: 'Halle 3',
              }),
              min_volunteers: 2,
              max_volunteers: 5,
            },
          ],
        }),
    );
    const { wrapper } = await mountView('/org-1/festivals/festival-1/missions');

    const card = wrapper.find('.evp-mission');
    expect(card.find('form').exists()).toBe(false);
    const toggle = card.find('.evp-mission-toggle');
    expect(toggle.attributes('aria-expanded')).toBe('false');

    const summary = card.find('.evp-summary').text();
    expect(summary).toContain('Serving and glass return.');
    expect(summary).toContain('Halle 3');
    expect(summary).toContain('2–5 volunteers');

    await toggle.trigger('click');
    expect(toggle.attributes('aria-expanded')).toBe('true');
    expect(card.find('form').exists()).toBe(true);
    expect(card.find('.evp-summary').exists()).toBe(false);
  });

  it('says a collapsed card is holding unsaved edits', async () => {
    const { wrapper } = await mountView('/org-1/festivals/festival-1/missions');
    await openCard(wrapper);
    await wrapper.find('.evp-mission textarea').setValue('Serving.');
    await openCard(wrapper);

    expect(wrapper.find('.evp-tag--unsaved').exists()).toBe(true);
  });

  it('creates a zone with its volunteer bounds', async () => {
    const create = vi
      .spyOn(locations, 'createLocation')
      .mockImplementation((_org, eventId) =>
        Promise.resolve({
          ok: true,
          location: zone('new', eventId, 'Accueil'),
        }),
      );

    const { wrapper } = await mountView('/org-1/events/dub/missions');
    await wrapper.find('.evp-add button').trigger('click');
    await wrapper.find('#evp-new-mission-name').setValue('Accueil');
    await wrapper.find('#evp-new-mission-min-volunteers').setValue('2');
    await wrapper.find('#evp-new-mission-max-volunteers').setValue('4');
    await wrapper.find('.evp-add form').trigger('submit');
    await flushPromises();

    expect(create).toHaveBeenCalledWith('org-1', 'dub', {
      kind: 'zone',
      name: 'Accueil',
      minVolunteers: 2,
      maxVolunteers: 4,
    });
  });

  it('refuses a maximum below the minimum without asking the server', async () => {
    const create = vi.spyOn(locations, 'createLocation');
    const { wrapper } = await mountView('/org-1/events/dub/missions');

    await wrapper.find('.evp-add button').trigger('click');
    await wrapper.find('#evp-new-mission-name').setValue('Accueil');
    await wrapper.find('#evp-new-mission-min-volunteers').setValue('5');
    await wrapper.find('#evp-new-mission-max-volunteers').setValue('3');
    await wrapper.find('.evp-add form').trigger('submit');
    await flushPromises();

    expect(create).not.toHaveBeenCalled();
    expect(wrapper.find('.evp-add .evp-error').text()).toContain(
      'maximum cannot be lower than the minimum',
    );
  });

  it('patches the bounds on every day', async () => {
    const patch = vi
      .spyOn(locations, 'patchLocation')
      .mockImplementation((_org, _event, id) =>
        Promise.resolve({ ok: true, location: zone(id, 'open-air', 'Bar') }),
      );

    const { wrapper } = await mountView('/org-1/festivals/festival-1/missions');
    await openCard(wrapper);
    await wrapper
      .find('#evp-mission-loc-open-air-max-volunteers')
      .setValue('6');
    await wrapper.find('.evp-mission form').trigger('submit');
    await flushPromises();

    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch).toHaveBeenCalledWith('org-1', 'dub', 'loc-dub', 7, {
      maxVolunteers: 6,
    });
  });
});

describe('PlanMissionsView — how the volunteer form offers a mission', () => {
  function checkbox(wrapper: VueWrapper, name: string) {
    return wrapper.find<HTMLInputElement>(`#evp-mission-loc-open-air-${name}`);
  }

  it('says on the collapsed card that a mission is 18+ and not pre-ticked', async () => {
    vi.spyOn(locations, 'fetchLocations').mockImplementation(
      (_orgId, eventId) =>
        Promise.resolve({
          ok: true,
          value: [
            zone(`loc-${eventId}`, eventId, 'Bar', {
              checkedByDefault: false,
              adultsOnly: true,
            }),
          ],
        }),
    );
    const { wrapper } = await mountView('/org-1/festivals/festival-1/missions');

    const summary = wrapper.find('.evp-summary').text();
    expect(summary).toContain('18+');
    expect(summary).toContain('Not ticked by default');
  });

  it('says nothing about an ordinary mission', async () => {
    const { wrapper } = await mountView('/org-1/festivals/festival-1/missions');
    expect(wrapper.find('.evp-summary-flag').exists()).toBe(false);
  });

  it('creates a zone that asks for an explicit tick and is for adults', async () => {
    const create = vi
      .spyOn(locations, 'createLocation')
      .mockImplementation((_org, eventId) =>
        Promise.resolve({
          ok: true,
          location: zone('new', eventId, 'Son'),
        }),
      );

    const { wrapper } = await mountView('/org-1/events/dub/missions');
    await wrapper.find('.evp-add button').trigger('click');
    await wrapper.find('#evp-new-mission-name').setValue('Son');
    await wrapper.find('#evp-new-mission-checked-by-default').setValue(false);
    await wrapper.find('#evp-new-mission-adults-only').setValue(true);
    await wrapper.find('.evp-add form').trigger('submit');
    await flushPromises();

    expect(create).toHaveBeenCalledWith('org-1', 'dub', {
      kind: 'zone',
      name: 'Son',
      checkedByDefault: false,
      adultsOnly: true,
    });
  });

  it('patches a flag on every day', async () => {
    const patch = vi
      .spyOn(locations, 'patchLocation')
      .mockImplementation((_org, _event, id) =>
        Promise.resolve({ ok: true, location: zone(id, 'open-air', 'Bar') }),
      );

    const { wrapper } = await mountView('/org-1/festivals/festival-1/missions');
    await openCard(wrapper);
    expect(checkbox(wrapper, 'checked-by-default').element.checked).toBe(true);
    await checkbox(wrapper, 'adults-only').setValue(true);
    await wrapper.find('.evp-mission form').trigger('submit');
    await flushPromises();

    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch).toHaveBeenCalledWith('org-1', 'open-air', 'loc-open-air', 3, {
      adultsOnly: true,
    });
    expect(patch).toHaveBeenCalledWith('org-1', 'dub', 'loc-dub', 7, {
      adultsOnly: true,
    });
  });

  it('shows a flag the days disagree about as indeterminate, and sends it once picked', async () => {
    vi.spyOn(locations, 'fetchLocations').mockImplementation(
      (_orgId, eventId) =>
        Promise.resolve({
          ok: true,
          value: [
            zone(`loc-${eventId}`, eventId, 'Bar', {
              checkedByDefault: eventId === 'open-air',
            }),
          ],
        }),
    );
    const patch = vi
      .spyOn(locations, 'patchLocation')
      .mockImplementation((_org, _event, id) =>
        Promise.resolve({ ok: true, location: zone(id, 'open-air', 'Bar') }),
      );

    const { wrapper } = await mountView('/org-1/festivals/festival-1/missions');
    expect(wrapper.find('.evp-summary').text()).toContain(
      'Ticked by default on some days',
    );
    await openCard(wrapper);

    const box = checkbox(wrapper, 'checked-by-default');
    expect(box.element.indeterminate).toBe(true);
    expect(wrapper.find('.evp-flag .evp-varies').text()).toContain('Open Air');

    // Nothing picked yet: the save has nothing to send.
    expect(
      wrapper.find('.evp-mission form button[type="submit"]').attributes(),
    ).toHaveProperty('disabled');

    await box.setValue(true);
    await wrapper.find('.evp-mission form').trigger('submit');
    await flushPromises();

    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch).toHaveBeenCalledWith('org-1', 'dub', 'loc-dub', 1, {
      checkedByDefault: true,
    });
  });

  it('offers neither box on a post, which takes its zone’s', async () => {
    barZoneWithPost();
    const { wrapper } = await mountView('/org-1/festivals/festival-1/missions');
    await openCard(wrapper, 1);

    const postCard = wrapper.findAll('.evp-mission')[1];
    expect(postCard?.find('form').exists()).toBe(true);
    expect(postCard?.find('input[type="checkbox"]').exists()).toBe(false);
  });
});
