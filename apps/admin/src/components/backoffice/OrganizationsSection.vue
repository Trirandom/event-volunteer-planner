<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * Every organisation on the deployment, and the form that adds one.
 *
 * No rename, no delete: the backoffice may only `SELECT` and `INSERT`
 * organisations (ADR-0045) — renaming is the owner's job, and deleting would
 * cascade through every event the tenant ran.
 */
import { computed, ref, useId } from 'vue';

import {
  DEFAULT_ORGANIZATION_TIMEZONE,
  type BackofficeRejection,
  type Organization,
} from '../../api/backoffice';
import { useCreateOrganization } from '../../api/useBackoffice';
import { rejectionMessage } from '../../backoffice/messages';
import { t } from '../../i18n';
import { slugify } from '../../plan/newEventDraft';

defineProps<{ readonly organizations: readonly Organization[] }>();
const emit = defineEmits<{ rejected: [rejection: BackofficeRejection] }>();

const headingId = useId();

const name = ref('');
const slug = ref('');
const timezone = ref(DEFAULT_ORGANIZATION_TIMEZONE);
/** The slug follows the name until the operator types into it — after that
 * it is theirs, the rule `newEventDraft.ts` applies to events. */
const slugEdited = ref(false);

/** Writable computeds rather than a watcher on `name`: "the slug follows
 * the name" is a rule about two fields at once, and a watcher would make it a
 * rule about the order they happened to update in. */
const nameModel = computed({
  get: () => name.value,
  set: (value: string) => {
    name.value = value;
    if (!slugEdited.value) {
      slug.value = slugify(value);
    }
  },
});
const slugModel = computed({
  get: () => slug.value,
  set: (value: string) => {
    slug.value = value;
    slugEdited.value = true;
  },
});

const { mutate, isPending, data: result, reset } = useCreateOrganization();

const error = computed(() =>
  result.value === undefined || result.value.ok
    ? null
    : rejectionMessage(result.value.rejection),
);
const created = computed(() =>
  result.value?.ok === true ? result.value.value.name : null,
);

function submit(): void {
  reset();
  const tz = timezone.value.trim();
  mutate(
    {
      name: name.value.trim(),
      slug: slug.value.trim(),
      // Blank is the server's default, sent as an absent field rather than
      // as `""`, which the server would refuse as an unknown zone.
      ...(tz === '' ? {} : { timezone: tz }),
    },
    {
      onSuccess: (outcome) => {
        if (!outcome.ok) {
          emit('rejected', outcome.rejection);
          return;
        }
        name.value = '';
        slug.value = '';
        slugEdited.value = false;
        timezone.value = DEFAULT_ORGANIZATION_TIMEZONE;
      },
    },
  );
}
</script>

<template>
  <section class="evp-section" :aria-labelledby="headingId">
    <h2 :id="headingId">{{ t('backoffice.organizations.heading') }}</h2>

    <p v-if="organizations.length === 0" class="evp-muted">
      {{ t('backoffice.organizations.empty') }}
    </p>
    <div v-else class="evp-table-scroll">
      <table class="evp-table" :aria-labelledby="headingId">
        <thead>
          <tr>
            <th scope="col">
              {{ t('backoffice.organizations.columns.name') }}
            </th>
            <th scope="col">
              {{ t('backoffice.organizations.columns.slug') }}
            </th>
            <th scope="col">
              {{ t('backoffice.organizations.columns.timezone') }}
            </th>
            <th scope="col" class="evp-num">
              {{ t('backoffice.organizations.columns.members') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="organization in organizations" :key="organization.id">
            <th scope="row">{{ organization.name }}</th>
            <td>
              <code>{{ organization.slug }}</code>
            </td>
            <td>{{ organization.timezone }}</td>
            <td class="evp-num">{{ organization.member_count }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <form class="evp-panel evp-create" @submit.prevent="submit">
      <h3>{{ t('backoffice.organizations.create.heading') }}</h3>

      <p v-if="error !== null" role="alert" class="evp-error">{{ error }}</p>
      <p v-else-if="created !== null" role="status" class="evp-status">
        {{ t('backoffice.organizations.create.created', { name: created }) }}
      </p>

      <p class="evp-field">
        <label for="backoffice-org-name">
          <span>{{ t('backoffice.organizations.create.name') }}</span>
          <input
            id="backoffice-org-name"
            v-model="nameModel"
            type="text"
            required
          />
        </label>
      </p>

      <p class="evp-field">
        <label for="backoffice-org-slug">
          <span>{{ t('backoffice.organizations.create.slug') }}</span>
          <input
            id="backoffice-org-slug"
            v-model="slugModel"
            type="text"
            required
            minlength="3"
            maxlength="40"
            pattern="[a-z0-9][a-z0-9\-]{1,38}[a-z0-9]"
            aria-describedby="backoffice-org-slug-hint"
          />
        </label>
        <small id="backoffice-org-slug-hint" class="evp-hint">
          {{ t('backoffice.organizations.create.slugHint') }}
        </small>
      </p>

      <p class="evp-field">
        <label for="backoffice-org-timezone">
          <span>{{ t('backoffice.organizations.create.timezone') }}</span>
          <input
            id="backoffice-org-timezone"
            v-model="timezone"
            type="text"
            autocomplete="off"
            spellcheck="false"
          />
        </label>
      </p>

      <button
        class="evp-button evp-button--primary"
        type="submit"
        :disabled="isPending"
      >
        {{
          isPending
            ? t('backoffice.organizations.create.submitting')
            : t('backoffice.organizations.create.submit')
        }}
      </button>
    </form>
  </section>
</template>

<style scoped src="./section.css"></style>
