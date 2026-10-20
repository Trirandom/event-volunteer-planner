<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * Every account on the deployment, and the form that creates one.
 *
 * The password field is the amendment ADR-0045 makes to ADR-0031: until magic
 * links exist, an operator-chosen password is the only way a second
 * coordinator can sign in at all. It goes when they land.
 */
import { computed, ref, useId } from 'vue';

import type {
  BackofficeRejection,
  BackofficeResult,
  BackofficeUser,
} from '../../api/backoffice';
import { useCreateUser } from '../../api/useBackoffice';
import {
  lastLoginLabel,
  rejectionMessage,
  roleLabel,
} from '../../backoffice/messages';
import { t } from '../../i18n';

const props = defineProps<{
  readonly users: BackofficeResult<readonly BackofficeUser[]> | undefined;
}>();
const emit = defineEmits<{ rejected: [rejection: BackofficeRejection] }>();

const headingId = useId();

const rows = computed(() =>
  props.users?.ok === true ? props.users.value : [],
);
const loadError = computed(() =>
  props.users === undefined || props.users.ok
    ? null
    : rejectionMessage(props.users.rejection),
);

const email = ref('');
const displayName = ref('');
const password = ref('');

const { mutate, isPending, data: result, reset } = useCreateUser();

const error = computed(() =>
  result.value === undefined || result.value.ok
    ? null
    : rejectionMessage(result.value.rejection),
);
const created = computed(() =>
  result.value?.ok === true ? result.value.value.email : null,
);

function submit(): void {
  reset();
  mutate(
    {
      email: email.value.trim(),
      displayName: displayName.value.trim(),
      // Not trimmed: a password is exactly what was typed.
      password: password.value,
    },
    {
      onSuccess: (outcome) => {
        if (!outcome.ok) {
          emit('rejected', outcome.rejection);
          return;
        }
        email.value = '';
        displayName.value = '';
        password.value = '';
      },
    },
  );
}
</script>

<template>
  <section class="evp-section" :aria-labelledby="headingId">
    <h2 :id="headingId">{{ t('backoffice.users.heading') }}</h2>

    <p v-if="users === undefined">{{ t('common.status.loading') }}</p>
    <p v-else-if="loadError !== null" role="alert" class="evp-error">
      {{ loadError }}
    </p>
    <p v-else-if="rows.length === 0" class="evp-muted">
      {{ t('backoffice.users.empty') }}
    </p>
    <div v-else class="evp-table-scroll">
      <table class="evp-table" :aria-labelledby="headingId">
        <thead>
          <tr>
            <th scope="col">{{ t('backoffice.users.columns.email') }}</th>
            <th scope="col">
              {{ t('backoffice.users.columns.displayName') }}
            </th>
            <th scope="col">{{ t('backoffice.users.columns.lastLogin') }}</th>
            <th scope="col">
              {{ t('backoffice.users.columns.memberships') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="user in rows" :key="user.id">
            <th scope="row">{{ user.email }}</th>
            <td>{{ user.display_name }}</td>
            <td>{{ lastLoginLabel(user.last_login_at) }}</td>
            <td>
              <span v-if="user.memberships.length === 0" class="evp-muted">
                {{ t('backoffice.users.noMembership') }}
              </span>
              <ul v-else class="evp-memberships">
                <li
                  v-for="membership in user.memberships"
                  :key="membership.org_id"
                >
                  {{
                    t('backoffice.users.membership', {
                      name: membership.name,
                      role: roleLabel(membership.role),
                    })
                  }}
                </li>
              </ul>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <form class="evp-panel evp-create" @submit.prevent="submit">
      <h3>{{ t('backoffice.users.create.heading') }}</h3>

      <p v-if="error !== null" role="alert" class="evp-error">{{ error }}</p>
      <p v-else-if="created !== null" role="status" class="evp-status">
        {{ t('backoffice.users.create.created', { email: created }) }}
      </p>

      <p class="evp-field">
        <label for="backoffice-user-email">
          <span>{{ t('backoffice.users.create.email') }}</span>
          <input
            id="backoffice-user-email"
            v-model="email"
            type="email"
            autocomplete="off"
            required
          />
        </label>
      </p>

      <p class="evp-field">
        <label for="backoffice-user-name">
          <span>{{ t('backoffice.users.create.displayName') }}</span>
          <input
            id="backoffice-user-name"
            v-model="displayName"
            type="text"
            autocomplete="off"
            required
          />
        </label>
      </p>

      <p class="evp-field">
        <label for="backoffice-user-password">
          <span>{{ t('backoffice.users.create.password') }}</span>
          <!-- `new-password`: it is someone else's, and the browser must not
               offer to fill it with the operator's own saved one. -->
          <input
            id="backoffice-user-password"
            v-model="password"
            type="password"
            autocomplete="new-password"
            minlength="12"
            required
            aria-describedby="backoffice-user-password-hint"
          />
        </label>
        <small id="backoffice-user-password-hint" class="evp-hint">
          {{ t('backoffice.users.create.passwordHint') }}
        </small>
      </p>

      <button
        class="evp-button evp-button--primary"
        type="submit"
        :disabled="isPending"
      >
        {{
          isPending
            ? t('backoffice.users.create.submitting')
            : t('backoffice.users.create.submit')
        }}
      </button>
    </form>
  </section>
</template>

<style scoped src="./section.css"></style>

<style scoped>
.evp-memberships {
  list-style: none;
  margin: 0;
  padding: 0;
}
</style>
