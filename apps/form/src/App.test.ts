// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

import App from './App.vue';
import { setLocale } from './i18n';
import { router } from './router';

afterEach(async () => {
  await setLocale('fr');
});

async function open(path: string) {
  await router.push(path);
  await router.isReady();
  const wrapper = mount(App, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}

describe('the form’s language (docs/09 §7)', () => {
  it('renders in the language ?lang= asks for, and says so in <html lang>', async () => {
    const wrapper = await open('/some-form?lang=en');
    expect(wrapper.find('h1').text()).toBe('Volunteer form');
    expect(document.documentElement.lang).toBe('en');
  });

  it('writes the switcher’s choice into ?lang= and keeps the token', async () => {
    const wrapper = await open('/some-form?lang=en&t=capability');
    // A dropdown, each language named in itself and tagged with its own
    // `lang` (WCAG 3.1.2), with the current one selected.
    const switcher = wrapper.find('select[aria-label="Language"]');
    expect(
      switcher
        .findAll('option')
        .map((option) => [option.text(), option.attributes('lang')]),
    ).toEqual([
      ['Français', 'fr'],
      ['English', 'en'],
    ]);
    expect(switcher.element).toHaveProperty('value', 'en');

    await switcher.setValue('fr');
    await flushPromises();

    expect(router.currentRoute.value.query).toEqual({
      lang: 'fr',
      t: 'capability',
    });
    expect(wrapper.find('h1').text()).toBe('Formulaire bénévoles');
    expect(document.documentElement.lang).toBe('fr');
  });
});
