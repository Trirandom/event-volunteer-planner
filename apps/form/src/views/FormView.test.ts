// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App from '../App.vue';
import { demoForm } from '../dev/demoForm';
import { router } from '../router';

interface Sent {
  readonly url: string;
  readonly body: unknown;
}

let sent: Sent[] = [];

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  sent = [];
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/v1/meta')) {
        return Promise.resolve(
          respond(200, {
            version: '0',
            commit: 'x',
            source_url: 'https://example.org',
          }),
        );
      }
      if (init?.method === 'POST') {
        sent.push({
          url,
          body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        });
        return Promise.resolve(new Response(null, { status: 202 }));
      }
      return Promise.resolve(
        respond(200, {
          ...demoForm,
          form: { ...demoForm.form, slug: 'soundclash' },
        }),
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function open(): Promise<VueWrapper> {
  await router.push('/soundclash?lang=fr&t=capability');
  await router.isReady();
  const wrapper = mount(App, {
    global: { plugins: [router] },
    attachTo: document.body,
  });
  await flushPromises();
  return wrapper;
}

function radio(wrapper: VueWrapper, legendStart: string, label: string) {
  const day = wrapper
    .findAll('fieldset.evp-day')
    .find((f) => f.find('legend').text().startsWith(legendStart));
  const option = day?.findAll('label').find((l) => l.text() === label);
  return option?.find('input');
}

async function fillIdentity(wrapper: VueWrapper): Promise<void> {
  await wrapper.find('#q-first').setValue('Camille');
  await wrapper.find('#q-email').setValue(' Camille@Example.org ');
  await wrapper.find('#q-phone').setValue('+33 6 12 34 56 78');
  const adult = wrapper
    .findAll('fieldset')
    .find((f) => f.find('legend').text().startsWith('J’ai 18 ans'));
  await adult?.findAll('input')[0]?.setValue(true);
  await wrapper.find('#q-commitment').setValue(true);
  await wrapper.find('#q-consent').setValue(true);
}

describe('the volunteer form', () => {
  it('answers a festival night in one tap, one row per event', async () => {
    const wrapper = await open();
    expect(wrapper.find('h1').text()).toBe('Bénévoles Soundclash 26');
    // Six events, each a single row titled with its own name.
    expect(wrapper.findAll('fieldset.evp-day')).toHaveLength(6);
    expect(wrapper.text()).toContain('Dub & 2step — vendredi 11 septembre');
    expect(wrapper.text()).toContain('13:00 → 08:00 (+1)');
    wrapper.unmount();
  });

  it('stops at the summary, with links, until everything required is answered', async () => {
    const wrapper = await open();
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    const summary = wrapper.find('.evp-summary');
    expect(summary.text()).toContain('réponses sont à corriger');
    expect(summary.text()).toContain(
      'Indique au moins un moment où tu es disponible.',
    );
    expect(summary.find('a[href="#q-email"]').exists()).toBe(true);
    expect(sent).toEqual([]);
    wrapper.unmount();
  });

  it('will not send until the volunteer commitment is ticked', async () => {
    const wrapper = await open();
    await fillIdentity(wrapper);
    await radio(wrapper, 'Open Air', 'Oui')?.setValue(true);
    await wrapper.find('#q-commitment').setValue(false);
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    const summary = wrapper.find('.evp-summary');
    expect(summary.find('a[href="#q-commitment"]').text()).toContain(
      'Je confirme mon engagement bénévole auprès de Z·est Radio',
    );
    expect(sent).toEqual([]);

    await wrapper.find('#q-commitment').setValue(true);
    expect(wrapper.find('a[href="#q-commitment"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('flags «En partie» with nothing chosen on that row', async () => {
    const wrapper = await open();
    await fillIdentity(wrapper);
    await radio(wrapper, 'Open Air', 'Oui')?.setValue(true);
    await radio(wrapper, 'Dub & 2step', 'En partie')?.setValue(true);
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    const dub = wrapper
      .findAll('fieldset.evp-day')
      .find((f) => f.text().startsWith('Dub'));
    expect(dub?.text()).toContain('Choisis au moins un créneau');
    expect(dub?.attributes('aria-describedby')).toBeDefined();
    expect(sent).toEqual([]);
    wrapper.unmount();
  });

  it('sends exact windows: «Oui», a chip, a typed night, and an explicit «Non»', async () => {
    const wrapper = await open();
    await fillIdentity(wrapper);

    await radio(wrapper, 'Open Air', 'Oui')?.setValue(true);
    await radio(wrapper, 'Montage Molo', 'Non')?.setValue(true);

    await radio(wrapper, 'Dub & 2step', 'En partie')?.setValue(true);
    const dub = () =>
      wrapper
        .findAll('fieldset.evp-day')
        .find((f) => f.text().startsWith('Dub'));
    await dub()
      ?.findAll('button.evp-chip')
      .find((b) => b.text().startsWith('Soir'))
      ?.trigger('click');

    await radio(wrapper, 'Dnb & Dubstep', 'En partie')?.setValue(true);
    const dnb = wrapper
      .findAll('fieldset.evp-day')
      .find((f) => f.text().startsWith('Dnb'));
    const [from, to] = dnb?.findAll('.evp-custom input') ?? [];
    await from?.setValue('22h');
    await to?.setValue('5h30');
    await dnb
      ?.findAll('button')
      .find((b) => b.text() === 'Ajouter')
      ?.trigger('click');
    expect(dnb?.text()).toContain('22:00 → 05:30 (+1)');

    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(
      '/api/v1/public/forms/soundclash/submissions?t=capability',
    );
    expect(sent[0]?.body).toMatchObject({
      form_version_id: 'demo-v1',
      locale: 'fr',
      website: '',
      answers: {
        first: 'Camille',
        email: 'camille@example.org',
        adult: true,
        commitment: true,
        consent: true,
        pool: false,
      },
      availability: [
        {
          event_id: 'open-air',
          kind: 'available',
          start: '2026-09-05T08:00:00Z',
          end: '2026-09-05T23:00:00Z',
        },
        {
          event_id: 'montage',
          kind: 'unavailable',
          start: '2026-09-10T11:00:00Z',
          end: '2026-09-10T18:00:00Z',
        },
        {
          event_id: 'dub',
          kind: 'available',
          start: '2026-09-11T16:00:00Z',
          end: '2026-09-11T22:00:00Z',
        },
        {
          event_id: 'dnb',
          kind: 'available',
          start: '2026-09-12T20:00:00Z',
          end: '2026-09-13T03:30:00Z',
        },
      ],
    });
    expect(wrapper.find('h1').text()).toBe('Merci !');
    expect(localStorage.length).toBe(0);
    wrapper.unmount();
  });

  it('keeps a draft, and offers it back on reload', async () => {
    const first = await open();
    await first.find('#q-first').setValue('Camille');
    await radio(first, 'After', 'Oui')?.setValue(true);
    first.unmount();

    const second = await open();
    expect(second.find('.evp-restored').exists()).toBe(true);
    const name = second.find('#q-first').element;
    expect(name instanceof HTMLInputElement && name.value).toBe('Camille');
    const after = radio(second, 'After', 'Oui')?.element;
    expect(after instanceof HTMLInputElement && after.checked).toBe(true);
    second.unmount();
  });

  it('solves the served challenge in the background and sends the answer with it', async () => {
    const salt = 'feed?expires=9999999999';
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`${salt}37`),
    );
    const challenge = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    let served = 0;
    let refuseFirst = true;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url.startsWith('/api/v1/meta')) {
          return Promise.resolve(
            respond(200, {
              version: '0',
              commit: 'x',
              source_url: 'https://example.org',
            }),
          );
        }
        if (init?.method === 'POST') {
          sent.push({
            url,
            body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
          });
          if (refuseFirst) {
            // The first solution has lapsed: the bundle fetches another and
            // sends again, without a word to the volunteer.
            refuseFirst = false;
            return Promise.resolve(
              respond(422, {
                type: 'https://evp.example/errors/captcha-failed',
                title: 'Verification failed',
                status: 422,
              }),
            );
          }
          return Promise.resolve(new Response(null, { status: 202 }));
        }
        served += 1;
        return Promise.resolve(
          respond(200, {
            ...demoForm,
            form: { ...demoForm.form, slug: 'soundclash' },
            captcha: {
              algorithm: 'SHA-256',
              challenge,
              salt,
              maxnumber: 100,
              signature: `signed-${String(served)}`,
            },
          }),
        );
      }),
    );

    const wrapper = await open();
    await fillIdentity(wrapper);
    await radio(wrapper, 'Open Air', 'Oui')?.setValue(true);
    await wrapper.find('form').trigger('submit');
    // Real hashing, so real tasks: wait for the retry rather than guess.
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    await flushPromises();
    expect(sent[0]?.body).toMatchObject({
      captcha: { challenge, salt, number: 37, signature: 'signed-1' },
    });
    expect(sent[1]?.body).toMatchObject({
      captcha: { number: 37, signature: 'signed-2' },
    });
    expect(wrapper.text()).not.toContain('anti-robot');
    wrapper.unmount();
  });
});
