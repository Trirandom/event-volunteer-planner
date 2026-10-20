<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * Everything one organisation has planned, on one page.
 *
 * This replaces the former separate festivals page. A festival is an optional
 * grouping above an event (`api/festivals.ts`), not a parallel resource, so
 * two pages meant a coordinator asking the only question they ever ask —
 * "what is next, and who is not staffed yet?" — had to ask it twice and merge
 * the two answers in their head. Here the answer is one chronological list:
 * events inside their festival where they have one, standalone where they do
 * not, soonest first, with what has already happened pushed to the bottom.
 *
 * A festival heading links to `PlanDetailView`, which is that festival and
 * its days on one page; an event row links to the same page narrowed to that
 * day. This list is the index, never the detail.
 *
 * An event joins a festival from that festival's card ("Add an event"), not
 * from a picker in the create form at the top: the coordinator is already
 * looking at the festival, and a `<select>` of every festival name was the
 * step that made them find it a second time. The top form creates standalone
 * events only.
 */
import { computed, ref } from 'vue';
import { RouterLink } from 'vue-router';

import type {
  CreateEventRejection,
  Event,
  LoadExampleEventRejection,
} from '../api/events';
import type {
  CreateFestivalRejection,
  LoadExampleFestivalRejection,
} from '../api/festivals';
import NewEventForm from '../components/NewEventForm.vue';
import ToastMessage from '../components/ToastMessage.vue';
import ToastStack from '../components/ToastStack.vue';
import {
  useCreateEvent,
  useEvents,
  useLoadExampleEvent,
} from '../api/useEvents';
import {
  useCreateFestival,
  useFestivals,
  useLoadExampleFestival,
} from '../api/useFestivals';
import { buildAgenda, hasPassed, type AgendaGroup } from '../plan/agenda';
import {
  formatPeriod,
  instantFromLocal,
  periodDatesText,
  periodText,
} from '../format/period';
import { locale, t } from '../i18n';
import { statusLabel } from '../plan/scope';
import { useRouteParam } from '../router/params';
import { nowInstant } from '../time/clock';

const orgId = useRouteParam('orgId');

const { data: events, isPending: eventsPending } = useEvents(orgId);
const { data: festivals, isPending: festivalsPending } = useFestivals(orgId);

const festivalList = computed(() =>
  festivals.value?.ok === true ? festivals.value.value : [],
);

/**
 * Read once, at setup, and never again. See `time/clock.ts`: a list that
 * re-sorted itself on a timer would move a row out from under a pointer.
 */
const now = nowInstant();

const eventList = computed(() =>
  events.value?.ok === true ? events.value.value : [],
);

const agenda = computed(() =>
  buildAgenda(eventList.value, festivalList.value, now),
);

/** Slugs are unique per org (`UNIQUE (org_id, slug)`), not per festival, so a
 * festival card's form checks against every event the org has. */
const takenSlugs = computed(() => eventList.value.map((event) => event.slug));

interface EventLine {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly period: string;
  readonly isPast: boolean;
}

type GroupLine =
  | {
      readonly kind: 'festival';
      readonly key: string;
      readonly id: string;
      readonly name: string;
      readonly timezone: string;
      readonly status: string;
      readonly period: string;
      readonly events: readonly EventLine[];
    }
  | { readonly kind: 'event'; readonly key: string; readonly event: EventLine };

/** Formatting happens here rather than in the template, so a period is parsed
 * once per render and the template stays readable. Inside `computed`, so a
 * language switch re-runs it. */
function toLine(group: AgendaGroup): GroupLine {
  if (group.kind === 'event') {
    return { kind: 'event', key: group.key, event: eventLine(group.event) };
  }
  return {
    kind: 'festival',
    key: group.key,
    id: group.festival.id,
    name: group.festival.name,
    timezone: group.festival.timezone,
    status: statusLabel(group.festival.status),
    period: periodDatesText(
      formatPeriod(
        group.festival.period,
        group.festival.timezone,
        locale.value,
      ),
    ),
    events: group.events.map(eventLine),
  };
}

function eventLine(event: Event): EventLine {
  return {
    id: event.id,
    name: event.name,
    status: statusLabel(event.status),
    period: periodText(
      formatPeriod(event.period, event.timezone, locale.value),
    ),
    isPast: hasPassed(event.period, now),
  };
}

const upcomingLines = computed(() => agenda.value.upcoming.map(toLine));
const pastLines = computed(() => agenda.value.past.map(toLine));

const listPending = computed(
  () => eventsPending.value || festivalsPending.value,
);
const eventsFailed = computed(() => events.value?.ok === false);
/** A festivals failure degrades the page rather than emptying it: the events
 * are still listed, just ungrouped, and saying so beats silently flattening. */
const festivalsFailed = computed(() => festivals.value?.ok === false);

const isEmpty = computed(
  () => upcomingLines.value.length === 0 && pastLines.value.length === 0,
);

/**
 * Each "load the example" button is gated on its *own* resource being empty,
 * not on the page as a whole — the two loaders are independent server calls
 * that each 409 only once their own resource is non-empty (docs/04: "409 if
 * the org already has any festival" / "...any event"). A coordinator who
 * already loaded the example festival, and then created a standalone event
 * of their own, can still load the example event; gating both buttons behind
 * one "is anything on the page" check would hide a button the API is still
 * willing to honour.
 *
 * `undefined` while the query is in flight, so neither button flashes into
 * existence and then vanishes once the real answer arrives.
 */
const canLoadExampleFestival = computed(
  () => festivals.value?.ok === true && festivals.value.value.length === 0,
);
const canLoadExampleEvent = computed(
  () => events.value?.ok === true && events.value.value.length === 0,
);

// ── Creating ────────────────────────────────────────────────────────────
/** Which form is open, if any. One at a time: two long forms stacked above
 * the list would push the list itself off the first screen. */
const openForm = ref<'none' | 'event' | 'festival'>('none');

function toggleForm(which: 'event' | 'festival'): void {
  openForm.value = openForm.value === which ? 'none' : which;
}

const name = ref('');
const slug = ref('');
const timezone = ref('');
const startLocal = ref('');
const endLocal = ref('');

function resetFields(): void {
  name.value = '';
  slug.value = '';
  startLocal.value = '';
  endLocal.value = '';
}

const {
  mutate: submitCreateEvent,
  isPending: createEventPending,
  data: createEventResult,
  reset: resetCreateEvent,
} = useCreateEvent(orgId);

const {
  mutate: submitCreateFestival,
  isPending: createFestivalPending,
  data: createFestivalResult,
  reset: resetCreateFestival,
} = useCreateFestival(orgId);

function rejectionMessage(
  rejection: CreateEventRejection | CreateFestivalRejection,
): string {
  return rejection.reason === 'unavailable'
    ? t('events.list.unavailable')
    : rejection.detail;
}

const createEventError = computed(() => {
  const result = createEventResult.value;
  return result === undefined || result.ok
    ? null
    : rejectionMessage(result.rejection);
});

const createFestivalError = computed(() => {
  const result = createFestivalResult.value;
  return result === undefined || result.ok
    ? null
    : rejectionMessage(result.rejection);
});

function createEvent(): void {
  resetCreateEvent();
  submitCreateEvent(
    {
      name: name.value,
      slug: slug.value,
      timezone: timezone.value,
      period: {
        start: instantFromLocal(startLocal.value, timezone.value),
        end: instantFromLocal(endLocal.value, timezone.value),
      },
    },
    {
      onSuccess: (result) => {
        if (!result.ok) {
          return;
        }
        resetFields();
        openForm.value = 'none';
      },
    },
  );
}

function createFestival(): void {
  resetCreateFestival();
  submitCreateFestival(
    {
      name: name.value,
      slug: slug.value,
      timezone: timezone.value,
      period: {
        start: instantFromLocal(startLocal.value, timezone.value),
        end: instantFromLocal(endLocal.value, timezone.value),
      },
    },
    {
      onSuccess: (result) => {
        if (!result.ok) {
          return;
        }
        resetFields();
        openForm.value = 'none';
      },
    },
  );
}

// ── The worked examples ─────────────────────────────────────────────────
const {
  mutate: loadExampleFestival,
  isPending: exampleFestivalPending,
  data: exampleFestivalResult,
  reset: resetExampleFestival,
} = useLoadExampleFestival(orgId);

const {
  mutate: loadExampleEvent,
  isPending: exampleEventPending,
  data: exampleEventResult,
  reset: resetExampleEvent,
} = useLoadExampleEvent(orgId);

/**
 * What the live region announces.
 *
 * A 409 is deliberately not styled as an error: it means another
 * coordinator's click landed first, which the invalidated queries already
 * resolve by showing the result below — the honest message is "here it is",
 * not "something went wrong".
 */
function statusFor(
  result:
    | { readonly ok: true; readonly name: string }
    | {
        readonly ok: false;
        readonly rejection:
          LoadExampleEventRejection | LoadExampleFestivalRejection;
      }
    | undefined,
  kind: 'festival' | 'event',
): { kind: 'success' | 'info' | 'error'; message: string } | null {
  if (result === undefined) {
    return null;
  }
  if (result.ok) {
    return {
      kind: 'success',
      message: t('events.list.example.loaded', { kind, name: result.name }),
    };
  }
  if (result.rejection.reason === 'conflict') {
    return {
      kind: 'info',
      message: t('events.list.example.conflict', { kind }),
    };
  }
  return {
    kind: 'error',
    message:
      result.rejection.reason === 'unavailable'
        ? t('events.list.unavailable')
        : result.rejection.detail,
  };
}

const exampleStatus = computed(() => {
  const festivalResult = exampleFestivalResult.value;
  const eventResult = exampleEventResult.value;
  return (
    statusFor(
      festivalResult === undefined
        ? undefined
        : festivalResult.ok
          ? { ok: true, name: festivalResult.festival.name }
          : festivalResult,
      'festival',
    ) ??
    statusFor(
      eventResult === undefined
        ? undefined
        : eventResult.ok
          ? { ok: true, name: eventResult.event.name }
          : eventResult,
      'event',
    )
  );
});

function dismissExampleStatus(): void {
  resetExampleFestival();
  resetExampleEvent();
}
</script>

<template>
  <h1>{{ t('events.list.title') }}</h1>

  <!-- The form is the first thing on the page, before the list it adds to. -->
  <section aria-labelledby="create-heading" class="evp-panel evp-create">
    <h2 id="create-heading">{{ t('events.list.create.heading') }}</h2>

    <p class="evp-create-actions">
      <button
        class="evp-button evp-button--primary"
        type="button"
        :aria-expanded="openForm === 'event'"
        aria-controls="create-form"
        @click="toggleForm('event')"
      >
        {{ t('events.list.create.newEvent') }}
      </button>
      <button
        class="evp-button"
        type="button"
        :aria-expanded="openForm === 'festival'"
        aria-controls="create-form"
        @click="toggleForm('festival')"
      >
        {{ t('events.list.create.newFestival') }}
      </button>

      <!-- Each button stands on its own: loading the example festival and
           loading the example event are two independent server calls, and one
           having already been used must not hide the other (see
           `canLoadExampleFestival` / `canLoadExampleEvent`). -->
      <button
        v-if="canLoadExampleFestival"
        class="evp-button"
        type="button"
        :disabled="exampleFestivalPending"
        @click="loadExampleFestival()"
      >
        {{
          exampleFestivalPending
            ? t('events.list.example.loading')
            : t('events.list.example.loadFestival')
        }}
      </button>
      <button
        v-if="canLoadExampleEvent"
        class="evp-button"
        type="button"
        :disabled="exampleEventPending"
        @click="loadExampleEvent()"
      >
        {{
          exampleEventPending
            ? t('events.list.example.loading')
            : t('events.list.example.loadEvent')
        }}
      </button>
    </p>

    <div v-if="openForm !== 'none'" id="create-form">
      <p v-if="createEventError !== null" role="alert" class="evp-error">
        {{ createEventError }}
      </p>
      <p v-if="createFestivalError !== null" role="alert" class="evp-error">
        {{ createFestivalError }}
      </p>

      <!-- One form, two submit targets. The fields are the same either way,
           and asking a coordinator to re-type a timezone because they picked
           the wrong button would be the only difference a second <form>
           bought. -->
      <form
        @submit.prevent="
          openForm === 'event' ? createEvent() : createFestival()
        "
      >
        <p class="evp-field">
          <label for="create-name">
            <span>{{ t('events.list.create.name') }}</span>
            <input id="create-name" v-model="name" type="text" required />
          </label>
        </p>
        <p class="evp-field">
          <label for="create-slug">
            <span>{{ t('events.list.create.slug') }}</span>
            <input id="create-slug" v-model="slug" type="text" required />
          </label>
        </p>
        <p class="evp-field">
          <label for="create-timezone">
            <span>{{ t('events.list.create.timezone') }}</span>
            <input
              id="create-timezone"
              v-model="timezone"
              type="text"
              required
            />
          </label>
        </p>
        <p class="evp-field">
          <label for="create-start">
            <span>{{ t('events.list.create.starts') }}</span>
            <input
              id="create-start"
              v-model="startLocal"
              type="datetime-local"
              required
            />
          </label>
        </p>
        <p class="evp-field">
          <label for="create-end">
            <span>{{ t('events.list.create.ends') }}</span>
            <input
              id="create-end"
              v-model="endLocal"
              type="datetime-local"
              required
            />
          </label>
        </p>
        <button
          class="evp-button evp-button--primary"
          type="submit"
          :disabled="createEventPending || createFestivalPending"
        >
          <template v-if="openForm === 'event'">
            {{
              createEventPending
                ? t('events.list.create.creating')
                : t('events.list.create.createEvent')
            }}
          </template>
          <template v-else>
            {{
              createFestivalPending
                ? t('events.list.create.creating')
                : t('events.list.create.createFestival')
            }}
          </template>
        </button>
      </form>
    </div>
  </section>

  <p v-if="listPending">{{ t('common.status.loading') }}</p>

  <p v-else-if="eventsFailed" role="alert" class="evp-error">
    {{ t('events.list.loadFailed') }}
  </p>

  <template v-else>
    <p v-if="festivalsFailed" role="alert" class="evp-error">
      {{ t('events.list.festivalsFailed') }}
    </p>

    <section
      v-if="isEmpty"
      aria-labelledby="empty-heading"
      class="evp-panel evp-empty"
    >
      <h2 id="empty-heading">{{ t('events.list.empty.heading') }}</h2>
      <p>{{ t('events.list.empty.body') }}</p>
    </section>

    <template v-else>
      <section
        v-if="upcomingLines.length > 0"
        aria-labelledby="upcoming-heading"
      >
        <h2 id="upcoming-heading">{{ t('events.list.upcoming') }}</h2>
        <ul class="evp-agenda">
          <li v-for="group in upcomingLines" :key="group.key">
            <!-- Two shapes, one list: a festival is a heading with its events
                 indented under it, a standalone event is a single row. They
                 are peers in the same chronological sequence. -->
            <template v-if="group.kind === 'festival'">
              <div class="evp-group-head">
                <RouterLink
                  class="evp-group-title"
                  :to="{
                    name: 'org-festival-detail',
                    params: { orgId, festivalId: group.id },
                  }"
                >
                  {{ group.name }}
                </RouterLink>
                <span class="evp-meta">
                  {{ group.period }} · {{ group.status }}
                </span>
              </div>

              <ul v-if="group.events.length > 0" class="evp-group-events">
                <li
                  v-for="line in group.events"
                  :key="line.id"
                  :class="{ 'evp-row--past': line.isPast }"
                >
                  <RouterLink
                    class="evp-row-name"
                    :to="{
                      name: 'org-event-detail',
                      params: { orgId, eventId: line.id },
                    }"
                  >
                    {{ line.name }}
                  </RouterLink>
                  <span class="evp-meta">{{ line.period }}</span>
                  <span class="evp-meta">{{ line.status }}</span>
                  <!-- Spelt out, not conveyed by the dimmed row alone: colour
                       is never the only carrier (docs/14 §2). -->
                  <span v-if="line.isPast" class="evp-meta">{{
                    t('events.list.finished')
                  }}</span>
                </li>
              </ul>
              <p v-else class="evp-meta evp-group-empty">
                {{ t('events.list.noEventsYet') }}
              </p>

              <!-- Upcoming festivals only: adding a day to one that is over is
                   a correction, made from its own page. -->
              <div class="evp-group-add">
                <NewEventForm
                  :org-id="orgId"
                  :festival-id="group.id"
                  :production-name="group.name"
                  :timezone="group.timezone"
                  :taken-slugs="takenSlugs"
                  placement="agenda"
                />
              </div>
            </template>

            <div v-else class="evp-row">
              <RouterLink
                class="evp-row-name"
                :to="{
                  name: 'org-event-detail',
                  params: { orgId, eventId: group.event.id },
                }"
              >
                {{ group.event.name }}
              </RouterLink>
              <span class="evp-meta">{{ group.event.period }}</span>
              <span class="evp-meta">{{ group.event.status }}</span>
            </div>
          </li>
        </ul>
      </section>

      <section v-if="pastLines.length > 0" aria-labelledby="past-heading">
        <h2 id="past-heading">{{ t('events.list.past') }}</h2>
        <ul class="evp-agenda evp-agenda--past">
          <li v-for="group in pastLines" :key="group.key">
            <template v-if="group.kind === 'festival'">
              <div class="evp-group-head">
                <RouterLink
                  class="evp-group-title"
                  :to="{
                    name: 'org-festival-detail',
                    params: { orgId, festivalId: group.id },
                  }"
                >
                  {{ group.name }}
                </RouterLink>
                <span class="evp-meta">
                  {{ group.period }} · {{ group.status }}
                </span>
              </div>

              <ul v-if="group.events.length > 0" class="evp-group-events">
                <li v-for="line in group.events" :key="line.id">
                  <RouterLink
                    class="evp-row-name"
                    :to="{
                      name: 'org-event-detail',
                      params: { orgId, eventId: line.id },
                    }"
                  >
                    {{ line.name }}
                  </RouterLink>
                  <span class="evp-meta">{{ line.period }}</span>
                  <span class="evp-meta">{{ line.status }}</span>
                </li>
              </ul>
              <p v-else class="evp-meta evp-group-empty">
                {{ t('events.list.noEvents') }}
              </p>
            </template>

            <div v-else class="evp-row">
              <RouterLink
                class="evp-row-name"
                :to="{
                  name: 'org-event-detail',
                  params: { orgId, eventId: group.event.id },
                }"
              >
                {{ group.event.name }}
              </RouterLink>
              <span class="evp-meta">{{ group.event.period }}</span>
              <span class="evp-meta">{{ group.event.status }}</span>
            </div>
          </li>
        </ul>
      </section>
    </template>
  </template>

  <!-- Outside the empty/non-empty split: a successful "load the example"
       flips the page from empty to non-empty and the whole empty state
       unmounts, so a live region nested inside it would vanish before its own
       announcement finished being useful. -->
  <ToastStack>
    <ToastMessage
      v-if="exampleStatus != null"
      :tone="exampleStatus.kind === 'error' ? 'danger' : 'info'"
      dismissible
      @dismiss="dismissExampleStatus"
    >
      {{ exampleStatus.message }}
    </ToastMessage>
  </ToastStack>
</template>

<style scoped>
h1 {
  font-size: 1.75rem;
  letter-spacing: -0.02em;
  margin: 0 0 1.5rem;
}

h2 {
  font-size: 1.125rem;
  margin: 2rem 0 0.75rem;
}

.evp-create {
  margin-bottom: 1rem;
}

.evp-create h2 {
  margin: 0 0 0.75rem;
}

.evp-create-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin: 0;
}

#create-form {
  border-top: 1px solid var(--evp-border);
  margin-top: 1.25rem;
  padding-top: 1.25rem;
}

.evp-meta {
  color: var(--evp-text-muted);
  font-size: 0.875rem;
}

.evp-empty {
  margin-bottom: 1.5rem;
}

.evp-empty h2 {
  margin: 0 0 0.5rem;
}

.evp-error {
  background: var(--evp-surface);
  border: 1px solid var(--evp-danger);
  border-left-width: 4px;
  border-radius: 0.375rem;
  color: var(--evp-danger);
  margin: 1rem 0 0;
  padding: 0.75rem;
}

/* A list, not a grid of cards: one line per thing, read top to bottom in the
   order they happen. Rows are separated by a rule rather than by whitespace so
   that a long list stays scannable at 400% zoom. */
.evp-agenda {
  border: 1px solid var(--evp-border);
  border-radius: 0.5rem;
  list-style: none;
  margin: 0;
  overflow: hidden;
  padding: 0;
}

.evp-agenda > li + li {
  border-top: 1px solid var(--evp-border);
}

.evp-row,
.evp-group-head {
  align-items: baseline;
  display: flex;
  /* Wraps rather than truncates: a name the coordinator cannot read is not a
     row, and docs/14 §2 forbids horizontal scrolling at 320 px. */
  flex-wrap: wrap;
  gap: 0.25rem 0.75rem;
  padding: 0.75rem 1rem;
}

.evp-row:hover {
  background: var(--evp-surface-raised);
}

.evp-group-head {
  background: var(--evp-surface-raised);
}

.evp-row-name {
  color: var(--evp-text);
  font-weight: 500;
  text-decoration: underline;
  text-underline-offset: 0.2em;
}

.evp-group-title {
  color: var(--evp-accent);
  font-size: 1.0625rem;
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 0.2em;
}

.evp-group-events {
  list-style: none;
  margin: 0;
  padding: 0;
}

.evp-group-events > li {
  align-items: baseline;
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 0.75rem;
  /* Indented by a rule rather than by margin, so the nesting survives a
     forced-colors mode that drops the background tints. */
  border-left: 3px solid var(--evp-border);
  margin-left: 1rem;
  padding: 0.625rem 1rem;
}

.evp-group-events > li:hover {
  background: var(--evp-surface-raised);
}

/* Dimmed *and* labelled "finished" in the row itself — the tint is a hint on
   top of text that already says it. */
.evp-row--past .evp-row-name {
  color: var(--evp-text-muted);
  font-weight: 400;
}

.evp-agenda--past {
  /* The archive is quieter than the plan, but still fully readable: the muted
     token is the one proved against this surface, not an opacity. */
  --evp-row-tone: var(--evp-text-muted);
}

.evp-agenda--past .evp-row-name {
  color: var(--evp-row-tone);
  font-weight: 400;
}

.evp-group-add {
  border-left: 3px solid var(--evp-border);
  margin-left: 1rem;
  padding: 0.625rem 1rem 0.75rem;
}

/* The form's own bottom margin is for the details page, where more follows
   it; here the card's padding already closes it off. */
.evp-group-add :deep(.evp-add) {
  margin-bottom: 0;
}

.evp-group-empty {
  margin: 0;
  padding: 0.625rem 1rem 0.75rem 2rem;
}
</style>
