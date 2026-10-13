<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * The empty state: this festival or event has no form yet.
 *
 * Name and slug start from the festival's or event's own, since the slug is
 * the public URL (`/f/{slug}`) and "soundclash-26" is the link a coordinator
 * would have typed anyway. The slug stays editable because it is also the one
 * thing here that is hard to change later — it is printed on flyers.
 *
 * The questions are not chosen here. The server seeds version 1 with the
 * built-ins every form needs (docs/04 §"The seeded draft"), and editing that
 * draft is the rest of the page.
 */
import { computed, ref } from 'vue';

import type { Form, FormScope } from '../api/forms';
import { useCreateForm } from '../api/useForms';
import { t } from '../i18n';
import { slugify } from '../plan/formDraft';

const props = defineProps<{
  readonly orgId: string;
  readonly scope: FormScope;
  readonly defaultName: string;
  readonly defaultSlug: string;
}>();

const emit = defineEmits<{ created: [form: Form] }>();

/** A URL path, not text: the public bundle is served under it. */
const SLUG_PREFIX = '/f/';

const name = ref(props.defaultName);
const slug = ref(props.defaultSlug);

/** The shape `slugify` produces, which is also the only shape that survives
 * being read aloud, typed from a poster and put in a URL unescaped. */
const slugValid = computed(() =>
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug.value),
);

const create = useCreateForm(() => props.orgId);
const refusal = ref<string | null>(null);

function tidySlug(): void {
  slug.value = slugify(slug.value);
}

async function submit(): Promise<void> {
  if (name.value.trim() === '' || !slugValid.value) {
    return;
  }
  refusal.value = null;
  const result = await create.mutateAsync({
    name: name.value.trim(),
    slug: slug.value,
    scope: props.scope,
  });
  if (result.ok) {
    emit('created', result.value);
    return;
  }
  const { rejection } = result;
  refusal.value =
    rejection.reason === 'conflict'
      ? t('forms.newForm.slugTaken')
      : rejection.reason === 'unavailable'
        ? t('forms.errors.unavailable')
        : rejection.detail;
}
</script>

<template>
  <form class="evp-panel evp-new-form" novalidate @submit.prevent="submit">
    <p class="evp-new-form-lead">
      {{ t('forms.newForm.lead') }}
    </p>

    <p class="evp-field">
      <label for="evp-new-form-name">
        <span>{{ t('forms.newForm.name') }}</span>
        <input
          id="evp-new-form-name"
          v-model="name"
          type="text"
          :aria-invalid="name.trim() === ''"
        />
      </label>
    </p>

    <p class="evp-field">
      <label for="evp-new-form-slug">
        <span>{{ t('forms.newForm.slug') }}</span>
        <span class="evp-slug">
          <span class="evp-slug-prefix" aria-hidden="true">{{
            SLUG_PREFIX
          }}</span>
          <input
            id="evp-new-form-slug"
            v-model="slug"
            type="text"
            autocomplete="off"
            spellcheck="false"
            :aria-invalid="!slugValid"
            aria-describedby="evp-new-form-slug-hint"
            @blur="tidySlug"
          />
        </span>
      </label>
      <span id="evp-new-form-slug-hint" class="evp-hint">
        {{ t('forms.newForm.slugHint') }}
      </span>
    </p>

    <p v-if="refusal !== null" class="evp-error" role="alert">{{ refusal }}</p>

    <button
      type="submit"
      class="evp-button evp-button--primary"
      :disabled="create.isPending.value || name.trim() === '' || !slugValid"
    >
      {{
        create.isPending.value
          ? t('forms.status.creating')
          : t('forms.newForm.create')
      }}
    </button>
  </form>
</template>

<style scoped>
.evp-new-form {
  max-width: 36rem;
}

.evp-new-form-lead {
  margin: 0 0 1rem;
}

.evp-slug {
  align-items: center;
  display: flex;
  gap: 0.25rem;
}

.evp-slug-prefix {
  color: var(--evp-text-muted);
}

.evp-hint {
  color: var(--evp-text-muted);
  display: block;
  font-size: 0.875rem;
  margin-top: 0.25rem;
}

.evp-error {
  color: var(--evp-danger);
  margin: 0 0 0.75rem;
}
</style>
