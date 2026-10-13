<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * The questions roughly as a volunteer will meet them.
 *
 * Static on purpose: nothing here is submitted, validated or stored, and the
 * real form lives in its own bundle that must not share code with this one
 * (docs/09 §6 — the split is a security boundary). What the preview has to get
 * right is the *shape* a coordinator is deciding on: that the availability
 * question is one control grouped by event rather than five questions, that a
 * required yes/no question is two buttons rather than a box (docs/09 §1), and
 * which questions a volunteer cannot skip.
 *
 * The locale switch shows the English form with French as the fallback, which
 * is exactly what a volunteer arriving with `?lang=en` gets (docs/09 §7) — so a
 * French label showing through here is a translation still to write.
 */
import { LOCALE_NAMES, sharedEn, sharedFr } from '@evp/shared/i18n';
import { eventTimeZone, formatDate } from '@evp/shared/intl';
import { computed, ref, useId } from 'vue';

import type { Event } from '../api/events';
import type { FormLocale } from '../api/forms';
import { t } from '../i18n';
import { eventDays, RADIO_LIMIT, type DraftQuestion } from '../plan/formDraft';

const props = defineProps<{
  readonly questions: readonly DraftQuestion[];
  /** The events in scope, in period order: one availability group each. */
  readonly events: readonly Event[];
  readonly defaultLocale: FormLocale;
}>();

const locale = ref<FormLocale>(props.defaultLocale);
const uid = useId();

function pick(fr: string, en: string): string {
  return locale.value === 'en' && en.trim() !== '' ? en : fr;
}

const groups = computed(() =>
  props.events.map((event) => ({
    id: event.id,
    name: event.name,
    days: eventDays(event.period, event.timezone).map((instant) =>
      formatDate(instant, {
        locale: locale.value,
        timeZone: eventTimeZone(event.timezone),
      }),
    ),
  })),
);

/**
 * The volunteer form's own chrome, in the language being previewed rather
 * than the builder's: a coordinator working in English previewing the French
 * form must see «Envoyer», as a volunteer will. `t` only speaks the UI
 * language, so this reads that language's slice of the shared catalogue
 * directly — the same strings the public form renders.
 */
const copy = computed(() =>
  locale.value === 'en' ? sharedEn.volunteerForm : sharedFr.volunteerForm,
);

const fieldId = (question: DraftQuestion, suffix = ''): string =>
  `${uid}-${question.key}${suffix === '' ? '' : `-${suffix}`}`;
</script>

<template>
  <div class="evp-preview">
    <fieldset class="evp-preview-locale">
      <legend>{{ t('forms.preview.locale') }}</legend>
      <label :for="`${uid}-fr`">
        <input :id="`${uid}-fr`" v-model="locale" type="radio" value="fr" />
        <span lang="fr">{{ LOCALE_NAMES.fr }}</span>
      </label>
      <label :for="`${uid}-en`">
        <input :id="`${uid}-en`" v-model="locale" type="radio" value="en" />
        <span lang="en">{{ LOCALE_NAMES.en }}</span>
      </label>
    </fieldset>

    <!-- Real controls, not pictures of them: the preview has a tab of its
         own, so they are not in the builder's tab order, and a coordinator
         can walk the form by keyboard the way a volunteer will. Nothing is
         wired to submit. -->
    <div class="evp-preview-form" :lang="locale">
      <template v-for="question in questions" :key="question.key">
        <div v-if="question.kind === 'section'" class="evp-preview-section">
          <h3>{{ pick(question.labelFr, question.labelEn) }}</h3>
          <p v-if="question.helpFr !== ''">
            {{ pick(question.helpFr, question.helpEn) }}
          </p>
        </div>

        <fieldset
          v-else-if="
            question.kind === 'availability' ||
            question.kind === 'missions' ||
            question.kind === 'multi_choice' ||
            (question.kind === 'single_choice' &&
              (question.options?.length ?? 0) <= RADIO_LIMIT) ||
            (question.kind === 'boolean' && question.isRequired)
          "
          class="evp-preview-question"
        >
          <legend>
            {{ pick(question.labelFr, question.labelEn) }}
            <span v-if="question.isRequired" class="evp-preview-required">
              ({{ copy.required }})
            </span>
          </legend>
          <p v-if="question.helpFr !== ''" class="evp-preview-help">
            {{ pick(question.helpFr, question.helpEn) }}
          </p>

          <template v-if="question.kind === 'availability'">
            <div
              v-for="group in groups"
              :key="group.id"
              class="evp-preview-group"
            >
              <h4>{{ group.name }}</h4>
              <ul>
                <li v-for="day in group.days" :key="day">
                  {{ day }} —
                  <span class="evp-preview-muted">{{ copy.ranges }}</span>
                </li>
              </ul>
            </div>
          </template>

          <!-- Yes and no, neither preselected: an unticked box cannot be told
               apart from an unanswered one, which is the whole reason a
               required boolean is never a lone checkbox (docs/09 §1). -->
          <template v-else-if="question.kind === 'boolean'">
            <label :for="fieldId(question, 'yes')" class="evp-preview-choice">
              <input
                :id="fieldId(question, 'yes')"
                type="radio"
                :name="fieldId(question)"
              />
              {{ copy.yes }}
            </label>
            <label :for="fieldId(question, 'no')" class="evp-preview-choice">
              <input
                :id="fieldId(question, 'no')"
                type="radio"
                :name="fieldId(question)"
              />
              {{ copy.no }}
            </label>
          </template>

          <template v-else>
            <p
              v-if="
                question.kind === 'missions' &&
                (question.options ?? []).length === 0
              "
              class="evp-preview-muted"
            >
              {{ copy.noMissions }}
            </p>
            <label
              v-for="option in question.options ?? []"
              :key="option.key"
              :for="fieldId(question, option.key)"
              class="evp-preview-choice"
            >
              <input
                :id="fieldId(question, option.key)"
                :type="question.kind === 'single_choice' ? 'radio' : 'checkbox'"
                :name="fieldId(question)"
              />
              {{ pick(option.labelFr, option.labelEn) }}
            </label>
          </template>
        </fieldset>

        <div
          v-else-if="question.kind === 'consent' || question.kind === 'boolean'"
          class="evp-preview-question"
        >
          <label
            :for="fieldId(question)"
            class="evp-preview-choice evp-preview-consent"
          >
            <input :id="fieldId(question)" type="checkbox" />
            <span>
              {{ pick(question.labelFr, question.labelEn) }}
              <span v-if="question.isRequired" class="evp-preview-required">
                ({{ copy.required }})
              </span>
            </span>
          </label>
          <p v-if="question.helpFr !== ''" class="evp-preview-help">
            {{ pick(question.helpFr, question.helpEn) }}
          </p>
        </div>

        <div v-else class="evp-preview-question">
          <label :for="fieldId(question)">
            <span class="evp-preview-label">
              {{ pick(question.labelFr, question.labelEn) }}
              <span v-if="question.isRequired" class="evp-preview-required">
                ({{ copy.required }})
              </span>
            </span>
            <span v-if="question.helpFr !== ''" class="evp-preview-help">
              {{ pick(question.helpFr, question.helpEn) }}
            </span>
            <textarea
              v-if="question.kind === 'long_text'"
              :id="fieldId(question)"
              rows="3"
            />
            <select
              v-else-if="question.kind === 'single_choice'"
              :id="fieldId(question)"
            >
              <option value="">{{ copy.choose }}</option>
              <option
                v-for="option in question.options ?? []"
                :key="option.key"
                :value="option.value"
              >
                {{ pick(option.labelFr, option.labelEn) }}
              </option>
            </select>
            <input
              v-else
              :id="fieldId(question)"
              :type="
                question.kind === 'email'
                  ? 'email'
                  : question.kind === 'phone'
                    ? 'tel'
                    : question.kind === 'date'
                      ? 'date'
                      : 'text'
              "
            />
          </label>
        </div>
      </template>

      <button type="button" class="evp-button evp-button--primary">
        {{ copy.submit }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.evp-preview {
  max-width: 36rem;
}

.evp-preview-locale {
  border: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin: 0 0 1rem;
  padding: 0;
}

.evp-preview-locale legend {
  font-weight: 500;
  margin-bottom: 0.25rem;
  width: 100%;
}

.evp-preview-locale label {
  align-items: center;
  display: inline-flex;
  gap: 0.375rem;
}

.evp-preview-form {
  background: var(--evp-surface);
  border: 1px solid var(--evp-border);
  border-radius: 0.5rem;
  padding: 1.25rem;
}

.evp-preview-section h3 {
  font-size: 1.25rem;
  margin: 0 0 0.5rem;
}

.evp-preview-section p {
  margin: 0 0 1.25rem;
  white-space: pre-line;
}

.evp-preview-question {
  border: 0;
  margin: 0 0 1.25rem;
  padding: 0;
}

.evp-preview-question legend,
.evp-preview-label {
  display: block;
  font-weight: 600;
  margin-bottom: 0.375rem;
}

.evp-preview-required {
  color: var(--evp-text-muted);
  font-weight: 400;
}

.evp-preview-help {
  color: var(--evp-text-muted);
  display: block;
  font-size: 0.9375rem;
  margin: 0 0 0.5rem;
  white-space: pre-line;
}

.evp-preview-muted {
  color: var(--evp-text-muted);
}

.evp-preview-choice {
  align-items: center;
  display: flex;
  gap: 0.5rem;
  min-height: 2.75rem;
}

.evp-preview-consent {
  align-items: flex-start;
}

.evp-preview-consent input {
  margin-top: 0.25rem;
}

.evp-preview-question input:not([type='radio'], [type='checkbox']),
.evp-preview-question textarea,
.evp-preview-question select {
  background: var(--evp-surface);
  border: 1px solid var(--evp-border);
  border-radius: 0.375rem;
  color: var(--evp-text);
  font: inherit;
  min-height: 2.75rem;
  padding: 0.5rem 0.75rem;
  width: 100%;
}

.evp-preview-group {
  border-left: 3px solid var(--evp-accent);
  margin: 0 0 0.75rem;
  padding-left: 0.75rem;
}

.evp-preview-group h4 {
  font-size: 1rem;
  margin: 0 0 0.25rem;
}

.evp-preview-group ul {
  margin: 0;
  padding-left: 1.25rem;
}
</style>
