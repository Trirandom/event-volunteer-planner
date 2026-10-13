<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * One event day: «Oui» / «En partie» / «Non» (ADR-0039).
 *
 * Three native radios, so the platform gives the group its keyboard model
 * (arrows move, one tab stop) and its screen-reader role for free
 * (docs/14 §5). They are drawn as one segmented bar because a volunteer
 * answering six nights on a phone should be able to do it with six thumbs,
 * without reading a list of options each time.
 *
 * Precision lives behind «En partie» and nowhere else: chips first, since
 * most partial answers are "the evening", and a typed range behind a native
 * `<details>` for the volunteer who means 20h → 5h.
 */
import { computed, ref, useId } from 'vue';

import type { ScopeEvent } from '../api/publicForm';
import { t } from '../i18n';
import {
  chipName,
  dayLabel,
  rangeEnds,
  rangeText,
  statusSpoken,
  type Zoned,
} from './format';
import {
  chipsFor,
  clamp,
  epoch,
  covers,
  normalize,
  subtract,
  toggleChip,
  typedRange,
  type DayAnswer,
  type DayRow,
  type DayStatus,
  type Range,
} from './model';

const props = defineProps<{
  readonly event: ScopeEvent;
  readonly row: DayRow;
  readonly answer: DayAnswer;
  readonly locale: 'fr' | 'en';
  /** The event's name is the legend when the event is a single day. */
  readonly title: string;
  readonly error: string | null;
  readonly id: string;
}>();

const emit = defineEmits<{
  change: [answer: DayAnswer, spoken: string];
}>();

const uid = useId();
const zone = computed<Zoned>(() => ({
  locale: props.locale,
  timeZone: props.event.timezone,
}));
const day = computed(() => dayLabel(props.row, zone.value));
const hours = computed(() => rangeText(props.row, props.row, zone.value));

/** Context, never a bound: availability is clamped to the operational
 * period, and the public hours only help a volunteer place it (ADR-0044). */
const publicHours = computed(() => {
  const period = props.event.public_period;
  if (period == null) {
    return null;
  }
  const range = clamp(
    { start: epoch(period.start), end: epoch(period.end) },
    props.row,
  );
  return range === null
    ? null
    : t('availability.publicHours', rangeEnds(range, props.row, zone.value));
});

const chips = computed(() => chipsFor(props.event, props.row));
const ranges = computed(() => normalize(props.answer.ranges));

const STATUSES: readonly {
  value: Exclude<DayStatus, 'unset'>;
  key: 'yes' | 'partial' | 'no';
}[] = [
  { value: 'all', key: 'yes' },
  { value: 'partial', key: 'partial' },
  { value: 'no', key: 'no' },
];

function commit(next: DayAnswer): void {
  emit('change', next, statusSpoken(props.row, next, zone.value, day.value));
}

function choose(status: DayStatus): void {
  commit({ status, ranges: props.answer.ranges });
}

function chipPressed(range: Range): boolean {
  return covers(ranges.value, range);
}

// ── Typed range ────────────────────────────────────────────────────────────

const fromText = ref('');
const toText = ref('');
const typedNote = ref<{ kind: 'error' | 'info'; text: string } | null>(null);

function addTyped(): void {
  const result = typedRange(
    fromText.value,
    toText.value,
    props.row,
    props.event.timezone,
    props.event.availability_step_minutes,
  );
  if (!result.ok) {
    typedNote.value = {
      kind: 'error',
      text:
        result.reason === 'unreadable'
          ? t('availability.unreadable')
          : t('availability.outside', rangeParts(props.row)),
    };
    return;
  }
  typedNote.value = result.adjusted
    ? {
        kind: 'info',
        text: t('availability.adjusted', {
          ...rangeParts(result.range),
          step: props.event.availability_step_minutes,
        }),
      }
    : null;
  fromText.value = '';
  toText.value = '';
  commit({
    status: 'partial',
    ranges: normalize([...props.answer.ranges, result.range]),
  });
}

function rangeParts(range: Range): { start: string; end: string } {
  return rangeEnds(range, props.row, zone.value);
}

function remove(range: Range): void {
  commit({ status: 'partial', ranges: subtract(props.answer.ranges, range) });
}

const errorId = computed(() => `${props.id}-error`);
</script>

<template>
  <fieldset
    :id="id"
    class="evp-day"
    :class="{ 'evp-day-invalid': error !== null }"
    :aria-describedby="error === null ? undefined : errorId"
    tabindex="-1"
  >
    <legend class="evp-day-legend">
      <span class="evp-day-title">{{ title }}</span>
      <span class="evp-day-hours">
        {{ hours }}
        <template v-if="publicHours !== null">· {{ publicHours }}</template>
      </span>
    </legend>

    <div class="evp-seg">
      <label
        v-for="option in STATUSES"
        :key="option.value"
        :for="`${uid}-${option.value}`"
        class="evp-seg-option"
      >
        <input
          :id="`${uid}-${option.value}`"
          type="radio"
          class="evp-seg-input"
          :name="`${uid}-status`"
          :value="option.value"
          :checked="answer.status === option.value"
          @change="choose(option.value)"
        />
        <span class="evp-seg-label">{{ t(`availability.${option.key}`) }}</span>
      </label>
    </div>

    <p v-if="error !== null" :id="errorId" class="evp-day-error">{{ error }}</p>

    <div v-if="answer.status === 'partial'" class="evp-partial">
      <div
        v-if="chips.length > 0"
        class="evp-chips"
        role="group"
        :aria-label="t('availability.chipsLegend')"
      >
        <button
          v-for="chip in chips"
          :key="chip.key"
          type="button"
          class="evp-chip"
          :aria-pressed="chipPressed(chip.range)"
          @click="commit(toggleChip(answer, chip))"
        >
          <span class="evp-chip-name">{{ chipName(chip, locale) }}</span>
          <span class="evp-chip-hours">{{
            rangeText(chip.range, row, zone)
          }}</span>
        </button>
      </div>

      <details class="evp-custom" :open="chips.length === 0">
        <summary class="evp-custom-toggle">
          {{ t('availability.custom') }}
        </summary>
        <div class="evp-custom-body">
          <p :id="`${uid}-hint`" class="evp-custom-hint">
            {{ t('availability.timeHint') }}
          </p>
          <div class="evp-custom-fields">
            <label :for="`${uid}-from`" class="evp-custom-field">
              <span>{{ t('availability.from') }}</span>
              <input
                :id="`${uid}-from`"
                v-model="fromText"
                type="text"
                inputmode="decimal"
                autocomplete="off"
                enterkeyhint="next"
                maxlength="5"
                :aria-describedby="`${uid}-hint`"
                @keydown.enter.prevent="addTyped"
              />
            </label>
            <label :for="`${uid}-to`" class="evp-custom-field">
              <span>{{ t('availability.to') }}</span>
              <input
                :id="`${uid}-to`"
                v-model="toText"
                type="text"
                inputmode="decimal"
                autocomplete="off"
                enterkeyhint="done"
                maxlength="5"
                :aria-describedby="`${uid}-hint`"
                @keydown.enter.prevent="addTyped"
              />
            </label>
            <button
              type="button"
              class="evp-button-secondary"
              @click="addTyped"
            >
              {{ t('availability.add') }}
            </button>
          </div>
          <p
            v-if="typedNote !== null"
            class="evp-custom-note"
            :class="{ 'evp-custom-note-error': typedNote.kind === 'error' }"
            role="status"
          >
            {{ typedNote.text }}
          </p>
        </div>
      </details>

      <div v-if="ranges.length > 0" class="evp-selected">
        <span class="evp-selected-label">{{ t('availability.selected') }}</span>
        <ul class="evp-selected-list">
          <li
            v-for="range in ranges"
            :key="range.start"
            class="evp-selected-item"
          >
            <span>{{ rangeText(range, row, zone) }}</span>
            <button
              type="button"
              class="evp-selected-remove"
              :aria-label="t('availability.removeSpoken', rangeParts(range))"
              @click="remove(range)"
            >
              {{ t('availability.remove') }}
            </button>
          </li>
        </ul>
      </div>
    </div>

    <!-- The whole row as a sentence, for the screen reader that would
         otherwise have to assemble it from three radios and a list. -->
    <p class="evp-visually-hidden">
      {{ statusSpoken(row, answer, zone, day) }}
    </p>
  </fieldset>
</template>

<style scoped>
.evp-day {
  border: 1px solid var(--evp-border);
  border-radius: 0.75rem;
  margin: 0;
  min-width: 0;
  padding: 0.75rem;
}

/* docs/14 §2: the error is a border *and* a sentence, never a colour alone. */
.evp-day-invalid {
  border-color: var(--evp-danger);
  border-left-width: 4px;
}

.evp-day-legend {
  display: flex;
  flex-direction: column;
  float: left; /* Lets the legend sit inside the padding box like any block. */
  margin-bottom: 0.625rem;
  padding: 0;
  width: 100%;
}

.evp-day-legend + * {
  clear: both;
}

.evp-day-title {
  font-weight: 600;
}

.evp-day-hours {
  color: var(--evp-text-muted);
  font-size: 0.875rem;
  font-variant-numeric: tabular-nums;
}

/* Three equal segments that fill the width at 320 px. The radio stays in the
   accessibility tree and in the tab order; only its drawing is replaced. */
.evp-seg {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.375rem;
}

.evp-seg-option {
  position: relative;
}

.evp-seg-input {
  appearance: none;
  inset: 0;
  margin: 0;
  opacity: 0;
  /* The label takes the tap and forwards it; the input only has to be
     focusable and announced. */
  pointer-events: none;
  position: absolute;
}

.evp-seg-label {
  align-items: center;
  border: 1px solid var(--evp-border);
  border-radius: 0.5rem;
  cursor: pointer;
  display: flex;
  font-weight: 500;
  gap: 0.25rem;
  justify-content: center;
  min-height: 2.75rem; /* 44 px, docs/09 §3 */
  padding: 0.25rem 0.375rem;
  text-align: center;
}

/* Selected is a fill, a heavier border and a tick, so it reads in forced
   colours and to someone who cannot tell the greens apart (docs/09 §3). */
.evp-seg-input:checked + .evp-seg-label {
  background: var(--evp-accent);
  border-color: var(--evp-accent);
  color: var(--evp-on-accent);
  font-weight: 700;
}

.evp-seg-input:checked + .evp-seg-label::before {
  content: '✓';
}

.evp-seg-input:focus-visible + .evp-seg-label {
  outline: 2px solid var(--evp-focus);
  outline-offset: 2px;
}

.evp-day-error {
  color: var(--evp-danger);
  font-size: 0.875rem;
  font-weight: 600;
  margin: 0.5rem 0 0;
}

.evp-partial {
  display: grid;
  gap: 0.75rem;
  margin-top: 0.75rem;
}

.evp-chips {
  display: grid;
  gap: 0.375rem;
  grid-template-columns: repeat(auto-fill, minmax(8.5rem, 1fr));
}

.evp-chip {
  align-items: flex-start;
  background: var(--evp-surface);
  border: 1px dashed var(--evp-border);
  border-radius: 0.5rem;
  color: var(--evp-text);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  font: inherit;
  min-height: 2.75rem;
  padding: 0.375rem 0.625rem;
  text-align: left;
}

.evp-chip[aria-pressed='true'] {
  background: var(--evp-surface-raised);
  border: 2px solid var(--evp-accent);
  padding: calc(0.375rem - 1px) calc(0.625rem - 1px);
}

.evp-chip[aria-pressed='true'] .evp-chip-name::before {
  content: '✓ ';
}

.evp-chip-name {
  font-weight: 600;
}

.evp-chip-hours {
  color: var(--evp-text-muted);
  font-size: 0.8125rem;
  font-variant-numeric: tabular-nums;
}

.evp-custom-toggle {
  color: var(--evp-accent);
  cursor: pointer;
  font-weight: 600;
  min-height: 2.75rem;
  display: flex;
  align-items: center;
  width: fit-content;
}

.evp-custom-body {
  display: grid;
  gap: 0.5rem;
}

.evp-custom-hint {
  color: var(--evp-text-muted);
  font-size: 0.875rem;
  margin: 0;
}

.evp-custom-fields {
  align-items: end;
  display: grid;
  gap: 0.5rem;
  grid-template-columns: 1fr 1fr auto;
}

.evp-custom-field {
  display: grid;
  font-size: 0.875rem;
  font-weight: 600;
  gap: 0.25rem;
}

.evp-custom-field input {
  font-variant-numeric: tabular-nums;
  width: 100%;
}

.evp-custom-note {
  font-size: 0.875rem;
  margin: 0;
}

.evp-custom-note-error {
  color: var(--evp-danger);
  font-weight: 600;
}

.evp-selected {
  display: grid;
  gap: 0.25rem;
}

.evp-selected-label {
  font-size: 0.875rem;
  font-weight: 600;
}

.evp-selected-list {
  display: grid;
  gap: 0.375rem;
  list-style: none;
  margin: 0;
  padding: 0;
}

.evp-selected-item {
  align-items: center;
  background: var(--evp-surface-raised);
  border: 1px solid var(--evp-accent);
  border-radius: 0.5rem;
  display: flex;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  justify-content: space-between;
  padding-left: 0.75rem;
}

.evp-selected-remove {
  background: none;
  border: 0;
  color: var(--evp-accent);
  cursor: pointer;
  font: inherit;
  font-weight: 500;
  min-height: 2.75rem;
  padding: 0 0.75rem;
  text-decoration: underline;
}
</style>
