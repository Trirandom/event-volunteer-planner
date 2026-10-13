<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * The form row itself: its name, whether the public link accepts new
 * volunteers, and which language it opens in.
 *
 * Saved on its own, against the form's own version, not with the questions.
 * These are two resources with two concurrency tokens (`api/forms.ts`), and
 * closing the public route at the end of recruitment must not wait on — or
 * collide with — somebody's half-written question.
 */
import { LOCALE_NAMES } from '@evp/shared/i18n';
import { computed, ref, watch } from 'vue';

import type { Form, FormLocale } from '../api/forms';
import { usePatchForm } from '../api/useForms';
import { t } from '../i18n';

const props = defineProps<{
  readonly orgId: string;
  readonly form: Form;
}>();

const name = ref(props.form.name);
const publicOpen = ref(props.form.public_open);
const defaultLocale = ref<FormLocale>(props.form.default_locale);

const changes = computed(() => ({
  ...(name.value.trim() === props.form.name ? {} : { name: name.value.trim() }),
  ...(publicOpen.value === props.form.public_open
    ? {}
    : { publicOpen: publicOpen.value }),
  ...(defaultLocale.value === props.form.default_locale
    ? {}
    : { defaultLocale: defaultLocale.value }),
}));

const dirty = computed(() => Object.keys(changes.value).length > 0);

/** Re-seeded from the server unless there is something unsaved here — the
 * same rule `MissionCard.vue` follows, for the same reason. */
watch(
  () => props.form,
  (form) => {
    if (!dirty.value) {
      name.value = form.name;
      publicOpen.value = form.public_open;
      defaultLocale.value = form.default_locale;
    }
  },
);

const patch = usePatchForm(() => props.orgId);
const message = ref<{ tone: 'error' | 'ok'; text: string } | null>(null);

async function save(): Promise<void> {
  if (!dirty.value || name.value.trim() === '') {
    return;
  }
  message.value = null;
  const result = await patch.mutateAsync({
    formId: props.form.id,
    version: props.form.version,
    changes: changes.value,
  });
  if (result.ok) {
    message.value = { tone: 'ok', text: t('forms.settings.saved') };
    return;
  }
  const { rejection } = result;
  if (rejection.reason === 'conflict') {
    // The form has been re-read by the mutation; what is on screen is still
    // what the coordinator typed, so pressing again is a deliberate
    // overwrite of the newer values, not an accident.
    message.value = {
      tone: 'error',
      text: t('forms.settings.conflict'),
    };
    return;
  }
  message.value = {
    tone: 'error',
    text:
      rejection.reason === 'unavailable'
        ? t('forms.errors.unavailable')
        : rejection.detail,
  };
}

/** Same origin as this page: Caddy serves the public bundle under `/f/`
 * (docs/09 §4, docs/06 §1), so the link is this origin plus the slug. */
const publicUrl = computed(
  () => `${window.location.origin}/f/${encodeURIComponent(props.form.slug)}`,
);

const id = (suffix: string): string => `evp-form-settings-${suffix}`;
</script>

<template>
  <form class="evp-panel evp-settings" novalidate @submit.prevent="save">
    <h3 class="evp-settings-title">{{ t('forms.settings.title') }}</h3>

    <div class="evp-settings-grid">
      <p class="evp-field">
        <label :for="id('name')">
          <span>{{ t('forms.settings.name') }}</span>
          <input
            :id="id('name')"
            v-model="name"
            type="text"
            :aria-invalid="name.trim() === ''"
          />
        </label>
      </p>

      <p class="evp-field">
        <label :for="id('locale')">
          <span>{{ t('forms.settings.defaultLocale') }}</span>
          <select :id="id('locale')" v-model="defaultLocale">
            <option value="fr" lang="fr">{{ LOCALE_NAMES.fr }}</option>
            <option value="en" lang="en">{{ LOCALE_NAMES.en }}</option>
          </select>
        </label>
      </p>
    </div>

    <p class="evp-settings-url">
      {{ t('forms.settings.publicLink') }}
      <code>{{ publicUrl }}</code>
    </p>

    <div class="evp-settings-open">
      <label :for="id('open')" class="evp-check">
        <input
          :id="id('open')"
          v-model="publicOpen"
          type="checkbox"
          :aria-describedby="id('open-why')"
        />
        <span>{{ t('forms.settings.open') }}</span>
      </label>
      <p :id="id('open-why')" class="evp-hint">
        {{ t('forms.settings.openHint') }}
        <template v-if="form.live_version_id === null">
          {{ t('forms.settings.noLiveVersion') }}
        </template>
      </p>
    </div>

    <p
      v-if="message !== null"
      :class="message.tone === 'ok' ? 'evp-saved' : 'evp-error'"
      :role="message.tone === 'ok' ? 'status' : 'alert'"
    >
      {{ message.text }}
    </p>

    <button
      type="submit"
      class="evp-button"
      :disabled="!dirty || name.trim() === '' || patch.isPending.value"
    >
      {{
        patch.isPending.value
          ? t('common.status.saving')
          : t('forms.settings.save')
      }}
    </button>
  </form>
</template>

<style scoped>
.evp-settings {
  margin-bottom: 1.5rem;
  max-width: 48rem;
}

.evp-settings-title {
  font-size: 1rem;
  margin: 0 0 0.75rem;
}

.evp-settings-grid {
  column-gap: 1rem;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
}

.evp-field select {
  background: var(--evp-surface);
  border: 1px solid var(--evp-border);
  border-radius: 0.375rem;
  color: var(--evp-text);
  font: inherit;
  min-height: 2.75rem;
  padding: 0.5rem 0.75rem;
  width: 100%;
}

.evp-settings-url {
  margin: 0 0 0.75rem;
  overflow-wrap: anywhere;
}

.evp-check {
  align-items: center;
  display: inline-flex;
  font-weight: 500;
  gap: 0.5rem;
  min-height: 2rem;
}

.evp-check input {
  height: 1.125rem;
  width: 1.125rem;
}

.evp-hint {
  color: var(--evp-text-muted);
  font-size: 0.875rem;
  margin: 0 0 0.75rem;
  max-width: 60ch;
}

.evp-error {
  color: var(--evp-danger);
  margin: 0 0 0.75rem;
}

.evp-saved {
  color: var(--evp-success);
  margin: 0 0 0.75rem;
}
</style>
