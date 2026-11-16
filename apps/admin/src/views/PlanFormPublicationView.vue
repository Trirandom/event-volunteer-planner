<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * Publication: what volunteers can reach, and putting the draft in front of
 * them (docs/09 §2).
 *
 * Separated from the builder because the two answer different questions. The
 * builder is "what do we ask"; this is "is it live, where, and is it still
 * taking people". With both on one page the public-link switch sat above a
 * form nobody had published, reading as though ticking it would put the form
 * online — so the link and the switch appear here only once a version is
 * live, and until then the page says what publishing will do instead.
 *
 * **What is published is the saved draft.** This tab never holds an edit of
 * its own: the builder's route guard has already asked about anything
 * unsaved before the coordinator could arrive here, so the draft read below
 * is the draft the server will freeze. The checks the builder shows are
 * recomputed from it (`plan/formDraft.ts`), so a draft that would be refused
 * says so before the dialog rather than after it.
 */
import { eventTimeZone, formatDate } from '@evp/shared/intl';
import { Temporal } from '@evp/shared/time';
import { computed, ref } from 'vue';
import { RouterLink, type RouteLocationRaw } from 'vue-router';

import type { FormWriteRejection } from '../api/forms';
import {
  useFormVersion,
  useMissionOptions,
  usePublishFormVersion,
} from '../api/useForms';
import { useScopeForm } from '../api/useScopeForm';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import FormPicker from '../components/FormPicker.vue';
import FormSettingsPanel from '../components/FormSettingsPanel.vue';
import ToastMessage from '../components/ToastMessage.vue';
import ToastStack from '../components/ToastStack.vue';
import {
  draftOf,
  publishProblems,
  saveProblems,
  type DraftProblem,
} from '../plan/formDraft';
import { locale, t } from '../i18n';
import { useRouteParam } from '../router/params';

const orgId = useRouteParam('orgId');
const festivalId = useRouteParam('festivalId');
const eventId = useRouteParam('eventId');

const {
  page,
  forms,
  formsFailed,
  formId,
  form,
  draftSummary,
  liveSummary,
  isPending,
  chooseForm,
} = useScopeForm(orgId, festivalId, eventId);

const draftNumber = computed(() => draftSummary.value?.version ?? 0);
const { data: draftResult } = useFormVersion(orgId, formId, draftNumber);
const draftVersion = computed(() =>
  draftResult.value?.ok === true ? draftResult.value.value : null,
);

const { data: missionOptionsResult } = useMissionOptions(orgId, formId, {
  enabled: computed(() => draftSummary.value !== null),
});
const scopeMissions = computed(() =>
  missionOptionsResult.value?.ok === true
    ? missionOptionsResult.value.value
    : null,
);

/** What would stop the publish, as the builder words it. A blocking problem
 * cannot be saved either, so on a saved draft it only arises when the rules
 * moved since; the rest are what the server checks on publish. */
const problems = computed((): readonly DraftProblem[] => {
  const saved = draftVersion.value;
  const value = form.value;
  if (saved === null || value === null) {
    return [];
  }
  const draft = draftOf(saved);
  return [
    ...saveProblems(draft, { scoped: true }),
    ...publishProblems(draft, {
      defaultLocale: value.default_locale,
      missionValues:
        scopeMissions.value === null
          ? null
          : new Set(scopeMissions.value.map((m) => m.value)),
    }),
  ];
});

function positionOf(key: string | null): number | null {
  if (key === null) {
    return null;
  }
  const index =
    draftVersion.value?.questions.findIndex((q) => q.id === key) ?? -1;
  return index === -1 ? null : index + 1;
}

function publishedOn(instant: string): string {
  const subject = page.value?.kind === 'own' ? page.value.subject : null;
  return formatDate(Temporal.Instant.from(instant).epochMilliseconds, {
    locale: locale.value,
    timeZone: eventTimeZone(subject?.timezone ?? 'UTC'),
  });
}

/** The builder, at the scope this tab is on, keeping the chosen form. */
const builder = computed((): RouteLocationRaw => {
  const params =
    eventId.value === ''
      ? { orgId: orgId.value, festivalId: festivalId.value }
      : { orgId: orgId.value, eventId: eventId.value };
  return {
    name: eventId.value === '' ? 'org-festival-form' : 'org-event-form',
    params,
    query: forms.value.length > 1 ? { form: formId.value } : {},
  };
});

// ── Publishing ──────────────────────────────────────────────────────────────

const publish = usePublishFormVersion(orgId);
const confirming = ref(false);
const publishError = ref<string | null>(null);
const toast = ref<{
  readonly tone: 'danger' | 'info';
  readonly text: string;
} | null>(null);

function rejectionText(rejection: FormWriteRejection): string {
  return rejection.reason === 'unavailable'
    ? t('forms.errors.unavailable')
    : rejection.detail;
}

function askToPublish(): void {
  publishError.value = null;
  confirming.value = true;
}

async function confirmPublish(): Promise<void> {
  const saved = draftVersion.value;
  const value = form.value;
  if (saved === null || value === null) {
    return;
  }
  publishError.value = null;
  const result = await publish.mutateAsync({
    formId: value.id,
    version: saved.version,
    etag: saved.etag_version,
  });

  if (result.ok) {
    confirming.value = false;
    toast.value = {
      tone: 'info',
      text: t('forms.page.toast.published', {
        version: result.value.version,
      }),
    };
    return;
  }

  const { rejection } = result;
  if (rejection.reason === 'invalid') {
    // The problems are pinned to questions, and questions are the builder's:
    // the toast says how many, the list below is recomputed from the draft,
    // and the builder is one link away to fix them.
    confirming.value = false;
    toast.value = {
      tone: 'danger',
      text:
        rejection.problems.length === 0
          ? rejection.detail
          : t('forms.page.toast.publishRefused', {
              count: rejection.problems.length,
            }),
    };
    return;
  }
  publishError.value =
    rejection.reason === 'conflict'
      ? t('forms.page.toast.publishConflict')
      : rejectionText(rejection);
}
</script>

<template>
  <p v-if="isPending">{{ t('common.status.loading') }}</p>

  <template v-else-if="page !== null">
    <h2 class="evp-publication-title">
      {{ t('forms.publication.title') }}
    </h2>

    <div v-if="page.kind === 'covered'" class="evp-panel evp-block">
      <p>
        {{
          page.festivalName === null
            ? t('forms.page.covered.unnamed', { day: page.dayName })
            : t('forms.page.covered.named', {
                day: page.dayName,
                festival: page.festivalName,
              })
        }}
      </p>
      <RouterLink
        class="evp-button"
        :to="{
          name: 'org-festival-publication',
          params: { orgId, festivalId: page.festivalId },
        }"
      >
        {{ t('forms.page.covered.open') }}
      </RouterLink>
    </div>

    <p v-else-if="formsFailed" role="alert" class="evp-error-panel">
      {{ t('forms.page.formsFailed') }}
    </p>

    <div v-else-if="forms.length === 0" class="evp-panel evp-block">
      <p>{{ t('forms.publication.noForm') }}</p>
      <RouterLink class="evp-button" :to="builder">
        {{ t('forms.publication.toBuilder') }}
      </RouterLink>
    </div>

    <template v-else-if="form !== null">
      <FormPicker
        v-if="forms.length > 1"
        :forms="forms"
        :form-id="formId"
        :choose="chooseForm"
      />

      <!-- Where the form stands, first: whether anything is online at all
           decides what every control below it means. -->
      <section
        class="evp-panel evp-block"
        aria-labelledby="evp-publication-status"
      >
        <h3 id="evp-publication-status" class="evp-block-title">
          {{ t('forms.publication.status.heading') }}
        </h3>
        <p v-if="liveSummary !== null && liveSummary.published_at !== null">
          <span class="evp-tag evp-tag--live">{{
            t('forms.page.versions.live')
          }}</span>
          {{
            t('forms.publication.status.live', {
              version: liveSummary.version,
              date: publishedOn(liveSummary.published_at),
              count: liveSummary.question_count,
            })
          }}
        </p>
        <p v-else class="evp-notice">
          {{ t('forms.publication.status.never') }}
        </p>
      </section>

      <section
        class="evp-panel evp-block"
        aria-labelledby="evp-publication-draft"
      >
        <h3 id="evp-publication-draft" class="evp-block-title">
          {{ t('forms.publication.draft.heading') }}
        </h3>

        <template v-if="draftSummary !== null">
          <p>
            {{
              t('forms.publication.draft.summary', {
                version: draftSummary.version,
                count: draftSummary.question_count,
                replaces: liveSummary === null ? 'no' : 'yes',
              })
            }}
          </p>

          <div v-if="problems.length > 0" class="evp-problems">
            <p>
              {{ t('forms.page.summary.heading', { count: problems.length }) }}
            </p>
            <ul>
              <li v-for="(p, i) in problems" :key="`${p.code}-${i}`">
                <template v-if="positionOf(p.questionKey) !== null">{{
                  t('forms.page.summary.question', {
                    position: positionOf(p.questionKey) ?? 0,
                  })
                }}</template
                ><template v-else>{{ t('forms.page.summary.form') }}</template
                >{{ t('forms.page.summary.separator') }} {{ p.message }}
              </li>
            </ul>
          </div>

          <p class="evp-actions">
            <button
              type="button"
              class="evp-button evp-button--primary evp-button--cta evp-slab evp-pressable"
              :disabled="draftVersion === null || publish.isPending.value"
              aria-haspopup="dialog"
              @click="askToPublish"
            >
              {{
                t('forms.publication.draft.publish', {
                  version: draftSummary.version,
                })
              }}
            </button>
            <RouterLink class="evp-button" :to="builder">
              {{ t('forms.publication.draft.edit') }}
            </RouterLink>
          </p>
        </template>

        <template v-else>
          <p>{{ t('forms.publication.draft.none') }}</p>
          <RouterLink class="evp-button" :to="builder">
            {{ t('forms.publication.toBuilder') }}
          </RouterLink>
        </template>
      </section>

      <FormSettingsPanel :key="form.id" :org-id="orgId" :form="form" />
    </template>

    <p v-else>{{ t('common.status.loading') }}</p>

    <ConfirmDialog
      :open="confirming"
      :title="
        t('forms.page.publishDialog.title', {
          version: draftSummary?.version ?? '',
        })
      "
      :confirm-label="t('forms.page.publishDialog.confirm')"
      :busy-label="t('forms.page.publishDialog.busy')"
      :cancel-label="t('common.actions.cancel')"
      :busy="publish.isPending.value"
      :error="publishError"
      @confirm="confirmPublish"
      @cancel="confirming = false"
    >
      <p>
        {{ t('forms.page.publishDialog.body') }}
        <strong>{{ t('forms.page.publishDialog.frozen') }}</strong>
      </p>
      <p>{{ t('forms.page.publishDialog.why') }}</p>
      <template v-if="problems.length > 0">
        <p>{{ t('forms.page.publishDialog.risk') }}</p>
        <ul>
          <li v-for="(p, i) in problems" :key="`${p.code}-${i}`">
            {{ p.message }}
          </li>
        </ul>
      </template>
    </ConfirmDialog>
  </template>

  <ToastStack>
    <ToastMessage
      v-if="toast !== null"
      :tone="toast.tone"
      dismissible
      :dismiss-label="t('common.actions.close')"
      @dismiss="toast = null"
    >
      <p>{{ toast.text }}</p>
    </ToastMessage>
  </ToastStack>
</template>

<style scoped>
.evp-publication-title {
  font-size: 1.25rem;
  margin: 0 0 1rem;
}

.evp-block {
  margin-bottom: 1.5rem;
  max-width: 48rem;
}

.evp-block p {
  margin: 0 0 0.75rem;
}

.evp-block-title {
  font-size: 1rem;
  margin: 0 0 0.75rem;
}

.evp-error-panel {
  background: var(--evp-surface);
  border: 1px solid var(--evp-danger);
  border-left-width: 4px;
  border-radius: var(--evp-radius-sm);
  color: var(--evp-danger);
  margin: 0 0 1rem;
  max-width: 60ch;
  padding: 0.75rem;
}

.evp-tag {
  border: 1px solid var(--evp-border);
  border-radius: 999px;
  font-size: 0.8125rem;
  margin-right: 0.375rem;
  padding: 0.0625rem 0.5rem;
}

.evp-tag--live {
  border-color: var(--evp-success);
  color: var(--evp-text);
  font-weight: 600;
}

.evp-problems {
  border-left: 4px solid var(--evp-danger);
  margin: 0 0 0.75rem;
  padding: 0.25rem 0 0.25rem 0.75rem;
}

.evp-problems ul {
  margin: 0;
  padding-left: 1.25rem;
}

.evp-actions {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}
</style>
