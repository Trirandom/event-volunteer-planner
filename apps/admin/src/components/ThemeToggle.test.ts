// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The header's light/dark button.
 *
 * What matters is the contract with tokens.css and with the next page load:
 * a press sets `data-theme` on <html> and remembers it, and the button's name
 * always says what pressing it will do, since its icon alone is not a name.
 * jsdom has no `matchMedia`, so the system preference is stubbed per test.
 */
import { mount } from '@vue/test-utils';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { setLocale } from '../i18n';
import { storedTheme } from '../theme/preference';

import ThemeToggle from './ThemeToggle.vue';

type Listener = () => void;

/** A system preference that can be flipped mid-test, as at dusk. */
function stubSystem(dark: boolean): { flip: (next: boolean) => void } {
  let matches = dark;
  const listeners = new Set<Listener>();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query === '(prefers-color-scheme: dark)' && matches;
    },
    addEventListener: (_type: string, listener: Listener) =>
      listeners.add(listener),
    removeEventListener: (_type: string, listener: Listener) =>
      listeners.delete(listener),
  }));
  return {
    flip(next) {
      matches = next;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

beforeAll(async () => {
  await setLocale('fr');
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('ThemeToggle', () => {
  it('offers dark when the system is light', () => {
    stubSystem(false);
    const wrapper = mount(ThemeToggle);
    expect(wrapper.get('button').attributes('aria-label')).toBe(
      'Passer au thème sombre',
    );
  });

  it('offers light when the system is dark', () => {
    stubSystem(true);
    const wrapper = mount(ThemeToggle);
    expect(wrapper.get('button').attributes('aria-label')).toBe(
      'Passer au thème clair',
    );
  });

  it('applies and remembers the opposite of what is shown', async () => {
    stubSystem(true);
    const wrapper = mount(ThemeToggle);

    await wrapper.get('button').trigger('click');

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(storedTheme()).toBe('light');
    expect(wrapper.get('button').attributes('aria-label')).toBe(
      'Passer au thème sombre',
    );
  });

  it('follows the system while nothing is chosen', async () => {
    const system = stubSystem(false);
    const wrapper = mount(ThemeToggle);

    system.flip(true);
    await wrapper.vm.$nextTick();

    expect(wrapper.get('button').attributes('aria-label')).toBe(
      'Passer au thème clair',
    );
  });

  it('stops following the system once a theme is chosen', async () => {
    const system = stubSystem(false);
    const wrapper = mount(ThemeToggle);
    await wrapper.get('button').trigger('click');

    system.flip(false);
    await wrapper.vm.$nextTick();

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(wrapper.get('button').attributes('aria-label')).toBe(
      'Passer au thème clair',
    );
  });
});
