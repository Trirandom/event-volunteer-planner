<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * The one availability question: every day of every event in scope, grouped
 * by event, in period order (docs/09 §3, ADR-0035, ADR-0039).
 *
 * An event that is a single day — every Soundclash night — is a single row
 * titled with the event's name, so a festival form reads as a list of the
 * nights and is answered with a tap each. Only an event of several days gets
 * a heading of its own and the «Tous les jours» shortcut.
 */
import { eventTimeZone, timeZoneLabel } from '@evp/shared/intl';
import { computed, ref } from 'vue';

import type { Question, ScopeEvent } from '../api/publicForm';
import { t } from '../i18n';
import AvailabilityDay from './AvailabilityDay.vue';
import { dayLabel } from './format';
import { dayRows, UNSET, type DayAnswer, type DayStatus } from './model';

const props = defineProps<{
  readonly question: Question;
  readonly label: string;
  readonly help: string | null;
  readonly events: readonly ScopeEvent[];
  readonly answers: Readonly<Record<string, DayAnswer>>;
  readonly locale: 'fr' | 'en';
  /** Row key → message, and the question-level message. */
  readonly rowErrors: Readonly<Record<string, string>>;
  readonly error: string | null;
  readonly id: string;
}>();

const emit = defineEmits<{
  change: [key: string, answer: DayAnswer];
}>();

const groups = computed(() =>
  props.events
    .map((event) => ({ event, rows: dayRows(event) }))
    .filter((g) => g.rows.length > 0),
);

/** docs/16 §5: every time is labelled with its zone, visibly — once per
 * zone, since a festival's events share one. */
const zones = computed(() => {
  const seen = new Map<string, string>();
  for (const { event, rows } of groups.value) {
    const first = rows[0];
    if (first !== undefined && !seen.has(event.timezone)) {
      seen.set(
        event.timezone,
        timeZoneLabel(first.start, {
          locale: props.locale,
          timeZone: eventTimeZone(event.timezone),
        }),
      );
    }
  }
  return [...seen.values()];
});

const announcement = ref('');

function change(key: string, answer: DayAnswer, spoken: string): void {
  emit('change', key, answer);
  announcement.value = spoken;
}

function setAll(
  group: (typeof groups.value)[number],
  status: Exclude<DayStatus, 'unset' | 'partial'>,
): void {
  for (const row of group.rows) {
    emit('change', row.key, {
      status,
      ranges: (props.answers[row.key] ?? UNSET).ranges,
    });
  }
  announcement.value = t('availability.allDaysSet', {
    count: group.rows.length,
    answer: t(status === 'all' ? 'availability.yes' : 'availability.no'),
  });
}

const errorId = computed(() => `${props.id}-error`);
const helpId = computed(() => `${props.id}-help`);
</script>

<template>
  <fieldset
    :id="id"
    class="evp-availability"
    tabindex="-1"
    :aria-describedby="
      [help === null ? '' : helpId, error === null ? '' : errorId]
        .join(' ')
        .trim() || undefined
    "
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
    <p class="evp-question-help">
      <template v-for="zone in zones" :key="zone"
        >{{ t('availability.timeZone', { zone }) }}
      </template>
    </p>
    <p v-if="error !== null" :id="errorId" class="evp-question-error">
      {{ error }}
    </p>

    <div class="evp-availability-groups">
      <template v-for="group in groups" :key="group.event.id">
        <AvailabilityDay
          v-if="group.rows.length === 1 && group.rows[0] !== undefined"
          :id="`${id}-${group.rows[0].key}`"
          :event="group.event"
          :row="group.rows[0]"
          :answer="answers[group.rows[0].key] ?? UNSET"
          :locale="locale"
          :title="`${group.event.name} — ${dayLabel(group.rows[0], { locale, timeZone: group.event.timezone })}`"
          :error="rowErrors[group.rows[0].key] ?? null"
          @change="
            (answer, spoken) =>
              group.rows[0] && change(group.rows[0].key, answer, spoken)
          "
        />

        <section v-else class="evp-availability-event">
          <div class="evp-availability-event-head">
            <h3 class="evp-availability-event-name">{{ group.event.name }}</h3>
            <div
              class="evp-bulk"
              role="group"
              :aria-label="
                t('availability.allDays', { event: group.event.name })
              "
            >
              <span aria-hidden="true" class="evp-bulk-label">{{
                t('availability.allDays', { event: group.event.name })
              }}</span>
              <button
                type="button"
                class="evp-button-secondary"
                @click="setAll(group, 'all')"
              >
                {{ t('availability.yes') }}
              </button>
              <button
                type="button"
                class="evp-button-secondary"
                @click="setAll(group, 'no')"
              >
                {{ t('availability.no') }}
              </button>
            </div>
          </div>
          <AvailabilityDay
            v-for="row in group.rows"
            :id="`${id}-${row.key}`"
            :key="row.key"
            :event="group.event"
            :row="row"
            :answer="answers[row.key] ?? UNSET"
            :locale="locale"
            :title="dayLabel(row, { locale, timeZone: group.event.timezone })"
            :error="rowErrors[row.key] ?? null"
            @change="(answer, spoken) => change(row.key, answer, spoken)"
          />
        </section>
      </template>
    </div>

    <p class="evp-visually-hidden" aria-live="polite">{{ announcement }}</p>
  </fieldset>
</template>

<style scoped>
.evp-availability {
  border: 0;
  margin: 0;
  min-width: 0;
  padding: 0;
}

.evp-availability-groups {
  display: grid;
  gap: 0.75rem;
  margin-top: 0.75rem;
}

.evp-availability-event {
  display: grid;
  gap: 0.5rem;
}

.evp-availability-event-head {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  justify-content: space-between;
}

.evp-availability-event-name {
  font-size: 1.0625rem;
  margin: 0;
}

.evp-bulk {
  align-items: center;
  display: flex;
  gap: 0.375rem;
}

.evp-bulk-label {
  color: var(--evp-text-muted);
  font-size: 0.875rem;
}
</style>
