<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * Form submissions — what volunteers answered, and when they can work.
 *
 * It sits under the festival rather than under a day because that is where it
 * belongs: a volunteer fills the form once for Soundclash 26 and declares
 * windows across the production (docs/09 §3 — availability is windows across
 * the whole thing, not a separate answer per event). The day strip above
 * narrows this list the same way it narrows the missions list, and narrowing
 * is a filter over one cached response rather than a second query —
 * `plan/submissions.ts` is that filter and is where the reasoning lives.
 *
 * **Availability is shown as declared, never as a slot.** The old sheet had
 * to ask five times and could only offer fixed labels, which is the defect
 * docs/09 opens with; a volunteer who said 14:00–19:30 has their 14:00–19:30
 * rendered here, in their event's own zone (docs/16 §1, ADR-0019), with the
 * date on both ends whenever a night laps midnight.
 *
 * **A table, so volunteers can be compared.** One row per volunteer and one
 * column per question anyone answered (`plan/submissionTable.ts` decides the
 * columns and why), with a filter above each column and a live count of what
 * is left. The availability cell carries only the total; the windows fold out
 * under the row on demand, because reading and adjusting them in detail is
 * the availability page's job and it is one link away.
 *
 * The window chips carry the day's palette colour. That is the same pairing the
 * board establishes (`board/eventLanes.ts`): a coordinator who has been
 * reading 03:00 bar shifts in Dub & 2step's colour should not have to re-read
 * a date to know which night an offer of 03:00 belongs to.
 *
 * Read-only for now. Turning an offer into an assignment is the roster's job
 * and needs the candidate panel (docs/05); this page is the evidence that
 * panel will be built on.
 */
import { eventColor } from '@evp/shared';
import { eventTimeZone, formatDate, formatTime } from '@evp/shared/intl';
import { Temporal } from '@evp/shared/time';
import { computed, ref, watch } from 'vue';

import { usePlanScope } from '../api/usePlan';
import { useReviewQueue } from '../api/useReviewQueue';
import { useSubmissions } from '../api/useSubmissions';
import { formatPeriod, type PeriodDisplay } from '../format/period';
import { focusedEventId } from '../plan/scope';
import { locale, t } from '../i18n';
import {
  answerColumns,
  filterSubmissionRows,
  hasActiveFilters,
  type SubmissionFilters,
} from '../plan/submissionTable';
import { buildSubmissionBoard, durationLabel } from '../plan/submissions';
import { useRouteParam } from '../router/params';

const orgId = useRouteParam('orgId');
const festivalId = useRouteParam('festivalId');
const eventId = useRouteParam('eventId');

const { scope, isPending: scopeIsPending } = usePlanScope(
  orgId,
  festivalId,
  eventId,
);

/**
 * The festival the submissions belong to, whichever URL was taken.
 *
 * Empty for a standalone event, which has no production behind it and so no
 * form — that is a real state with its own copy below, not a failure.
 */
const subjectFestivalId = computed(() => scope.value?.festival?.id ?? '');

const { data: submissionsResult } = useSubmissions(orgId, subjectFestivalId, {
  enabled: computed(() => subjectFestivalId.value !== ''),
});

const submissions = computed(() =>
  submissionsResult.value?.ok === true ? submissionsResult.value.value : [],
);

const submissionsFailed = computed(() => submissionsResult.value?.ok === false);

/**
 * How many submissions wait for a coordinator (the review sub-page). Read
 * here only for the count: a submission there is in nobody's row below, and
 * the link is how anyone finds out it exists.
 */
const { data: reviewResult } = useReviewQueue(orgId, {
  enabled: computed(() => subjectFestivalId.value !== ''),
});
const waitingForReview = computed(() =>
  reviewResult.value?.ok === true ? reviewResult.value.value.length : 0,
);
const reviewRoute = computed(() =>
  eventId.value === ''
    ? 'org-festival-submissions-review'
    : 'org-event-submissions-review',
);

/** Settled, not `isPending`: a disabled query reports itself pending forever,
 * and this one is disabled until the scope has resolved a festival. Same
 * reasoning as `usePlanScope`'s own `settled`. */
const isPending = computed(
  () =>
    scopeIsPending.value ||
    (subjectFestivalId.value !== '' && submissionsResult.value === undefined),
);

const board = computed(() => {
  const value = scope.value;
  if (value === null) {
    return { rows: [], total: 0, hiddenByScope: 0 };
  }
  return buildSubmissionBoard(
    submissions.value,
    value.days,
    focusedEventId(value),
  );
});

const selectedName = computed(() => scope.value?.selected?.name ?? null);

/**
 * The rows with every instant already rendered.
 *
 * Formatted here rather than in the template so that `Intl` runs once per
 * window per change instead of once per re-render — a festival with seventy
 * volunteers is a few hundred formatted readings, and the formatter cache in
 * `@evp/shared/intl` only helps with construction, not with the calls.
 */
const tableRows = computed(() =>
  board.value.rows.map((row) => {
    // First answer wins if a form version ever asked the same question twice:
    // a cell holds one answer, and the earlier one is what was asked first.
    const answers = new Map<string, string>();
    for (const answer of row.answers) {
      if (!answers.has(answer.question)) {
        answers.set(answer.question, answer.value);
      }
    }
    return {
      id: row.id,
      displayName: row.displayName,
      lastName: row.lastName,
      name:
        row.lastName === null
          ? row.displayName
          : `${row.displayName} ${row.lastName}`,
      submitted: submittedLabel(row.submittedAt),
      answers,
      eventIds: [...new Set(row.windows.map((window) => window.eventId))],
      total:
        row.windows.length === 0
          ? null
          : {
              duration: durationLabel(row.minutes),
              dayCount: row.dayCount,
            },
      windows: row.windows.map((window) => ({
        key: `${window.eventId}:${window.period.start}`,
        eventName: window.eventName,
        color: eventColor(window.color),
        duration: durationLabel(window.minutes),
        ...windowReading(
          formatPeriod(window.period, window.timezone, locale.value),
        ),
      })),
    };
  }),
);

/** One column per question anyone answered (`plan/submissionTable.ts`). */
const columns = computed(() => answerColumns(tableRows.value));

// ── Filters ────────────────────────────────────────────────────────────────
//
// One per column, in a row under the headers so each sits above what it
// narrows. Held here rather than in the URL: they are a way of reading the
// page for a minute, not a view anyone links to.

const nameFilter = ref('');
const submittedFilter = ref('');
/** `''` any, `NONE` nothing declared, otherwise an event id. */
const availabilityFilter = ref('');
const answerFilters = ref<Record<string, string>>({});

const NONE = '__none';

/** The days a volunteer can be filtered on: every day in scope, or only the
 * one the day strip narrowed to. */
const dayOptions = computed(() => {
  const value = scope.value;
  if (value === null) {
    return [];
  }
  const focused = focusedEventId(value);
  return value.days
    .filter((day) => focused === null || day.id === focused)
    .map((day) => ({ id: day.id, name: day.name }));
});

/** Only at festival scope: a day in front of the coordinator has already
 * removed everyone who offered nothing on it, so "none" would always be empty. */
const offersNoneOption = computed(
  () => scope.value !== null && focusedEventId(scope.value) === null,
);

// A day filter the strip has since made meaningless is cleared rather than
// left silently hiding every row.
watch([dayOptions, offersNoneOption], () => {
  const current = availabilityFilter.value;
  if (current === '') {
    return;
  }
  const stillOffered =
    current === NONE
      ? offersNoneOption.value
      : dayOptions.value.some((day) => day.id === current);
  if (!stillOffered) {
    availabilityFilter.value = '';
  }
});

const filters = computed<SubmissionFilters>(() => ({
  name: nameFilter.value,
  submitted: submittedFilter.value,
  availability:
    availabilityFilter.value === ''
      ? { kind: 'any' }
      : availabilityFilter.value === NONE
        ? { kind: 'none' }
        : { kind: 'day', eventId: availabilityFilter.value },
  answers: answerFilters.value,
}));

const visibleRows = computed(() =>
  filterSubmissionRows(tableRows.value, columns.value, filters.value),
);

const filtering = computed(() => hasActiveFilters(filters.value));

function setAnswerFilter(key: string, value: string): void {
  answerFilters.value = { ...answerFilters.value, [key]: value };
}

function resetFilters(): void {
  nameFilter.value = '';
  submittedFilter.value = '';
  availabilityFilter.value = '';
  answerFilters.value = {};
}

function inputValue(event: Event): string {
  const target = event.target;
  return target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement
    ? target.value
    : '';
}

// ── Expanded availability ──────────────────────────────────────────────────
//
// The windows fold out under their row rather than widening it: the detail is
// the availability page's job, and the table's is to line volunteers up
// against each other.

const expanded = ref(new Set<string>());

function toggle(id: string): void {
  const next = new Set(expanded.value);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  expanded.value = next;
}

/** Name, submitted, availability, then one per question. */
const columnCount = computed(() => 3 + columns.value.length);

const availabilityRoute = computed(() =>
  eventId.value === '' ? 'org-festival-availability' : 'org-event-availability',
);
const scopeParams = computed(() =>
  eventId.value === ''
    ? { orgId: orgId.value, festivalId: festivalId.value }
    : { orgId: orgId.value, eventId: eventId.value },
);

/** A window's time range and zone, as the chip prints them. Both dates only
 * when the night laps midnight — the case `formatPeriod` flags. */
function windowReading(display: PeriodDisplay): {
  readonly range: string;
  readonly zone: string;
} {
  return {
    range: display.spansMultipleDays
      ? t('submissions.window.rangeAcrossDays', {
          startDate: display.startDate,
          startTime: display.startTime,
          endDate: display.endDate,
          endTime: display.endTime,
        })
      : t('submissions.window.range', {
          startDate: display.startDate,
          startTime: display.startTime,
          endTime: display.endTime,
        }),
    zone: display.timeZoneLabel,
  };
}

/**
 * When the form was answered, in the festival's zone.
 *
 * The festival's and not the volunteer's: a coordinator reading "yesterday
 * evening" means their own event's evening, and the submission carries no
 * zone of its own to render in anyway.
 */
function submittedLabel(instant: string): string {
  const festival = scope.value?.festival;
  if (festival === undefined || festival === null) {
    return t('submissions.card.submittedAt', { when: instant });
  }
  const epochMilliseconds = Temporal.Instant.from(instant).epochMilliseconds;
  // `eventTimeZone`, not the raw string: the brand is what stops the
  // viewer's own zone being passed here by habit (docs/16 §1).
  const options = {
    locale: locale.value,
    timeZone: eventTimeZone(festival.timezone),
  };
  return t('submissions.card.submitted', {
    date: formatDate(epochMilliseconds, options),
    time: formatTime(epochMilliseconds, options),
  });
}
</script>

<template>
  <p v-if="isPending">{{ t('common.status.loading') }}</p>

  <template v-else-if="scope === null">
    <!-- The parent renders the "could not be loaded" alert for this; a second
         copy here would be the same failure stated twice. -->
  </template>

  <section
    v-else-if="subjectFestivalId === ''"
    aria-labelledby="submissions-standalone"
    class="evp-panel"
  >
    <h3 id="submissions-standalone">
      {{ t('submissions.standalone.title') }}
    </h3>
    <p class="evp-muted">{{ t('submissions.standalone.body') }}</p>
  </section>

  <template v-else>
    <p v-if="submissionsFailed" role="alert" class="evp-error">
      {{ t('submissions.loadFailed') }}
    </p>

    <template v-else>
      <p class="evp-lede">
        <template v-if="selectedName === null">
          {{ t('submissions.lede.festival', { total: board.total }) }}
        </template>
        <template v-else>
          {{
            t('submissions.lede.day', {
              shown: board.rows.length,
              total: board.total,
              day: selectedName,
            })
          }}
        </template>
      </p>

      <p
        class="evp-review-callout"
        :class="{ 'evp-review-callout--waiting': waitingForReview > 0 }"
      >
        <RouterLink :to="{ name: reviewRoute, params: scopeParams }">
          {{ t('submissions.review.link', { count: waitingForReview }) }}
        </RouterLink>
      </p>

      <p v-if="board.rows.length === 0" class="evp-muted">
        <template v-if="board.total === 0">
          {{ t('submissions.empty.none') }}
        </template>
        <template v-else>
          {{ t('submissions.empty.day', { total: board.total }) }}
        </template>
      </p>

      <template v-else>
        <div class="evp-table-toolbar">
          <p class="evp-table-count" role="status" aria-live="polite">
            {{
              t('submissions.table.count', {
                shown: visibleRows.length,
                total: tableRows.length,
              })
            }}
          </p>
          <button
            type="button"
            class="evp-button evp-button--small"
            :disabled="!filtering"
            @click="resetFilters"
          >
            {{ t('submissions.table.reset') }}
          </button>
        </div>

        <!-- Scrolls sideways inside its own box, never the page: a data table
             is the one exception docs/14 §2 permits, and the name column stays
             pinned so a row is still readable halfway across. Focusable so a
             keyboard user can scroll it too. -->
        <div
          class="evp-table-scroll"
          role="region"
          tabindex="0"
          :aria-label="t('submissions.table.region')"
        >
          <table class="evp-submissions">
            <caption class="evp-visually-hidden">
              {{
                t('submissions.table.caption')
              }}
            </caption>
            <thead>
              <tr>
                <th scope="col" class="evp-col-name">
                  {{ t('submissions.table.columns.name') }}
                </th>
                <th scope="col">
                  {{ t('submissions.table.columns.submitted') }}
                </th>
                <th scope="col">
                  {{ t('submissions.table.columns.availability') }}
                </th>
                <!-- One column per question anyone answered: the form version,
                     not this page, decides what they are (docs/09 §2). -->
                <th v-for="column in columns" :key="column.key" scope="col">
                  {{ column.question }}
                </th>
              </tr>
              <tr class="evp-filter-row">
                <td class="evp-col-name">
                  <input
                    v-model="nameFilter"
                    type="search"
                    class="evp-filter"
                    :placeholder="t('submissions.table.filter.placeholder')"
                    :aria-label="
                      t('submissions.table.filter.label', {
                        column: t('submissions.table.columns.name'),
                      })
                    "
                  />
                </td>
                <td>
                  <input
                    v-model="submittedFilter"
                    type="search"
                    class="evp-filter"
                    :placeholder="t('submissions.table.filter.placeholder')"
                    :aria-label="
                      t('submissions.table.filter.label', {
                        column: t('submissions.table.columns.submitted'),
                      })
                    "
                  />
                </td>
                <td>
                  <select
                    v-model="availabilityFilter"
                    class="evp-filter"
                    :aria-label="
                      t('submissions.table.filter.label', {
                        column: t('submissions.table.columns.availability'),
                      })
                    "
                  >
                    <option value="">
                      {{ t('submissions.table.filter.any') }}
                    </option>
                    <option
                      v-for="day in dayOptions"
                      :key="day.id"
                      :value="day.id"
                    >
                      {{ t('submissions.table.filter.day', { day: day.name }) }}
                    </option>
                    <option v-if="offersNoneOption" :value="NONE">
                      {{ t('submissions.table.filter.none') }}
                    </option>
                  </select>
                </td>
                <td v-for="column in columns" :key="column.key">
                  <select
                    v-if="column.kind === 'choice'"
                    class="evp-filter"
                    :value="answerFilters[column.key] ?? ''"
                    :aria-label="
                      t('submissions.table.filter.label', {
                        column: column.question,
                      })
                    "
                    @change="setAnswerFilter(column.key, inputValue($event))"
                  >
                    <option value="">
                      {{ t('submissions.table.filter.any') }}
                    </option>
                    <option
                      v-for="option in column.options"
                      :key="option"
                      :value="option"
                    >
                      {{ option }}
                    </option>
                  </select>
                  <input
                    v-else
                    type="search"
                    class="evp-filter"
                    :value="answerFilters[column.key] ?? ''"
                    :placeholder="t('submissions.table.filter.placeholder')"
                    :aria-label="
                      t('submissions.table.filter.label', {
                        column: column.question,
                      })
                    "
                    @input="setAnswerFilter(column.key, inputValue($event))"
                  />
                </td>
              </tr>
            </thead>

            <tbody>
              <tr v-if="visibleRows.length === 0">
                <td :colspan="columnCount" class="evp-no-match">
                  {{ t('submissions.table.noMatch') }}
                </td>
              </tr>

              <template v-for="row in visibleRows" :key="row.id">
                <tr
                  class="evp-submission"
                  :class="{ 'evp-submission--open': expanded.has(row.id) }"
                >
                  <th scope="row" class="evp-col-name evp-submission-name">
                    {{ row.displayName
                    }}<span v-if="row.lastName" class="evp-muted">
                      · {{ row.lastName }}</span
                    >
                  </th>
                  <td class="evp-nowrap evp-muted">{{ row.submitted }}</td>
                  <td class="evp-availability">
                    <template v-if="row.total">
                      <span class="evp-availability-total">
                        {{
                          t('submissions.table.availability', {
                            duration: row.total.duration,
                            days: row.total.dayCount,
                          })
                        }}
                      </span>
                      <button
                        type="button"
                        class="evp-disclosure"
                        :aria-expanded="expanded.has(row.id)"
                        :aria-controls="`evp-windows-${row.id}`"
                        @click="toggle(row.id)"
                      >
                        {{
                          expanded.has(row.id)
                            ? t('submissions.table.hideWindows')
                            : t('submissions.table.showWindows', {
                                count: row.windows.length,
                              })
                        }}
                      </button>
                    </template>
                    <span v-else class="evp-warning-text">
                      {{ t('submissions.table.noAvailability') }}
                    </span>
                  </td>
                  <td
                    v-for="column in columns"
                    :key="column.key"
                    class="evp-answer"
                  >
                    {{ row.answers.get(column.question) ?? '' }}
                  </td>
                </tr>

                <tr
                  v-if="row.total && expanded.has(row.id)"
                  :id="`evp-windows-${row.id}`"
                  class="evp-submission-detail"
                >
                  <td :colspan="columnCount">
                    <ul class="evp-windows">
                      <li
                        v-for="window in row.windows"
                        :key="window.key"
                        class="evp-window"
                        :style="{ '--evp-window-color': window.color }"
                      >
                        <!-- The day is named on every chip even when the page
                             is narrowed to one: a coordinator copying a line
                             into a message should not have to remember what
                             the page was filtered to. -->
                        <span class="evp-window-day">{{
                          window.eventName
                        }}</span>
                        <span class="evp-window-time">{{ window.range }}</span>
                        <span class="evp-muted">
                          {{
                            t('submissions.window.duration', {
                              duration: window.duration,
                              zone: window.zone,
                            })
                          }}
                        </span>
                      </li>
                    </ul>
                    <p class="evp-detail-foot">
                      <span class="evp-submission-total">{{
                        t('submissions.card.total', {
                          duration: row.total.duration,
                          days: row.total.dayCount,
                        })
                      }}</span>
                      <RouterLink
                        :to="{ name: availabilityRoute, params: scopeParams }"
                      >
                        {{ t('submissions.table.editOnBoard') }}
                      </RouterLink>
                    </p>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </template>
    </template>
  </template>
</template>

<style scoped>
.evp-lede {
  color: var(--evp-text-muted);
  margin: 0 0 1rem;
  max-width: 60ch;
}

.evp-muted {
  color: var(--evp-text-muted);
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

.evp-panel h3 {
  font-size: 1rem;
  margin: 0 0 0.5rem;
}

.evp-panel p {
  margin: 0;
  max-width: 60ch;
}

.evp-visually-hidden {
  clip-path: inset(50%);
  height: 1px;
  overflow: hidden;
  position: absolute;
  white-space: nowrap;
  width: 1px;
}

/* A plain link when nothing waits; a warning-edged callout when something
   does, so a coordinator scanning the page sees it without reading it. */
.evp-review-callout {
  margin: 0 0 1rem;
}

.evp-review-callout--waiting {
  background: var(--evp-surface);
  border: 1px solid var(--evp-warning);
  border-left-width: 4px;
  border-radius: 0.375rem;
  font-weight: 600;
  padding: 0.75rem;
}

/* ── Toolbar ─────────────────────────────────────────────────────────────── */

.evp-table-toolbar {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
  justify-content: space-between;
  margin: 0 0 0.75rem;
}

.evp-table-count {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  margin: 0;
}

.evp-button--small {
  font-size: 0.875rem;
  min-height: 2.25rem;
  padding: 0.375rem 0.875rem;
}

/* ── Table ───────────────────────────────────────────────────────────────── */

.evp-table-scroll {
  border: 1px solid var(--evp-border);
  border-radius: 0.5rem;
  max-width: 100%;
  overflow-x: auto;
}

.evp-submissions {
  border-collapse: separate;
  border-spacing: 0;
  font-size: 0.875rem;
  min-width: 100%;
}

.evp-submissions th,
.evp-submissions td {
  border-bottom: 1px solid var(--evp-border);
  padding: 0.5rem 0.75rem;
  text-align: left;
  /* Every cell reads from its first line, so a row whose answers wrap to
     three lines still has its name, date and hours on one baseline. */
  vertical-align: top;
}

.evp-submissions thead th {
  background: var(--evp-surface-raised);
  font-weight: 600;
  white-space: nowrap;
}

.evp-filter-row td {
  background: var(--evp-surface-raised);
  padding-top: 0;
}

.evp-filter {
  background: var(--evp-surface);
  border: 1px solid var(--evp-border);
  border-radius: 0.375rem;
  color: var(--evp-text);
  font: inherit;
  min-height: 2rem;
  min-width: 8rem;
  padding: 0.25rem 0.5rem;
  width: 100%;
}

/* The name stays in view while the answers scroll under it. Its background
   is opaque on purpose: a sticky cell you can read the next column through
   is worse than none. */
.evp-col-name {
  background: var(--evp-surface);
  left: 0;
  position: sticky;
  z-index: 1;
}

.evp-submissions thead .evp-col-name {
  background: var(--evp-surface-raised);
  z-index: 2;
}

.evp-submission-name {
  font-weight: 600;
  min-width: 10rem;
  /* A four-token name wraps rather than widening its column indefinitely. */
  overflow-wrap: anywhere;
}

.evp-submission:hover > td,
.evp-submission:hover > th {
  background: var(--evp-surface-raised);
}

.evp-submission--open > td,
.evp-submission--open > th {
  border-bottom-color: transparent;
}

.evp-nowrap {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.evp-availability {
  min-width: 11rem;
}

.evp-availability-total {
  display: block;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  white-space: nowrap;
}

.evp-disclosure {
  background: none;
  border: 0;
  color: var(--evp-accent);
  cursor: pointer;
  font: inherit;
  min-height: 1.5rem;
  padding: 0;
  text-decoration: underline;
  text-underline-offset: 0.15em;
}

.evp-disclosure::before {
  /* A chevron drawn with borders rather than a glyph, so it is decoration and
     not text a screen reader announces. It turns, as well as the label
     changing, when the row opens. */
  border-bottom: 2px solid currentColor;
  border-right: 2px solid currentColor;
  content: '';
  display: inline-block;
  height: 0.4em;
  margin-right: 0.4em;
  transform: rotate(-45deg);
  transition: transform 120ms ease;
  vertical-align: 0.1em;
  width: 0.4em;
}

.evp-disclosure[aria-expanded='true']::before {
  transform: rotate(45deg);
}

.evp-warning-text {
  color: var(--evp-warning);
  font-weight: 500;
}

.evp-answer {
  max-width: 20rem;
  min-width: 8rem;
  overflow-wrap: anywhere;
}

.evp-no-match {
  color: var(--evp-text-muted);
  padding: 1.5rem 0.75rem;
  text-align: center;
}

/* ── Expanded availability ───────────────────────────────────────────────── */

.evp-submission-detail > td {
  background: var(--evp-surface-raised);
  padding: 0.25rem 0.75rem 0.75rem 1.5rem;
}

.evp-windows {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  list-style: none;
  margin: 0;
  padding: 0;
}

.evp-window {
  /* The day's palette colour, as a bar down the left edge — never as the only
     signal: the day is also named in words on the same line (docs/14 §2). */
  border-left: 4px solid var(--evp-window-color);
  display: flex;
  flex-wrap: wrap;
  gap: 0 0.5rem;
  padding-left: 0.5rem;
}

.evp-window-day {
  font-weight: 600;
}

.evp-window-time {
  /* Tabular figures so a column of clock readings lines up under itself. */
  font-variant-numeric: tabular-nums;
}

.evp-detail-foot {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 1rem;
  margin: 0.625rem 0 0;
}

.evp-submission-total {
  font-weight: 600;
}
</style>
