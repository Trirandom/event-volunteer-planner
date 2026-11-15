// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import indexHtml from '../index.html?raw';

import App from './App.vue';
import { router } from './router';

/**
 * `index.html` paints a copy of the loading page before any script has run
 * (docs/01 §5), and Vue replaces it with the real one on mount. The copy is
 * static HTML, so nothing but these tests stops the two from drifting into a
 * visible jump at the moment the application takes over.
 */
function shell(): Element {
  const app = new DOMParser()
    .parseFromString(indexHtml, 'text/html')
    .querySelector('#app > *');
  if (app === null) {
    throw new Error('index.html has no shell inside #app');
  }
  return app;
}

/**
 * Markup as written in a file and as rendered by Vue, made comparable. The
 * `data-v-…` scope id is the parent's scoped style reaching the component's
 * root, a build detail rather than part of the outline.
 */
function normalised(element: Element | undefined): string {
  return (element?.outerHTML ?? '')
    .replace(/<!--.*?-->/gs, '')
    .replace(/ data-v-[0-9a-f]+=""/g, '')
    .replace(/>\s+</g, '><')
    .trim();
}

beforeEach(() => {
  // A request that never answers keeps the form on its loading page.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => undefined)),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function loading(): Promise<VueWrapper> {
  await router.push('/soundclash?lang=fr');
  await router.isReady();
  const wrapper = mount(App, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}

describe('the page index.html paints before the application', () => {
  it('holds no words, which belong to the catalogues (docs/16 §6)', () => {
    expect(shell().textContent.trim()).toBe('');
  });

  it('is hidden from assistive technology until the real page replaces it', () => {
    expect(shell().getAttribute('aria-hidden')).toBe('true');
  });

  it('draws the skeleton the form draws while it loads', async () => {
    const wrapper = await loading();

    expect(
      normalised(shell().querySelector('.evp-skeleton') ?? undefined),
    ).toBe(normalised(wrapper.find('.evp-skeleton').element));
    wrapper.unmount();
  });

  it('draws the mark at the size the header does', async () => {
    const wrapper = await loading();
    const mark = wrapper.find('.evp-form-header img');
    const copy = shell().querySelector('.evp-form-header img');

    expect(copy?.getAttribute('width')).toBe(mark.attributes('width'));
    expect(copy?.getAttribute('height')).toBe(mark.attributes('height'));
    // Tests run at base `/`; the bundle is served at `/f/`, which index.html
    // has to spell out (see its comment on the favicon).
    expect(copy?.getAttribute('src')).toBe(`/f${mark.attributes('src') ?? ''}`);
    wrapper.unmount();
  });
});
