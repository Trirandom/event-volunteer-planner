// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The details section, mounted through the router.
 *
 * Several claims are worth a component test rather than leaving to
 * `eventDraft`'s unit tests and the e2e suite. The scope rule — one row per day
 * at festival scope, one at day scope — is the whole reason this section exists
 * at both URLs. Saving without a button and Ctrl+Z (ADR-0051) are wiring
 * between the rows and the page that no unit test sees. And the redirect after a delete is a *race*: the mutation invalidates
 * the queries this page reads, so a handler that looks the festival up in live
 * state after the delete finds nothing and sends the coordinator to the wrong
 * page. That one was a real bug, found in a browser, and it is silent in every
 * test that does not actually delete something.
 */
import { eventColorChoiceCount } from '@evp/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as eventsApi from '../api/events';
import * as events from '../api/events';
import type * as festivalsApi from '../api/festivals';
import * as festivals from '../api/festivals';
import * as sessionApi from '../api/session';
import { AUTOSAVE_DELAY_MS } from '../plan/useAutosave';
import PlanDetailsView from './PlanDetailsView.vue';

function session(role: string): sessionApi.Session {
  return {
    status: 'authenticated',
    user: {
      id: 'user-1',
      email: 'coordinator@example.org',
      display_name: 'Coordinator',
      locale: 'en',
      memberships: [{ org_id: 'org-1', slug: 'org-1', name: 'Org One', role }],
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

function testRouter(): Router {
  const section = (scope: 'festival' | 'event') => ({
    path: 'details',
    name: `org-${scope}-details`,
    component: PlanDetailsView,
  });

  return createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/:orgId/events',
        name: 'org-events',
        component: { template: '<p>events list</p>' },
      },
      {
        path: '/:orgId/festivals/:festivalId',
        component: { template: '<RouterView />' },
        children: [section('festival')],
      },
      {
        path: '/:orgId/events/:eventId',
        component: { template: '<RouterView />' },
        children: [section('event')],
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
  vi.spyOn(sessionApi, 'fetchSession').mockResolvedValue(session('owner'));
  vi.spyOn(festivals, 'fetchFestival').mockResolvedValue({
    ok: true,
    value: festival([event(), DUB]),
  });
  vi.spyOn(events, 'fetchEvent').mockResolvedValue({
    ok: true,
    value: DUB,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PlanDetailsView', () => {
  it('shows one row per day at festival scope', async () => {
    const { wrapper } = await mountView('/org-1/festivals/festival-1/details');

    const headings = wrapper.findAll('.evp-event h3').map((h) => h.text());
    expect(headings).toEqual(['Open Air', 'Dub & 2step']);
  });

  /** The production's dates live with the rest of its settings, once,
   * rather than above every section of the page. */
  it('dates the festival above its days', async () => {
    const { wrapper } = await mountView('/org-1/festivals/festival-1/details');

    expect(wrapper.find('.evp-period').text()).toContain('2026');
  });

  it('shows only the selected day at event scope', async () => {
    const { wrapper } = await mountView('/org-1/events/dub/details');

    const headings = wrapper.findAll('.evp-event h3').map((h) => h.text());
    expect(headings).toEqual(['Dub & 2step']);
  });

  it('seeds the fields from the stored event, in its own zone', async () => {
    const { wrapper } = await mountView('/org-1/events/dub/details');

    const inputs = wrapper.findAll<HTMLInputElement>(
      'input[type="datetime-local"]',
    );
    expect(inputs[0]?.element.value).toBe('2026-08-02T20:00');
    expect(inputs[1]?.element.value).toBe('2026-08-03T08:00');
    // Nobody has published door times, so the fields are empty rather than
    // pre-filled from the working hours.
    expect(inputs[2]?.element.value).toBe('');
    expect(inputs[3]?.element.value).toBe('');
  });

  it('offers the sixteen choosable colours, with the stored one chosen', async () => {
    const { wrapper } = await mountView('/org-1/events/dub/details');

    const radios = wrapper.findAll<HTMLInputElement>('input[type="radio"]');
    expect(radios).toHaveLength(eventColorChoiceCount);
    expect(radios[1]?.element.checked).toBe(true);
  });

  /**
   * The column still admits 64 and the server still allocates out of all of
   * them, so an event can arrive holding a colour the picker no longer
   * offers. It gets a seventeenth swatch rather than a row with nothing
   * ticked — without it, saving a change to the hours would move the event to
   * whatever colour happened to be selected instead.
   */
  it('keeps a colour outside the offered range selectable', async () => {
    vi.spyOn(events, 'fetchEvent').mockResolvedValue({
      ok: true,
      value: event({ id: 'dub', color: 40 }),
    });
    const { wrapper } = await mountView('/org-1/events/dub/details');

    const radios = wrapper.findAll<HTMLInputElement>('input[type="radio"]');
    expect(radios).toHaveLength(eventColorChoiceCount + 1);
    expect(radios[eventColorChoiceCount]?.element.checked).toBe(true);
  });

  /** Deleting is owner work (docs/04 §4), so a coordinator is not shown a
   * button whose only possible answer is `403`. */
  it('hides the delete button from a coordinator', async () => {
    vi.spyOn(sessionApi, 'fetchSession').mockResolvedValue(
      session('coordinator'),
    );
    const { wrapper } = await mountView('/org-1/events/dub/details');

    expect(wrapper.find('.evp-icon-button--danger').exists()).toBe(false);
  });

  /**
   * The race. `useDeleteEvent` invalidates the queries this page reads, so by
   * the time the redirect runs, "which festival was that?" cannot be asked of
   * live state — it has to come from the event that was deleted. Reading it
   * from `scope` sent every deletion to the events list instead.
   */
  it('returns to the festival after deleting one of its days', async () => {
    vi.spyOn(events, 'deleteEvent').mockResolvedValue({ ok: true });
    const { wrapper, router } = await mountView('/org-1/events/dub/details');

    await wrapper.find('.evp-icon-button--danger').trigger('click');
    await wrapper.find('.evp-confirm-destroy').trigger('click');
    await flushPromises();

    expect(router.currentRoute.value.path).toBe(
      '/org-1/festivals/festival-1/details',
    );
  });

  it('returns to the events list after deleting a standalone event', async () => {
    const standalone = event({ id: 'solo', festival_id: null, name: 'Solo' });
    vi.spyOn(events, 'fetchEvent').mockResolvedValue({
      ok: true,
      value: standalone,
    });
    vi.spyOn(events, 'deleteEvent').mockResolvedValue({ ok: true });
    const { wrapper, router } = await mountView('/org-1/events/solo/details');

    await wrapper.find('.evp-icon-button--danger').trigger('click');
    await wrapper.find('.evp-confirm-destroy').trigger('click');
    await flushPromises();

    expect(router.currentRoute.value.path).toBe('/org-1/events');
  });

  it('asserts the row version it rendered when saving', async () => {
    const patch = vi
      .spyOn(events, 'patchEventDetails')
      .mockResolvedValue({ ok: true, event: { ...DUB, color: 9, version: 2 } });
    const { wrapper } = await mountView('/org-1/events/dub/details');

    await wrapper
      .findAll<HTMLInputElement>('input[type="radio"]')[9]
      ?.setValue();
    await wrapper.find('.evp-event form').trigger('submit');
    await flushPromises();

    expect(patch).toHaveBeenCalledWith('org-1', 'dub', 1, { color: 9 });
  });
});

describe('PlanDetailsView — the list', () => {
  /** "Exactly like missions": the add button is the first thing under the
   * page's toolbar, not below the last day. */
  it('puts the add form above the days', async () => {
    const { wrapper } = await mountView('/org-1/festivals/festival-1/details');

    const order = wrapper
      .findAll('.evp-add, .evp-event-list')
      .map((element) => element.classes()[0]);
    expect(order).toEqual(['evp-add', 'evp-event-list']);
  });

  /** A festival's days read as a column; six open forms would bury it. */
  it('lists a festival closed, and opens a row from its name', async () => {
    const { wrapper } = await mountView('/org-1/festivals/festival-1/details');
    expect(wrapper.findAll('input[type="datetime-local"]')).toHaveLength(0);

    await wrapper.findAll('.evp-event-toggle')[1]?.trigger('click');

    expect(wrapper.findAll('input[type="datetime-local"]')).toHaveLength(4);
    expect(
      wrapper.findAll('.evp-event-toggle')[1]?.attributes('aria-expanded'),
    ).toBe('true');
  });

  it('opens a row from anywhere on its line, not only its name', async () => {
    const { wrapper } = await mountView('/org-1/festivals/festival-1/details');

    await wrapper.findAll('.evp-summary')[1]?.trigger('click');

    expect(
      wrapper.findAll('.evp-event-toggle')[1]?.attributes('aria-expanded'),
    ).toBe('true');
    expect(wrapper.findAll('input[type="datetime-local"]')).toHaveLength(4);
  });

  /** The bin asks its own question; it must not also fold the row. */
  it('leaves the row as it is when its delete button is pressed', async () => {
    const { wrapper } = await mountView('/org-1/festivals/festival-1/details');

    await wrapper.findAll('.evp-icon-button--danger')[0]?.trigger('click');

    expect(
      wrapper.findAll('.evp-event-toggle')[0]?.attributes('aria-expanded'),
    ).toBe('false');
  });

  /** The closed row says what the open one would: hours, and doors. */
  it('summarises each day on its closed row', async () => {
    const { wrapper } = await mountView('/org-1/festivals/festival-1/details');

    const summary = wrapper.findAll('.evp-summary')[0]?.text() ?? '';
    expect(summary).toContain('10:00');
    expect(summary).toContain('No door times published');
  });
});

describe('PlanDetailsView — saving as it goes, and undo', () => {
  function pressKeys(init: KeyboardEventInit): void {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, ...init }),
    );
  }

  /** A server that keeps what it is sent, so a refetch after a save reads
   * the saved row back, as the real one does. */
  function storingServer(initial: eventsApi.Event) {
    let stored = initial;
    vi.spyOn(events, 'fetchEvent').mockImplementation(() =>
      Promise.resolve({ ok: true, value: stored }),
    );
    return vi
      .spyOn(events, 'patchEventDetails')
      .mockImplementation((_org, _event, version, changes) => {
        stored = {
          ...stored,
          ...(changes.color === undefined ? {} : { color: changes.color }),
          version: version + 1,
        };
        return Promise.resolve({ ok: true, event: stored });
      });
  }

  it('has no save button: an edit is sent once it settles', async () => {
    const patch = storingServer(DUB);
    const { wrapper } = await mountView('/org-1/events/dub/details');
    expect(wrapper.find('.evp-event button[type="submit"]').exists()).toBe(
      false,
    );

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await wrapper
        .findAll<HTMLInputElement>('input[type="radio"]')[4]
        ?.setValue();
      expect(patch).not.toHaveBeenCalled();
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);
    } finally {
      vi.useRealTimers();
    }
    await flushPromises();

    expect(patch).toHaveBeenCalledWith('org-1', 'dub', 1, { color: 4 });
    expect(wrapper.find('.evp-toolbar-status').text()).toBe(
      'Everything is saved',
    );
  });

  /** The undo is a forward write: the next PATCH asserts the version the
   * first save produced, not the one the page first rendered. */
  it('Ctrl+Z puts the colour back, and that is saved like any edit', async () => {
    const patch = storingServer(DUB);
    const { wrapper } = await mountView('/org-1/events/dub/details');
    await wrapper
      .findAll<HTMLInputElement>('input[type="radio"]')[4]
      ?.setValue();
    await wrapper.find('.evp-event form').trigger('submit');
    await flushPromises();
    patch.mockClear();

    pressKeys({ key: 'z', ctrlKey: true });
    await flushPromises();
    expect(
      wrapper.findAll<HTMLInputElement>('input[type="radio"]')[1]?.element
        .checked,
    ).toBe(true);
    expect(wrapper.find('[role="status"].evp-visually-hidden').text()).toBe(
      'Change undone.',
    );

    await wrapper.find('.evp-event form').trigger('submit');
    await flushPromises();
    expect(patch).toHaveBeenCalledWith('org-1', 'dub', 2, { color: 1 });
  });

  it('redoes what was undone', async () => {
    storingServer(DUB);
    const { wrapper } = await mountView('/org-1/events/dub/details');
    await wrapper
      .findAll<HTMLInputElement>('input[type="radio"]')[4]
      ?.setValue();

    pressKeys({ key: 'z', ctrlKey: true });
    await flushPromises();
    pressKeys({ key: 'z', ctrlKey: true, shiftKey: true });
    await flushPromises();

    expect(
      wrapper.findAll<HTMLInputElement>('input[type="radio"]')[4]?.element
        .checked,
    ).toBe(true);
  });

  /** A draft the server would refuse is not sent, and the page says one
   * event is unsaved instead of claiming everything is. */
  it('holds back a draft that ends before it starts, and says so', async () => {
    const patch = storingServer(DUB);
    const { wrapper } = await mountView('/org-1/events/dub/details');

    await wrapper.find('#evp-dub-end').setValue('2026-08-02T19:00');
    await wrapper.find('.evp-event form').trigger('submit');
    await flushPromises();

    expect(patch).not.toHaveBeenCalled();
    expect(wrapper.find('.evp-event .evp-error').text()).toContain(
      'end after it starts',
    );
    expect(wrapper.find('.evp-toolbar-status').text()).toContain(
      'One event is not saved',
    );
  });

  /** The closed row is where a blocked edit would otherwise be forgotten. */
  it('marks a closed row whose edit cannot be saved', async () => {
    storingServer(DUB);
    const { wrapper } = await mountView('/org-1/events/dub/details');

    await wrapper.find('#evp-dub-end').setValue('2026-08-02T19:00');
    await wrapper.find('.evp-event-toggle').trigger('click');

    expect(wrapper.find('.evp-tag--unsaved').text()).toBe('Not saved');
  });
});

/**
 * Adding a day from the page that is already about the production. The point
 * of the form being here rather than only on the events list is that the
 * festival is *not* asked for — so what it sends, and to which festival, is
 * the part worth a test.
 */
describe('adding a day from the details section', () => {
  async function openAddForm(path: string) {
    const { wrapper } = await mountView(path);
    await wrapper.find('.evp-add button').trigger('click');
    return wrapper;
  }

  it('offers the form at festival scope', async () => {
    const wrapper = await openAddForm('/org-1/festivals/festival-1/details');

    expect(wrapper.find('.evp-add h3').text()).toBe('New day');
  });

  it('fills the slug in from the name', async () => {
    const wrapper = await openAddForm('/org-1/festivals/festival-1/details');

    await wrapper.find('#evp-new-event-name').setValue('Samedi 1er août');

    expect(
      wrapper.find<HTMLInputElement>('#evp-new-event-slug').element.value,
    ).toBe('samedi-1er-aout');
  });

  it('defaults the zone to the festival it is adding to', async () => {
    const wrapper = await openAddForm('/org-1/festivals/festival-1/details');

    expect(
      wrapper.find<HTMLInputElement>('#evp-new-event-timezone').element.value,
    ).toBe('Europe/Paris');
  });

  /** The whole reason this form is not the events list's: the festival comes
   * from the page, and the times are read in the festival's own zone. */
  it('posts the new day into the festival the page is about', async () => {
    const create = vi.spyOn(events, 'createEvent').mockResolvedValue({
      ok: true,
      event: event({ id: 'new', name: 'Samedi' }),
      operationId: 'op-1',
    });
    const wrapper = await openAddForm('/org-1/festivals/festival-1/details');

    await wrapper.find('#evp-new-event-name').setValue('Samedi');
    await wrapper.find('#evp-new-event-start').setValue('2026-08-05T10:00');
    await wrapper.find('#evp-new-event-end').setValue('2026-08-06T04:00');
    await wrapper.find('.evp-add form').trigger('submit');
    await flushPromises();

    expect(create).toHaveBeenCalledWith('org-1', {
      name: 'Samedi',
      slug: 'samedi',
      timezone: 'Europe/Paris',
      period: {
        start: '2026-08-05T08:00:00Z',
        end: '2026-08-06T02:00:00Z',
      },
      festivalId: 'festival-1',
    });
  });

  /** Narrowed to one day, adding still adds to the festival — a day cannot
   * contain a day. */
  it('adds to the festival even when narrowed to one of its days', async () => {
    const wrapper = await openAddForm('/org-1/events/dub/details');

    expect(wrapper.find('.evp-add .evp-hint').text()).toContain(
      'Soundclash 26',
    );
  });

  /** A slug already in use is refused before the round trip that would come
   * back as a 409 — and the days are known to this page, so it can. */
  it('refuses a slug one of the days already has', async () => {
    const create = vi.spyOn(events, 'createEvent');
    const wrapper = await openAddForm('/org-1/festivals/festival-1/details');

    await wrapper.find('#evp-new-event-name').setValue('Dub 2step');
    await wrapper.find('#evp-new-event-slug').setValue('dub-2step');
    await wrapper.find('#evp-new-event-start').setValue('2026-08-05T10:00');
    await wrapper.find('#evp-new-event-end').setValue('2026-08-06T04:00');
    await wrapper.find('.evp-add form').trigger('submit');
    await flushPromises();

    expect(create).not.toHaveBeenCalled();
    expect(wrapper.find('.evp-add .evp-error').text()).toContain(
      'already has a day with that slug',
    );
  });

  /** A standalone event has no festival to add to, so the new event is
   * standalone too — and the key is omitted rather than sent as null. */
  it('creates another standalone event beside a standalone one', async () => {
    const standalone = event({ id: 'solo', festival_id: null, name: 'Solo' });
    vi.spyOn(events, 'fetchEvent').mockResolvedValue({
      ok: true,
      value: standalone,
    });
    const create = vi.spyOn(events, 'createEvent').mockResolvedValue({
      ok: true,
      event: event({ id: 'new', name: 'Solo 2', festival_id: null }),
      operationId: 'op-1',
    });
    const wrapper = await openAddForm('/org-1/events/solo/details');

    await wrapper.find('#evp-new-event-name').setValue('Solo 2');
    await wrapper.find('#evp-new-event-start').setValue('2026-08-05T10:00');
    await wrapper.find('#evp-new-event-end').setValue('2026-08-05T23:00');
    await wrapper.find('.evp-add form').trigger('submit');
    await flushPromises();

    const body = create.mock.calls[0]?.[1];
    expect(body).not.toHaveProperty('festivalId');
    expect(body?.name).toBe('Solo 2');
  });
});

describe('deleting the festival (ADR-0053)', () => {
  beforeEach(() => {
    vi.spyOn(festivals, 'fetchFestivalDeletion').mockResolvedValue({
      ok: true,
      value: { events: 2, forms: 1, submissions: 27 },
    });
  });

  /** The dialog whose name field asks for the festival's name. */
  function festivalDialog(
    wrapper: Awaited<ReturnType<typeof mountView>>['wrapper'],
  ) {
    const dialog = wrapper
      .findAll('dialog')
      .find((candidate) =>
        candidate.find('.evp-festival-delete-name').exists(),
      );
    if (dialog === undefined) {
      throw new Error('the festival delete dialog is not open');
    }
    return dialog;
  }

  async function openIt() {
    const mounted = await mountView('/org-1/festivals/festival-1/details');
    await mounted.wrapper.find('.evp-festival-delete-button').trigger('click');
    await flushPromises();
    return mounted;
  }

  it('is offered to an owner on the festival as a whole', async () => {
    const { wrapper } = await mountView('/org-1/festivals/festival-1/details');

    expect(wrapper.find('.evp-festival-delete-button').exists()).toBe(true);
  });

  /** Narrowed to one day the button would read as deleting that day. */
  it('is not offered when the page is narrowed to one day', async () => {
    const { wrapper } = await mountView('/org-1/events/dub/details');

    expect(wrapper.find('.evp-festival-delete-button').exists()).toBe(false);
  });

  it('is not offered to a coordinator, whose only answer would be 403', async () => {
    vi.spyOn(sessionApi, 'fetchSession').mockResolvedValue(
      session('coordinator'),
    );
    const { wrapper } = await mountView('/org-1/festivals/festival-1/details');

    expect(wrapper.find('.evp-festival-delete-button').exists()).toBe(false);
  });

  it('counts the cost when it opens, and says the events stay', async () => {
    const { wrapper } = await openIt();

    expect(festivals.fetchFestivalDeletion).toHaveBeenCalledWith(
      'org-1',
      'festival-1',
      expect.anything(),
    );
    const text = festivalDialog(wrapper).text();
    expect(text).toContain('27');
    // Two events kept, and told to delete them one by one: the one sentence
    // whose content is fixed whatever the counts.
    expect(festivalDialog(wrapper).findAll('strong')).toHaveLength(1);
  });

  it('holds the delete until the festival’s name is typed back', async () => {
    const { wrapper } = await openIt();
    const dialog = festivalDialog(wrapper);
    const confirm = dialog.find<HTMLButtonElement>('.evp-confirm-destroy');

    expect(confirm.element.disabled).toBe(true);
    await dialog.find('input').setValue('Soundclash');
    expect(confirm.element.disabled).toBe(true);
    await dialog.find('input').setValue(' Soundclash 26 ');
    expect(confirm.element.disabled).toBe(false);
  });

  it('deletes with the version it rendered, then goes to the events list', async () => {
    const remove = vi.spyOn(festivals, 'deleteFestival').mockResolvedValue({
      ok: true,
      operationId: 'op-1',
      eventsUngrouped: 2,
    });
    const { wrapper, router } = await openIt();
    const dialog = festivalDialog(wrapper);

    await dialog.find('input').setValue('Soundclash 26');
    await dialog.find('.evp-confirm-destroy').trigger('click');
    await flushPromises();

    expect(remove).toHaveBeenCalledWith('org-1', 'festival-1', 1);
    expect(router.currentRoute.value.path).toBe('/org-1/events');
  });

  it('stays open and says why when the delete is refused', async () => {
    vi.spyOn(festivals, 'deleteFestival').mockResolvedValue({
      ok: false,
      rejection: { reason: 'conflict', detail: 'stale' },
    });
    const { wrapper, router } = await openIt();
    const dialog = festivalDialog(wrapper);

    await dialog.find('input').setValue('Soundclash 26');
    await dialog.find('.evp-confirm-destroy').trigger('click');
    await flushPromises();

    expect(router.currentRoute.value.path).toBe(
      '/org-1/festivals/festival-1/details',
    );
    expect(festivalDialog(wrapper).find('[role="alert"]').exists()).toBe(true);
  });
});
