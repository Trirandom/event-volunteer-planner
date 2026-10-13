<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * OVH SMS configuration for one organisation.
 *
 * Ports the credentials this org used to paste into the Google Sheets Apps
 * Script (`docs/googleSheets/send-sms.js`) into a per-org, coordinator-owned
 * setting (ADR-0034) instead of an ops-managed deployment secret: each
 * organisation has its own OVH account, so each fills in its own keys here.
 *
 * The secret and consumer key are write-only on this page, by contract: the
 * server never sends a previously-saved value back (`smsSettings.ts`), so
 * this form shows "already set" rather than the value, and leaving the field
 * blank on save keeps whatever is stored.
 */
import { computed, ref, watch } from 'vue';

import type { UpdateSmsSettingsRejection } from '../api/smsSettings';
import { useSmsSettings, useUpdateSmsSettings } from '../api/useSmsSettings';
import { t } from '../i18n';
import { useRouteParam } from '../router/params';

const orgId = useRouteParam('orgId');

const { data: settings, isPending: settingsPending } = useSmsSettings(orgId);

const serviceName = ref('');
const sender = ref('');
const applicationKey = ref('');
const applicationSecret = ref('');
const consumerKey = ref('');

/** Once, when the saved settings first arrive — not on every refetch, which
 * would overwrite a field the coordinator is mid-edit on after their own
 * save invalidates the query. */
const hydrated = ref(false);
watch(
  settings,
  (result) => {
    if (hydrated.value || result?.ok !== true) {
      return;
    }
    serviceName.value = result.value.service_name ?? '';
    sender.value = result.value.sender ?? '';
    applicationKey.value = result.value.application_key ?? '';
    hydrated.value = true;
  },
  { immediate: true },
);

const hasApplicationSecret = computed(
  () =>
    settings.value?.ok === true && settings.value.value.has_application_secret,
);
const hasConsumerKey = computed(
  () => settings.value?.ok === true && settings.value.value.has_consumer_key,
);
const loadFailed = computed(() => settings.value?.ok === false);

const {
  mutate: submitUpdate,
  isPending: updatePending,
  data: updateResult,
  reset: resetUpdate,
} = useUpdateSmsSettings(orgId);

function rejectionMessage(rejection: UpdateSmsSettingsRejection): string {
  switch (rejection.reason) {
    case 'unavailable':
      return t('sms.error.unavailable');
    case 'forbidden':
      return t('sms.error.forbidden');
    case 'validation-failed':
    case 'refused':
      // The server names the field it refused, which no message of ours
      // could; it stays the answer until refusals carry per-field codes.
      return rejection.detail;
  }
}

const updateError = computed(() => {
  const result = updateResult.value;
  return result === undefined || result.ok
    ? null
    : rejectionMessage(result.rejection);
});

const savedJustNow = computed(() => updateResult.value?.ok === true);

function save(): void {
  resetUpdate();
  submitUpdate(
    {
      provider: 'ovh',
      serviceName: serviceName.value,
      sender: sender.value,
      applicationKey: applicationKey.value,
      ...(applicationSecret.value === ''
        ? {}
        : { applicationSecret: applicationSecret.value }),
      ...(consumerKey.value === '' ? {} : { consumerKey: consumerKey.value }),
    },
    {
      onSuccess: (result) => {
        if (!result.ok) {
          return;
        }
        // Cleared, not kept: a value typed here has already reached the
        // server, and leaving it in the field would look like it still needs
        // saving.
        applicationSecret.value = '';
        consumerKey.value = '';
      },
    },
  );
}
</script>

<template>
  <h1>{{ t('sms.title') }}</h1>

  <p class="evp-intro">{{ t('sms.intro') }}</p>

  <p v-if="settingsPending">{{ t('common.status.loading') }}</p>

  <p v-else-if="loadFailed" role="alert" class="evp-error">
    {{ t('sms.loadFailed') }}
  </p>

  <form v-else class="evp-panel" @submit.prevent="save">
    <p v-if="updateError !== null" role="alert" class="evp-error">
      {{ updateError }}
    </p>
    <p v-else-if="savedJustNow" role="status" class="evp-status">
      {{ t('sms.saved') }}
    </p>

    <p class="evp-field">
      <label for="sms-service-name">
        <span>{{ t('sms.fields.serviceName') }}</span>
        <input
          id="sms-service-name"
          v-model="serviceName"
          type="text"
          :placeholder="t('sms.fields.serviceNamePlaceholder')"
          required
        />
      </label>
    </p>

    <p class="evp-field">
      <label for="sms-sender">
        <span>{{ t('sms.fields.sender') }}</span>
        <input
          id="sms-sender"
          v-model="sender"
          type="text"
          :placeholder="t('sms.fields.senderPlaceholder')"
          required
        />
      </label>
    </p>

    <p class="evp-field">
      <label for="sms-application-key">
        <span>{{ t('sms.fields.applicationKey') }}</span>
        <input
          id="sms-application-key"
          v-model="applicationKey"
          type="text"
          autocomplete="off"
          required
        />
      </label>
    </p>

    <p class="evp-field">
      <label for="sms-application-secret">
        <span>
          {{ t('sms.fields.applicationSecret') }}
          <span v-if="hasApplicationSecret" class="evp-muted">
            — {{ t('sms.fields.alreadySet') }}
          </span>
        </span>
        <input
          id="sms-application-secret"
          v-model="applicationSecret"
          type="password"
          autocomplete="new-password"
          :placeholder="hasApplicationSecret ? '••••••••' : ''"
          :required="!hasApplicationSecret"
        />
      </label>
    </p>

    <p class="evp-field">
      <label for="sms-consumer-key">
        <span>
          {{ t('sms.fields.consumerKey') }}
          <span v-if="hasConsumerKey" class="evp-muted">
            — {{ t('sms.fields.alreadySet') }}
          </span>
        </span>
        <input
          id="sms-consumer-key"
          v-model="consumerKey"
          type="password"
          autocomplete="new-password"
          :placeholder="hasConsumerKey ? '••••••••' : ''"
          :required="!hasConsumerKey"
        />
      </label>
    </p>

    <button
      class="evp-button evp-button--primary"
      type="submit"
      :disabled="updatePending"
    >
      {{ updatePending ? t('common.status.saving') : t('common.actions.save') }}
    </button>
  </form>
</template>

<style scoped>
h1 {
  font-size: 1.75rem;
  letter-spacing: -0.02em;
  margin: 0 0 0.75rem;
}

.evp-intro {
  color: var(--evp-text-muted);
  margin: 0 0 1.5rem;
  max-width: 60ch;
}

.evp-field {
  margin: 0 0 1rem;
}

.evp-field label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.evp-field input {
  border: 1px solid var(--evp-border);
  border-radius: 0.375rem;
  font: inherit;
  padding: 0.5rem 0.625rem;
}

.evp-muted {
  color: var(--evp-text-muted);
  font-weight: 400;
}

.evp-status {
  color: var(--evp-text-muted);
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
