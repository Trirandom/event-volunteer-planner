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

/** Upcoming then past, each only when it has something in it. One template
 * draws both, because they are the same cards: a second hand-written copy is
 * the one that misses the next change to a card. What differs is `past`. */
const agendaSections = computed(() =>
  [
    {
      id: 'upcoming',
      heading: t('events.list.upcoming'),
      lines: upcomingLines.value,
      past: false,
    },
    {
      id: 'past',
      heading: t('events.list.past'),
      lines: pastLines.value,
      past: true,
    },
  ].filter((section) => section.lines.length > 0),
);

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
  <section aria-labelledby="create-heading" class="evp-card evp-create">
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
        class="evp-create-form"
        @submit.prevent="
          openForm === 'event' ? createEvent() : createFestival()
        "
      >
        <p class="evp-field evp-field--flat evp-create-wide">
          <label for="create-name">
            <span>{{ t('events.list.create.name') }}</span>
            <input id="create-name" v-model="name" type="text" required />
          </label>
        </p>
        <p class="evp-field evp-field--flat">
          <label for="create-slug">
            <span>{{ t('events.list.create.slug') }}</span>
            <input id="create-slug" v-model="slug" type="text" required />
          </label>
        </p>
        <p class="evp-field evp-field--flat">
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
        <p class="evp-field evp-field--flat">
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
        <p class="evp-field evp-field--flat">
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
        <p class="evp-create-wide evp-create-submit">
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
        </p>
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
      class="evp-card evp-empty"
    >
      <h2 id="empty-heading">{{ t('events.list.empty.heading') }}</h2>
      <p>{{ t('events.list.empty.body') }}</p>
    </section>

    <template v-else>
      <!-- Upcoming and past are the same cards; the archive only turns its
           names to the muted token. Two loops rather than one with a flag,
           because only an upcoming festival offers "Add an event" — adding a
           day to one that is over is a correction, made from its own page. -->
      <section
        v-for="list in agendaSections"
        :key="list.id"
        :aria-labelledby="`${list.id}-heading`"
      >
        <h2 :id="`${list.id}-heading`">{{ list.heading }}</h2>
        <ul class="evp-agenda" :class="{ 'evp-agenda--past': list.past }">
          <li
            v-for="group in list.lines"
            :key="group.key"
            class="evp-card evp-slab evp-slab--tint evp-entry"
          >
            <!-- Two shapes, one list: a festival is a card with its events
                 listed inside it, a standalone event is a card of one row.
                 They are peers in the same chronological sequence. -->
            <template v-if="group.kind === 'festival'">
              <div class="evp-entry-head evp-hit">
                <span class="evp-kind">{{
                  t('events.list.kind.festival')
                }}</span>
                <RouterLink
                  class="evp-group-title evp-hit-link"
                  :to="{
                    name: 'org-festival-detail',
                    params: { orgId, festivalId: group.id },
                  }"
                >
                  {{ group.name }}
                </RouterLink>
                <span class="evp-tags">
                  <span class="evp-tag">{{ group.period }}</span>
                  <span class="evp-tag">{{ group.status }}</span>
                </span>
              </div>

              <ul v-if="group.events.length > 0" class="evp-group-events">
                <li
                  v-for="line in group.events"
                  :key="line.id"
                  class="evp-hit evp-line"
                  :class="{ 'evp-row--past': line.isPast }"
                >
                  <RouterLink
                    class="evp-row-name evp-hit-link"
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
                  <span v-if="line.isPast && !list.past" class="evp-meta">{{
                    t('events.list.finished')
                  }}</span>
                  <svg
                    class="evp-chevron"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </li>
              </ul>
              <p v-else class="evp-meta evp-group-empty">
                {{
                  list.past
                    ? t('events.list.noEvents')
                    : t('events.list.noEventsYet')
                }}
              </p>

              <div v-if="!list.past" class="evp-group-add">
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

            <div v-else class="evp-hit evp-line evp-standalone">
              <span class="evp-kind">{{ t('events.list.kind.event') }}</span>
              <RouterLink
                class="evp-row-name evp-hit-link"
                :to="{
                  name: 'org-event-detail',
                  params: { orgId, eventId: group.event.id },
                }"
              >
                {{ group.event.name }}
              </RouterLink>
              <span class="evp-meta">{{ group.event.period }}</span>
              <span class="evp-meta">{{ group.event.status }}</span>
              <svg class="evp-chevron" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9 6l6 6-6 6" />
              </svg>
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
/* The landing page's type register (HomeView.vue), so signing in does not
   drop the application into a second, quieter typeface scale. */
h1 {
  font-size: 2rem;
  font-weight: 800;
  letter-spacing: -0.03em;
  line-height: 1.1;
  margin: 0 0 1.5rem;
}

h2 {
  font-size: 1.25rem;
  font-weight: 800;
  letter-spacing: -0.02em;
  margin: 2.5rem 0 1rem;
}

.evp-create {
  margin-bottom: 1rem;
}

.evp-create h2 {
  margin: 0 0 1rem;
}

.evp-create-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin: 0;
}

.evp-create .evp-button {
  border-radius: var(--evp-radius-md);
}

#create-form {
  border-top: var(--evp-edge) solid var(--evp-border);
  margin-top: 1.25rem;
  padding-top: 1.25rem;
}

/* Two columns when two fit, one otherwise — auto-fit, not a breakpoint, so
   400% zoom gets the single column without a media query (docs/14 §2). */
.evp-create-form {
  column-gap: 1rem;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr));
}

.evp-create-wide {
  grid-column: 1 / -1;
}

.evp-create-submit {
  margin: 0.25rem 0 0;
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

.evp-empty p {
  color: var(--evp-text-muted);
  margin: 0;
  max-width: 60ch;
}

.evp-error {
  background: var(--evp-surface);
  border: 1px solid var(--evp-danger);
  border-left-width: 4px;
  border-radius: var(--evp-radius-sm);
  color: var(--evp-danger);
  margin: 1rem 0 0;
  padding: 0.75rem;
}

/* One card per festival or standalone event, read top to bottom in the order
   they happen. The gap leaves the slab clear of the next card; nothing here
   clips, so the slab is never cut off (flat.css). */
.evp-agenda {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  list-style: none;
  margin: 0;
  padding: 0;
}

/* The rows reach the card's edges, so their hover fill does too; the card's
   own padding moves onto the head and the rows. */
.evp-entry {
  padding: 0;
}

/* Whatever closes the card carries its lower corners, so a hover fill on the
   last row follows the card's radius instead of squaring it off. */
.evp-entry > :last-child,
.evp-entry > :last-child > .evp-line:last-child {
  border-end-end-radius: var(--evp-radius-lg);
  border-end-start-radius: var(--evp-radius-lg);
}

/* ── Whole-row links ─────────────────────────────────────────────────────────
 *
 * The name is the link, and its box is stretched over the row by `::after`,
 * so the whole row answers a click without the link's accessible name
 * becoming "Saturday 14 June 2026, 10:00 – 23:00 Draft". The row is
 * positioned to contain the stretch. No underline: the row's hover fill, its
 * chevron and the pointer say it is a link, and there is no running text
 * around it to be told from (WCAG 1.4.1). */
.evp-hit {
  position: relative;
  transition: background-color var(--evp-duration) ease;
}

.evp-hit:hover {
  background: var(--evp-surface);
}

.evp-hit-link {
  text-decoration: none;
}

.evp-hit-link::after {
  content: '';
  inset: 0;
  position: absolute;
}

.evp-entry-head {
  border-radius: var(--evp-radius-lg) var(--evp-radius-lg) 0 0;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  padding: 1.25rem 1.5rem 1rem;
}

.evp-kind {
  color: var(--evp-text-muted);
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.evp-group-title {
  color: var(--evp-text);
  font-size: 1.375rem;
  font-weight: 800;
  letter-spacing: -0.02em;
  line-height: 1.2;
  overflow-wrap: anywhere;
}

.evp-entry-head:hover .evp-group-title {
  color: var(--evp-accent);
}

.evp-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
  margin-top: 0.25rem;
}

/* A label, not a control: it sits on the card ground and never answers the
   pointer itself. Muted text on `surface` is a proved pair. */
.evp-tag {
  background: var(--evp-surface);
  border: var(--evp-edge) solid transparent;
  border-radius: var(--evp-radius-sm);
  color: var(--evp-text-muted);
  font-size: 0.8125rem;
  font-weight: 600;
  padding: 0.125rem 0.5rem;
}

.evp-group-events {
  border-top: var(--evp-edge) solid var(--evp-surface);
  list-style: none;
  margin: 0;
  padding: 0;
}

.evp-line {
  align-items: baseline;
  display: flex;
  /* Wraps rather than truncates: a name the coordinator cannot read is not a
     row, and docs/14 §2 forbids horizontal scrolling at 320 px. */
  flex-wrap: wrap;
  gap: 0.25rem 0.75rem;
  padding: 0.75rem 3rem 0.75rem 1.5rem;
}

.evp-group-events > .evp-line + .evp-line {
  border-top: var(--evp-edge) solid var(--evp-surface);
}

.evp-row-name {
  color: var(--evp-text);
  font-weight: 600;
}

.evp-hit:hover .evp-row-name {
  color: var(--evp-accent);
}

/* The standalone event is a whole card of one row: the kicker sits on the
   name's line rather than above it, so the card stays one row tall. */
.evp-standalone {
  border-radius: var(--evp-radius-lg);
  padding-bottom: 1rem;
  padding-top: 1rem;
}

.evp-standalone .evp-row-name {
  font-size: 1.125rem;
  font-weight: 800;
  letter-spacing: -0.01em;
}

.evp-chevron {
  align-self: center;
  color: var(--evp-text-muted);
  fill: none;
  height: 1.25rem;
  position: absolute;
  right: 1rem;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 2.25;
  top: 50%;
  transform: translateY(-50%);
  transition:
    color var(--evp-duration) ease,
    right var(--evp-duration) ease;
  width: 1.25rem;
}

.evp-hit:hover .evp-chevron {
  color: var(--evp-accent);
  right: 0.75rem;
}

/* Dimmed *and* labelled "finished" in the row itself — the tint is a hint on
   top of text that already says it. */
.evp-row--past .evp-row-name {
  color: var(--evp-text-muted);
  font-weight: 500;
}

/* The archive is quieter than the plan, but still fully readable: the muted
   token is the one proved against this surface, not an opacity. */
.evp-agenda--past .evp-row-name,
.evp-agenda--past .evp-group-title {
  color: var(--evp-text-muted);
}

.evp-group-add {
  border-top: var(--evp-edge) solid var(--evp-surface);
  padding: 0.75rem 1.5rem 1rem;
}

/* The form's own bottom margin is for the details page, where more follows
   it; here the card's padding already closes it off. */
.evp-group-add :deep(.evp-add) {
  margin-bottom: 0;
}

.evp-group-empty {
  border-top: var(--evp-edge) solid var(--evp-surface);
  margin: 0;
  padding: 0.75rem 1.5rem;
}
</style>
