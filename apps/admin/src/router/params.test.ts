// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { describe, expect, it } from 'vitest';

import { useRouteParam } from './params';

/** One probe component, parameterised by which param it reads —
 * `eslint-plugin-vue`'s `vue/one-component-per-file` is right that two ad hoc
 * components in one test file is a smell even in a test. */
const Probe = defineComponent({
  props: { name: { type: String, required: true } },
  setup(props) {
    const value = useRouteParam(props.name);
    return () => h('p', `[${value.value}]`);
  },
});

describe('useRouteParam', () => {
  it('reads a declared segment as a string', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/:orgId/events', name: 'org-events', component: Probe },
      ],
    });

    await router.push('/org-42/events');
    await router.isReady();

    const wrapper = mount(Probe, {
      props: { name: 'orgId' },
      global: { plugins: [router] },
    });

    expect(wrapper.text()).toBe('[org-42]');
  });

  it('falls back to an empty string when the segment is absent', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/:orgId/events', name: 'org-events', component: Probe },
      ],
    });

    await router.push('/org-42/events');
    await router.isReady();

    const wrapper = mount(Probe, {
      props: { name: 'festivalId' },
      global: { plugins: [router] },
    });

    expect(wrapper.text()).toBe('[]');
  });
});
