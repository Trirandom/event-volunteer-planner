<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * One event's own settings: when it runs, when the doors are open, what
 * colour it is drawn in, and whether it should exist.
 *
 * A component per event rather than one form over a map keyed by event id.
 * The details section covers a whole festival at festival scope, so the page
 * can be showing six of these at once, and six independent drafts with six
 * independent save states is what a coordinator editing Saturday while
 * Sunday's changes are still unsaved actually needs. A single form would make
 * that one shared dirty flag and one shared error line.
 *
 * **The draft is seeded from the event and re-seeded when the event changes
 * underneath it, unless it is dirty.** A save answers with the new row and
 * invalidates the queries behind this page, so without the re-seed the fields
 * would keep showing what was typed rather than what was stored — and a
 * server that normalised the value would be invisible. With it, and without
 * the dirty check, a background refetch would wipe what somebody was halfway
 * through typing.
 */
import {
  eventColor,
  eventColorChoiceCount,
  eventColorChoices,
} from '@evp/shared';
import { computed, ref, watch } from 'vue';

import type { Event } from '../api/events';
import { useDeleteEvent, useUpdateEventDetails } from '../api/useEvents';
import { formatPeriod } from '../format/period';
import type { ViewerLocale } from '@evp/shared/intl';
import { t, type AdminMessageKey } from '../i18n';
import {
  draftChanges,
  draftOf,
  draftProblem,
  type DraftProblem,
  type EventDraft,
} from '../plan/eventDraft';

const props = defineProps<{
  readonly orgId: string;
  readonly event: Event;
  readonly locale: ViewerLocale;
  /** Deleting is owner work (docs/04 §4). A coordinator does not get the
   * button rather than getting a 403 from it — the API refuses either way,
   * and offering an action that cannot succeed is not a safeguard. */
  readonly canDelete: boolean;
}>();

/**
 * Carries the festival as well as the id. The parent has to redirect, and the
 * event is the only thing on the page that still knows what it belonged to —
 * by the time this fires, the queries describing it are being refetched
 * against a row that is gone.
 */
const emit = defineEmits<{
  deleted: [event: { id: string; festivalId: string | null }];
}>();

const draft = ref<EventDraft>(draftOf(props.event));
/** Compared against the stored row rather than tracked as a boolean an input
 * handler has to remember to set. */
const pending = computed(() => draftChanges(props.event, draft.value) !== null);

watch(
  () => props.event,
  (event) => {
    if (!pending.value) {
      draft.value = draftOf(event);
    }
  },
);

const problem = computed(() => draftProblem(draft.value, props.event.timezone));

const PROBLEM_TEXT: Readonly<Record<DraftProblem, AdminMessageKey>> = {
  'start-missing': 'events.details.problem.startMissing',
  'end-missing': 'events.details.problem.endMissing',
  'period-inverted': 'events.details.problem.periodInverted',
  'doors-half-stated': 'events.details.problem.doorsHalfStated',
  'doors-inverted': 'events.details.problem.doorsInverted',
  'doors-outside-period': 'events.details.problem.doorsOutsidePeriod',
};

const stored = computed(() =>
  formatPeriod(props.event.period, props.event.timezone, props.locale),
);

const update = useUpdateEventDetails(() => props.orgId);
const remove = useDeleteEvent(() => props.orgId);

/** What the last save was refused for, kept on screen rather than shown as a
 * toast — docs/02 §7. Kept as the reason, not the sentence, so the sentence
 * follows a language switch. */
type Rejection =
  | { readonly reason: 'unavailable'; readonly action: 'save' | 'delete' }
  | {
      readonly reason:
        'conflict' | 'validation-failed' | 'forbidden' | 'refused';
      readonly detail: string;
    };
const rejection = ref<Rejection | null>(null);
const saved = ref(false);
const confirmingDelete = ref(false);

const rejectionText = computed(() => {
  const value = rejection.value;
  if (value === null) {
    return null;
  }
  if (value.reason === 'unavailable') {
    return value.action === 'save'
      ? t('events.details.saveUnavailable')
      : t('events.details.deleteUnavailable');
  }
  return value.reason === 'conflict'
    ? t('events.details.conflict', { detail: value.detail })
    : value.detail;
});

async function save(): Promise<void> {
  const changes = draftChanges(props.event, draft.value);
  if (changes === null) {
    return;
  }
  rejection.value = null;
  saved.value = false;

  const outcome = await update.mutateAsync({
    eventId: props.event.id,
    version: props.event.version,
    changes,
  });

  if (outcome.ok) {
    saved.value = true;
    return;
  }
  rejection.value =
    outcome.rejection.reason === 'unavailable'
      ? { reason: 'unavailable', action: 'save' }
      : outcome.rejection;
}

async function confirmDelete(): Promise<void> {
  rejection.value = null;
  const outcome = await remove.mutateAsync({
    eventId: props.event.id,
    version: props.event.version,
    festivalId: props.event.festival_id,
  });

  if (outcome.ok) {
    emit('deleted', {
      id: props.event.id,
      festivalId: props.event.festival_id,
    });
    return;
  }
  confirmingDelete.value = false;
  rejection.value =
    outcome.rejection.reason === 'unavailable'
      ? { reason: 'unavailable', action: 'delete' }
      : outcome.rejection;
}

function revert(): void {
  draft.value = draftOf(props.event);
  rejection.value = null;
  saved.value = false;
}

/** Clearing both fields is how the form says "publish no door times"; a
 * button for it because two fields to empty by hand is two chances to leave
 * one behind and land on `doors-half-stated`. */
function clearDoors(): void {
  draft.value = { ...draft.value, doorsOpen: '', doorsClose: '' };
}

/**
 * The swatches, which are not the whole palette.
 *
 * Keyed off the *draft* rather than the stored event so the extra swatch an
 * out-of-range colour earns (`eventColorChoices`) does not vanish from under
 * the pointer the moment something else in the grid is ticked — it stays
 * until the form is saved or discarded, which is the only way back to it.
 */
const palette = computed(() =>
  eventColorChoices(draft.value.color).map((index) => ({
    index,
    hex: eventColor(index),
    /** The one past the offered range, if this event holds one. Labelled
     * rather than silently mixed in: it is the only swatch on the grid that
     * nobody else can reach. */
    retained: index >= eventColorChoiceCount,
  })),
);

/** Ids are per-event because six of these render at once and a duplicated
 * `for`/`id` pair points every label at the first form on the page. */
const fieldId = (name: string): string => `evp-${props.event.id}-${name}`;
</script>

<template>
  <section class="evp-panel evp-details" :aria-labelledby="fieldId('heading')">
    <h3 :id="fieldId('heading')" class="evp-details-heading">
      <span
        class="evp-swatch evp-swatch--tag"
        :style="{ background: eventColor(draft.color) }"
        aria-hidden="true"
      />
      {{ event.name }}
    </h3>
    <p class="evp-muted evp-details-zone">
      {{ t('events.details.zone', { timeZone: stored.timeZoneLabel }) }}
    </p>

    <form novalidate @submit.prevent="save">
      <fieldset class="evp-group">
        <legend>{{ t('events.details.workingHours') }}</legend>
        <div class="evp-row">
          <p class="evp-field">
            <label :for="fieldId('start')">
              <span>{{ t('events.details.starts') }}</span>
              <input
                :id="fieldId('start')"
                v-model="draft.start"
                type="datetime-local"
              />
            </label>
          </p>
          <p class="evp-field">
            <label :for="fieldId('end')">
              <span>{{ t('events.details.ends') }}</span>
              <input
                :id="fieldId('end')"
                v-model="draft.end"
                type="datetime-local"
              />
            </label>
          </p>
        </div>
      </fieldset>

      <fieldset class="evp-group">
        <legend>{{ t('events.details.doors') }}</legend>
        <div class="evp-row">
          <p class="evp-field">
            <label :for="fieldId('doors-open')">
              <span>{{ t('events.details.doorsOpen') }}</span>
              <input
                :id="fieldId('doors-open')"
                v-model="draft.doorsOpen"
                type="datetime-local"
              />
            </label>
          </p>
          <p class="evp-field">
            <label :for="fieldId('doors-close')">
              <span>{{ t('events.details.doorsClose') }}</span>
              <input
                :id="fieldId('doors-close')"
                v-model="draft.doorsClose"
                type="datetime-local"
              />
            </label>
          </p>
        </div>
        <button
          type="button"
          class="evp-button evp-button--quiet"
          :disabled="draft.doorsOpen === '' && draft.doorsClose === ''"
          @click="clearDoors"
        >
          {{ t('events.details.clearDoors') }}
        </button>
      </fieldset>

      <fieldset class="evp-group">
        <legend>{{ t('events.details.colour') }}</legend>
        <div class="evp-palette">
          <label
            v-for="swatch in palette"
            :key="swatch.index"
            class="evp-swatch-option"
            :for="fieldId(`color-${swatch.index}`)"
            :style="{ '--evp-swatch': swatch.hex }"
          >
            <input
              :id="fieldId(`color-${swatch.index}`)"
              v-model="draft.color"
              type="radio"
              :name="fieldId('color')"
              :value="swatch.index"
            />
            <!-- The tick is what carries "selected" for anyone who cannot
                 tell the ring apart from the swatch beneath it; colour alone
                 would fail docs/14 §2, and on a grid of colours it would fail
                 it badly. -->
            <span class="evp-swatch" aria-hidden="true">✓</span>
            <span class="evp-visually-hidden">{{
              t('events.details.swatch', {
                index: swatch.index + 1,
                retained: swatch.retained ? 'yes' : 'no',
              })
            }}</span>
          </label>
        </div>
      </fieldset>

      <p v-if="problem !== null" class="evp-error" role="alert">
        {{ t(PROBLEM_TEXT[problem]) }}
      </p>
      <p v-else-if="rejectionText !== null" class="evp-error" role="alert">
        {{ rejectionText }}
      </p>
      <p v-else-if="saved && !pending" class="evp-saved" role="status">
        {{ t('events.details.saved') }}
      </p>

      <div class="evp-actions">
        <button
          type="submit"
          class="evp-button evp-button--primary"
          :disabled="!pending || problem !== null || update.isPending.value"
        >
          {{
            update.isPending.value
              ? t('common.status.saving')
              : t('events.details.saveChanges')
          }}
        </button>
        <button
          type="button"
          class="evp-button"
          :disabled="!pending"
          @click="revert"
        >
          {{ t('events.details.discard') }}
        </button>
      </div>
    </form>

    <div v-if="canDelete" class="evp-danger-zone">
      <template v-if="!confirmingDelete">
        <button
          type="button"
          class="evp-button evp-button--danger"
          @click="confirmingDelete = true"
        >
          {{ t('events.details.delete') }}
        </button>
        <p class="evp-hint">{{ t('events.details.deleteHint') }}</p>
      </template>
      <template v-else>
        <p role="alert" class="evp-confirm">
          {{ t('events.details.deleteConfirm', { name: event.name }) }}
        </p>
        <div class="evp-actions">
          <button
            type="button"
            class="evp-button evp-button--danger"
            :disabled="remove.isPending.value"
            @click="confirmDelete"
          >
            {{
              remove.isPending.value
                ? t('events.details.deleting')
                : t('events.details.confirmDelete')
            }}
          </button>
          <button
            type="button"
            class="evp-button"
            @click="confirmingDelete = false"
          >
            {{ t('events.details.keep') }}
          </button>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.evp-details {
  margin-bottom: 1.5rem;
  /* The section inherits the board's full-window layout so the rail does not
     move between sections (`router/index.ts`); a form is still a form, and
     a datetime field stretched across 1800 px is unreadable. */
  max-width: 44rem;
}

.evp-details-heading {
  align-items: center;
  display: flex;
  font-size: 1.0625rem;
  gap: 0.5rem;
  margin: 0 0 0.25rem;
}

.evp-details-zone {
  font-size: 0.875rem;
  margin: 0 0 1rem;
}

.evp-muted {
  color: var(--evp-text-muted);
}

.evp-group {
  border: none;
  border-top: 1px solid var(--evp-border);
  margin: 0 0 1rem;
  padding: 1rem 0 0;
}

.evp-group legend {
  font-weight: 600;
  padding: 0;
}

.evp-hint {
  color: var(--evp-text-muted);
  font-size: 0.875rem;
  margin: 0 0 0.75rem;
  max-width: 60ch;
}

.evp-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0 1rem;
}

.evp-row .evp-field {
  flex: 1 1 14rem;
}

/* A fixed cell size rather than a fraction of the column: a colour chosen at
   40 px is the colour you get, and a swatch that reflows to 9 px on a phone is
   a swatch nobody can hit (docs/14 §2 puts the floor at 24 px). */
.evp-palette {
  display: grid;
  gap: 0.375rem;
  grid-template-columns: repeat(auto-fill, minmax(2.25rem, 1fr));
}

.evp-swatch-option {
  cursor: pointer;
  display: block;
  position: relative;
}

/* Off-screen rather than `display: none`: a hidden radio is not focusable, and
   the keyboard path through this grid is the native radio group. */
.evp-swatch-option input {
  height: 1px;
  opacity: 0;
  position: absolute;
  width: 1px;
}

.evp-swatch {
  align-items: center;
  aspect-ratio: 1;
  background: var(--evp-swatch);
  border: 2px solid transparent;
  border-radius: 0.375rem;
  /* The tick is invisible until the swatch is chosen, but it is always laid
     out, so selecting one does not shift the grid under the pointer. */
  color: transparent;
  display: flex;
  font-size: 1rem;
  font-weight: 700;
  justify-content: center;
  min-height: 2.25rem;
  width: 100%;
}

.evp-swatch--tag {
  border-radius: 0.25rem;
  display: inline-block;
  height: 0.875rem;
  min-height: 0;
  width: 0.875rem;
}

.evp-swatch-option input:checked + .evp-swatch {
  border-color: var(--evp-text);
  /* Every palette entry clears 4.5:1 against white, which is what lets one
     tick colour work on every swatch (packages/shared/src/eventColors.ts). */
  color: #ffffff;
}

.evp-swatch-option input:focus-visible + .evp-swatch {
  outline: 3px solid var(--evp-focus);
  outline-offset: 2px;
}

.evp-visually-hidden {
  clip-path: inset(50%);
  height: 1px;
  overflow: hidden;
  position: absolute;
  white-space: nowrap;
  width: 1px;
}

.evp-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
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

.evp-saved {
  color: var(--evp-success);
  margin: 0 0 1rem;
}

.evp-button--quiet {
  min-height: 2.25rem;
  padding: 0.375rem 0.75rem;
}

.evp-button--danger {
  border-color: var(--evp-danger);
  color: var(--evp-danger);
}

.evp-button--danger:hover {
  border-color: var(--evp-danger);
}

.evp-danger-zone {
  border-top: 1px solid var(--evp-border);
  margin-top: 1.5rem;
  padding-top: 1rem;
}

.evp-confirm {
  margin: 0 0 0.75rem;
}
</style>
