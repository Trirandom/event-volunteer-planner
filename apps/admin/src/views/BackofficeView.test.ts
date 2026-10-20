// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { flushPromises, mount } from '@vue/test-utils';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as backofficeApi from '../api/backoffice';
import { backofficeKey, clearBackofficeKey } from '../backoffice/key';
import BackofficeView from './BackofficeView.vue';

const KEY = 'k'.repeat(64);

const ORGANIZATION: backofficeApi.Organization = {
  id: 'org-1',
  slug: 'soundclash',
  name: 'Soundclash',
  timezone: 'Europe/Paris',
  created_at: '2026-10-01T08:00:00Z',
  member_count: 3,
};

const USER: backofficeApi.BackofficeUser = {
  id: 'user-1',
  email: 'ada@example.org',
  display_name: 'Ada',
  created_at: '2026-10-01T08:00:00Z',
  last_login_at: '2026-10-19T18:30:00Z',
  memberships: [
    { org_id: 'org-1', slug: 'soundclash', name: 'Soundclash', role: 'owner' },
  ],
};

async function mountView() {
  const wrapper = mount(BackofficeView, {
    global: {
      plugins: [
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
  });
  await flushPromises();
  return wrapper;
}

async function unlockWith(
  wrapper: Awaited<ReturnType<typeof mountView>>,
  key: string,
) {
  await wrapper.find('#backoffice-key').setValue(key);
  await wrapper.find('form').trigger('submit');
  await flushPromises();
}

beforeEach(() => {
  vi.spyOn(backofficeApi, 'listUsers').mockResolvedValue({
    ok: true,
    value: [USER],
  });
});

afterEach(() => {
  // The key is module state on purpose (in memory, one per tab); a test that
  // left it set would unlock the next one.
  clearBackofficeKey();
  vi.restoreAllMocks();
});

describe('BackofficeView', () => {
  it('is locked by default and asks for nothing until a key is given', async () => {
    const listOrganizations = vi.spyOn(backofficeApi, 'listOrganizations');

    const wrapper = await mountView();

    const field = wrapper.find('#backoffice-key');
    expect(field.attributes('type')).toBe('password');
    expect(field.attributes('autocomplete')).toBe('off');
    expect(wrapper.text()).not.toContain('Accounts');
    expect(listOrganizations).not.toHaveBeenCalled();
  });

  it('unlocks into the organisations, the accounts and the member picker', async () => {
    const listOrganizations = vi
      .spyOn(backofficeApi, 'listOrganizations')
      .mockResolvedValue({ ok: true, value: [ORGANIZATION] });

    const wrapper = await mountView();
    await unlockWith(wrapper, `  ${KEY}  `);

    // Trimmed: a key pasted from a terminal often brings a newline with it.
    expect(listOrganizations).toHaveBeenCalledWith(KEY, expect.anything());
    expect(wrapper.find('#backoffice-key').exists()).toBe(false);
    expect(wrapper.text()).toContain('Soundclash');
    expect(wrapper.text()).toContain('soundclash');
    expect(wrapper.text()).toContain('ada@example.org');
    expect(wrapper.text()).toContain('Soundclash (Owner)');
    expect(wrapper.text()).toContain('UTC');
    expect(wrapper.find('#backoffice-members-org').text()).toContain(
      'Soundclash',
    );
  });

  it('shows a refused key, relocks and forgets it', async () => {
    vi.spyOn(backofficeApi, 'listOrganizations').mockResolvedValue({
      ok: false,
      rejection: { reason: 'bad-key' },
    });

    const wrapper = await mountView();
    await unlockWith(wrapper, KEY);

    expect(wrapper.find('[role="alert"]').text()).toBe(
      'That key is not the right one.',
    );
    expect(wrapper.find('#backoffice-key').exists()).toBe(true);
    expect(backofficeKey.value).toBeNull();
  });

  it('says so when the deployment has no backoffice key configured', async () => {
    vi.spyOn(backofficeApi, 'listOrganizations').mockResolvedValue({
      ok: false,
      rejection: { reason: 'disabled' },
    });

    const wrapper = await mountView();
    await unlockWith(wrapper, KEY);

    expect(wrapper.find('[role="alert"]').text()).toContain(
      'EVP_BACKOFFICE_KEY is not set',
    );
    expect(backofficeKey.value).toBeNull();
  });

  it('locks again on demand, dropping what the key fetched', async () => {
    vi.spyOn(backofficeApi, 'listOrganizations').mockResolvedValue({
      ok: true,
      value: [ORGANIZATION],
    });

    const wrapper = await mountView();
    await unlockWith(wrapper, KEY);

    const lock = wrapper
      .findAll('button')
      .find((button) => button.text() === 'Lock');
    await lock?.trigger('click');
    await flushPromises();

    expect(wrapper.find('#backoffice-key').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('ada@example.org');
    expect(backofficeKey.value).toBeNull();
  });

  it('lists the members of the organisation picked', async () => {
    vi.spyOn(backofficeApi, 'listOrganizations').mockResolvedValue({
      ok: true,
      value: [ORGANIZATION],
    });
    const listMembers = vi
      .spyOn(backofficeApi, 'listMembers')
      .mockResolvedValue({
        ok: true,
        value: [
          {
            user_id: 'user-1',
            email: 'ada@example.org',
            display_name: 'Ada',
            role: 'owner',
            created_at: '2026-10-01T08:00:00Z',
          },
        ],
      });

    const wrapper = await mountView();
    await unlockWith(wrapper, KEY);
    await wrapper.find('#backoffice-members-org').setValue('org-1');
    await flushPromises();

    expect(listMembers).toHaveBeenCalledWith(KEY, 'org-1', expect.anything());
    expect(wrapper.find('select[aria-label="Role of Ada"]').exists()).toBe(
      true,
    );
    expect(wrapper.find('button[aria-label="Remove Ada"]').exists()).toBe(true);
  });
});
