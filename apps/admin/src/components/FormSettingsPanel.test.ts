// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The form's own settings, on the publication tab.
 *
 * Worth a test for the one rule this panel carries: the public link and its
 * "open to new sign-ups" switch are offered only once a version is live.
 * Ticked over a form nobody had published, the switch read as the way to put
 * the form online, and it is not — publishing is.
 */
import { mount } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { describe, expect, it } from 'vitest';

import type { Form } from '../api/forms';

import FormSettingsPanel from './FormSettingsPanel.vue';

function form(overrides: Partial<Form> = {}): Form {
  return {
    id: 'form-1',
    name: 'Soundclash 26',
    slug: 'soundclash-26',
    festival_id: 'festival-1',
    event_id: null,
    public_open: true,
    default_locale: 'fr',
    live_version_id: null,
    versions: [
      { id: 'v-1', version: 1, published_at: null, question_count: 8 },
    ],
    version: 1,
    ...overrides,
  };
}

function mountPanel(value: Form) {
  return mount(FormSettingsPanel, {
    props: { orgId: 'org-1', form: value },
    global: {
      plugins: [[VueQueryPlugin, { queryClient: new QueryClient() }]],
    },
  });
}

describe('FormSettingsPanel', () => {
  it('offers no public-link switch while nothing is published', () => {
    const wrapper = mountPanel(form());

    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false);
    expect(wrapper.find('a').exists()).toBe(false);
    expect(wrapper.text()).toContain('Once published, the form will be at');
    expect(wrapper.text()).toContain('/f/soundclash-26');
  });

  it('offers the link and the switch once a version is live', () => {
    const wrapper = mountPanel(
      form({
        live_version_id: 'v-1',
        versions: [
          {
            id: 'v-1',
            version: 1,
            published_at: '2026-06-01T10:00:00Z',
            question_count: 8,
          },
        ],
      }),
    );

    const open = wrapper.get<HTMLInputElement>('input[type="checkbox"]');
    expect(open.element.checked).toBe(true);
    expect(wrapper.get('a').attributes('href')).toMatch(/\/f\/soundclash-26$/);
    expect(wrapper.text()).not.toContain('Once published');
  });
});
