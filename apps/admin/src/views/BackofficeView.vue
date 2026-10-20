<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * The deployment operator's backoffice (ADR-0045).
 *
 * Outside the session guard and outside `/:orgId`: its authority is the
 * deployment's key, typed here and held in memory only, and it acts across
 * organisations the way no member route may. No link in the shell leads here
 * — the operator knows the address, and a coordinator should not be invited
 * to a door whose key they are not meant to hold.
 *
 * **The organisations list is the key check.** There is no "is this key
 * right?" endpoint and no need for one: the first list either arrives or says
 * why not, and the page stays on the lock form until it has arrived. Every
 * other section then assumes a working key, and any of them meeting a `401`
 * or a `404`-for-switched-off sends the page back here — the key was changed
 * or unset under it, and nothing else on the page can succeed until it is
 * retyped.
 */
import { computed, ref, watch } from 'vue';

import type { BackofficeRejection } from '../api/backoffice';
import {
  useBackofficeLock,
  useBackofficeOrganizations,
  useBackofficeUsers,
} from '../api/useBackoffice';
import { rejectionMessage } from '../backoffice/messages';
import MembersSection from '../components/backoffice/MembersSection.vue';
import OrganizationsSection from '../components/backoffice/OrganizationsSection.vue';
import UsersSection from '../components/backoffice/UsersSection.vue';
import { t } from '../i18n';

const { unlocked, unlock, lock } = useBackofficeLock();

const keyInput = ref('');
const lockError = ref<string | null>(null);

const { data: organizations } = useBackofficeOrganizations();
const { data: users } = useBackofficeUsers();

/** The key has produced the organisations list at least once. */
const verified = computed(
  () => unlocked.value && organizations.value?.ok === true,
);
const checking = computed(
  () => unlocked.value && organizations.value === undefined,
);

function lockOut(rejection: BackofficeRejection): void {
  lockError.value = rejectionMessage(rejection);
  lock();
}

/** For the sections: a refusal that only a new key can fix. */
function onRejected(rejection: BackofficeRejection): void {
  if (rejection.reason === 'bad-key' || rejection.reason === 'disabled') {
    lockOut(rejection);
  }
}

// Any failure of the organisations list relocks, not only a key refusal: it
// is what proves the key, and an unavailable server has proved nothing, so
// the page has nothing honest to show but the lock form and why.
watch(organizations, (result) => {
  if (result !== undefined && !result.ok) {
    lockOut(result.rejection);
  }
});

watch(users, (result) => {
  if (result !== undefined && !result.ok) {
    onRejected(result.rejection);
  }
});

function submitKey(): void {
  const key = keyInput.value.trim();
  if (key === '') {
    return;
  }
  lockError.value = null;
  // Out of the field as soon as it is held: a key left in a DOM input is one
  // more copy for a screenshot or an extension to find.
  keyInput.value = '';
  unlock(key);
}

function relock(): void {
  lockError.value = null;
  lock();
}
</script>

<template>
  <h1>{{ t('backoffice.title') }}</h1>

  <p class="evp-intro">{{ t('backoffice.intro') }}</p>

  <form v-if="!verified" class="evp-panel evp-lock" @submit.prevent="submitKey">
    <h2>{{ t('backoffice.lock.heading') }}</h2>

    <p v-if="lockError !== null" role="alert" class="evp-error">
      {{ lockError }}
    </p>

    <p class="evp-field">
      <label for="backoffice-key">
        <span>{{ t('backoffice.lock.key') }}</span>
        <input
          id="backoffice-key"
          v-model="keyInput"
          type="password"
          autocomplete="off"
          aria-describedby="backoffice-key-hint"
          required
          :disabled="checking"
        />
      </label>
      <small id="backoffice-key-hint" class="evp-hint">
        {{ t('backoffice.lock.keyHint') }}
      </small>
    </p>

    <button
      class="evp-button evp-button--primary"
      type="submit"
      :disabled="checking"
    >
      {{
        checking ? t('backoffice.lock.unlocking') : t('backoffice.lock.unlock')
      }}
    </button>
  </form>

  <template v-else>
    <p class="evp-lock-bar">
      <button class="evp-button" type="button" @click="relock">
        {{ t('backoffice.lock.lock') }}
      </button>
    </p>

    <OrganizationsSection
      :organizations="organizations?.ok === true ? organizations.value : []"
      @rejected="onRejected"
    />
    <UsersSection :users="users" @rejected="onRejected" />
    <MembersSection
      :organizations="organizations?.ok === true ? organizations.value : []"
      :users="users?.ok === true ? users.value : []"
      @rejected="onRejected"
    />
  </template>
</template>

<style scoped>
h1 {
  font-size: 1.75rem;
  letter-spacing: -0.02em;
  margin: 0 0 0.75rem;
}

h2 {
  font-size: 1.25rem;
  margin: 0 0 1rem;
}

.evp-intro {
  color: var(--evp-text-muted);
  margin: 0 0 1.5rem;
  max-width: 60ch;
}

.evp-lock {
  max-width: 32rem;
}

.evp-hint {
  color: var(--evp-text-muted);
  display: block;
  margin-top: 0.25rem;
}

.evp-lock-bar {
  display: flex;
  justify-content: flex-end;
  margin: 0 0 1rem;
}

.evp-error {
  background: var(--evp-surface);
  border: 1px solid var(--evp-danger);
  border-left-width: 4px;
  border-radius: 0.375rem;
  color: var(--evp-danger);
  margin: 0 0 1rem;
  padding: 0.75rem;
}
</style>
