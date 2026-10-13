<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * Every question kind but `availability` and `section`.
 *
 * Native inputs throughout (docs/14 §5), each with the `type`, `inputmode`
 * and `autocomplete` that summon the right phone keyboard and let the
 * browser fill a name, an address and a number the volunteer has typed a
 * hundred times before. A built-in's `target_path` says what it is, so it is
 * what picks the autocomplete token — never the label, which the
 * coordinator may word however they like.
 */
import { computed, useId } from 'vue';

import type { AnswerValue, Question } from '../api/publicForm';
import { t } from '../i18n';

const props = defineProps<{
  readonly question: Question;
  readonly label: string;
  readonly help: string | null;
  readonly optionLabels: readonly {
    readonly value: string;
    readonly label: string;
    readonly adultsOnly: boolean;
  }[];
  readonly value: AnswerValue | undefined;
  readonly error: string | null;
  readonly id: string;
}>();

const emit = defineEmits<{ change: [value: AnswerValue] }>();

const uid = useId();
const helpId = `${uid}-help`;
const errorId = `${uid}-error`;

/** docs/09 §1: a single choice is a radio group until it would be a long
 * scroll, then a select. Six is where the admin preview draws the line. */
const RADIO_LIMIT = 6;

const describedBy = computed(
  () =>
    [props.help === null ? '' : helpId, props.error === null ? '' : errorId]
      .join(' ')
      .trim() || undefined,
);

const AUTOCOMPLETE: Readonly<Record<string, string>> = {
  'volunteer.first_name': 'given-name',
  'volunteer.last_name': 'family-name',
  'volunteer.email': 'email',
  'volunteer.phone': 'tel',
};

const autocomplete = computed(
  () => AUTOCOMPLETE[props.question.target_path ?? ''] ?? 'off',
);

const asText = computed(() =>
  typeof props.value === 'string' ? props.value : '',
);
const asList = computed(() => (Array.isArray(props.value) ? props.value : []));

const grouped = computed(
  () =>
    props.question.kind === 'multi_choice' ||
    props.question.kind === 'missions' ||
    (props.question.kind === 'single_choice' &&
      props.optionLabels.length <= RADIO_LIMIT) ||
    (props.question.kind === 'boolean' && props.question.is_required),
);

function text(event: Event): void {
  const target = event.target;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    emit('change', target.value);
  }
}

function toggle(option: string, checked: boolean): void {
  emit(
    'change',
    checked
      ? [...asList.value, option]
      : asList.value.filter((v) => v !== option),
  );
}

function checked(event: Event): boolean {
  return event.target instanceof HTMLInputElement && event.target.checked;
}
</script>

<template>
  <!-- Grouped kinds: the question is the legend, so a screen reader names the
       group before the first option (docs/09 §1 on the age question). -->
  <fieldset
    v-if="grouped"
    :id="id"
    class="evp-question"
    tabindex="-1"
    :aria-describedby="describedBy"
    :aria-invalid="error === null ? undefined : 'true'"
  >
    <legend class="evp-question-label">
      {{ label }}
      <span v-if="question.is_required" class="evp-required"
        >({{ t('form.required') }})</span
      >
    </legend>
    <p v-if="help !== null" :id="helpId" class="evp-question-help">
      {{ help }}
    </p>
    <p v-if="error !== null" :id="errorId" class="evp-question-error">
      {{ error }}
    </p>

    <!-- Yes and no, neither preselected: an unticked box cannot be told
         apart from an unanswered one (docs/09 §1). -->
    <div
      v-if="question.kind === 'boolean'"
      class="evp-choices evp-choices-inline"
    >
      <label
        v-for="choice in [true, false]"
        :key="String(choice)"
        class="evp-choice"
        :for="`${uid}-${String(choice)}`"
      >
        <input
          :id="`${uid}-${String(choice)}`"
          type="radio"
          :name="uid"
          :checked="value === choice"
          @change="emit('change', choice)"
        />
        <span>{{ choice ? t('form.yes') : t('form.no') }}</span>
      </label>
    </div>

    <p v-else-if="optionLabels.length === 0" class="evp-question-help">
      {{ t('form.noMissions') }}
    </p>

    <div v-else class="evp-choices">
      <label
        v-for="option in optionLabels"
        :key="option.value"
        class="evp-choice"
        :for="`${uid}-${option.value}`"
      >
        <input
          v-if="question.kind === 'single_choice'"
          :id="`${uid}-${option.value}`"
          type="radio"
          :name="uid"
          :value="option.value"
          :checked="value === option.value"
          @change="emit('change', option.value)"
        />
        <input
          v-else
          :id="`${uid}-${option.value}`"
          type="checkbox"
          :value="option.value"
          :checked="asList.includes(option.value)"
          @change="toggle(option.value, checked($event))"
        />
        <span>{{ option.label }}</span>
        <span v-if="option.adultsOnly" class="evp-badge">{{
          t('form.adultsOnly')
        }}</span>
      </label>
    </div>
  </fieldset>

  <!-- A checkbox is a consent control, or an optional yes/no whose unticked
       state is itself the answer "no". The help is what is being agreed to,
       so it sits in the same callout as the box; it stays outside the
       `<label>` so it describes the checkbox rather than becoming its name. -->
  <div
    v-else-if="question.kind === 'consent' || question.kind === 'boolean'"
    class="evp-question evp-consent"
    :class="{
      'evp-consent-checked': value === true,
      'evp-consent-invalid': error !== null,
    }"
  >
    <label :for="id" class="evp-choice evp-choice-consent">
      <input
        :id="id"
        type="checkbox"
        :checked="value === true"
        :aria-describedby="describedBy"
        :aria-invalid="error === null ? undefined : 'true'"
        @change="emit('change', checked($event))"
      />
      <span>
        {{ label }}
        <span v-if="question.is_required" class="evp-required"
          >({{ t('form.required') }})</span
        >
      </span>
    </label>
    <p
      v-if="help !== null"
      :id="helpId"
      class="evp-question-help evp-consent-help"
    >
      {{ help }}
    </p>
    <p v-if="error !== null" :id="errorId" class="evp-question-error">
      {{ error }}
    </p>
  </div>

  <!-- The label wraps its control, and names it through `aria-labelledby`
       so the help text between them describes the field rather than
       becoming part of its name. -->
  <label v-else :for="id" class="evp-question">
    <span :id="`${uid}-label`" class="evp-question-label">
      {{ label }}
      <span v-if="question.is_required" class="evp-required"
        >({{ t('form.required') }})</span
      >
    </span>
    <span v-if="help !== null" :id="helpId" class="evp-question-help">{{
      help
    }}</span>

    <textarea
      v-if="question.kind === 'long_text'"
      :id="id"
      class="evp-field"
      rows="3"
      maxlength="2000"
      :value="asText"
      :aria-labelledby="`${uid}-label`"
      :aria-describedby="describedBy"
      :aria-invalid="error === null ? undefined : 'true'"
      :aria-required="question.is_required"
      @input="text"
    />
    <select
      v-else-if="question.kind === 'single_choice'"
      :id="id"
      class="evp-field"
      :value="asText"
      :aria-labelledby="`${uid}-label`"
      :aria-describedby="describedBy"
      :aria-invalid="error === null ? undefined : 'true'"
      :aria-required="question.is_required"
      @change="text"
    >
      <option value="">{{ t('form.choose') }}</option>
      <option
        v-for="option in optionLabels"
        :key="option.value"
        :value="option.value"
      >
        {{ option.label }}
      </option>
    </select>
    <input
      v-else
      :id="id"
      class="evp-field"
      :type="
        question.kind === 'email'
          ? 'email'
          : question.kind === 'phone'
            ? 'tel'
            : question.kind === 'date'
              ? 'date'
              : 'text'
      "
      :inputmode="
        question.kind === 'email'
          ? 'email'
          : question.kind === 'phone'
            ? 'tel'
            : undefined
      "
      :autocomplete="autocomplete"
      :autocapitalize="question.kind === 'email' ? 'off' : undefined"
      :spellcheck="
        question.kind === 'email' || question.kind === 'phone'
          ? false
          : undefined
      "
      maxlength="200"
      :value="asText"
      :aria-labelledby="`${uid}-label`"
      :aria-describedby="describedBy"
      :aria-invalid="error === null ? undefined : 'true'"
      :aria-required="question.is_required"
      @input="text"
    />
    <span v-if="error !== null" :id="errorId" class="evp-question-error">{{
      error
    }}</span>
  </label>
</template>

<style scoped>
.evp-question {
  border: 0;
  display: grid;
  gap: 0.375rem;
  margin: 0;
  min-width: 0;
  padding: 0;
}

.evp-field {
  width: 100%;
}

.evp-choices {
  display: grid;
  gap: 0.375rem;
}

.evp-choices-inline {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

/* The whole row is the target, not the 16 px box inside it. */
.evp-choice {
  align-items: center;
  border: 1px solid var(--evp-border);
  border-radius: 0.5rem;
  cursor: pointer;
  display: flex;
  gap: 0.625rem;
  min-height: 2.75rem;
  padding: 0.375rem 0.75rem;
}

.evp-choice:has(input:checked) {
  background: var(--evp-surface-raised);
  border-color: var(--evp-accent);
  font-weight: 600;
}

.evp-choice input {
  accent-color: var(--evp-accent);
  flex: none;
  height: 1.25rem;
  margin: 0;
  width: 1.25rem;
}

/* A callout, not a box: a full outline next to the text fields read as one
 * more input. The bar turns accent once ticked, danger on error. */
.evp-consent {
  background: var(--evp-surface-raised);
  border-left: 3px solid var(--evp-border);
  border-radius: 0.25rem 0.5rem 0.5rem 0.25rem;
  padding: 0.75rem 1rem;
}

.evp-consent-checked {
  border-left-color: var(--evp-accent);
}

.evp-consent-invalid {
  border-left-color: var(--evp-danger);
}

.evp-choice-consent,
.evp-choice-consent:has(input:checked) {
  align-items: flex-start;
  background: none;
  border: 0;
  border-radius: 0;
  min-height: 0;
  padding: 0;
}

.evp-choice-consent input {
  margin-top: 0.125rem;
}

/* Beside the label, not in it: the label stays the mission's name, and the
 * badge reads as a property of it. Pushed to the row's end so a column of
 * missions lines up. */
.evp-badge {
  border: 1px solid var(--evp-border);
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
  margin-left: auto;
  padding: 0.0625rem 0.5rem;
  white-space: nowrap;
}

/* Under the label text, not under the box: box width + row gap. */
.evp-consent .evp-question-help,
.evp-consent .evp-question-error {
  padding-left: 1.875rem;
}
</style>
