<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * One event's own settings, as a row of the details list: when it runs, when
 * the doors are open, what colour it is drawn in, and whether it should exist.
 *
 * A component per event rather than one form over a map keyed by event id.
 * The details section covers a whole festival at festival scope, so the page
 * can be showing six of these at once, and six independent drafts with six
 * independent error lines is what a coordinator editing Saturday while
 * Sunday's change is still blocked actually needs.
 *
 * **Closed, it is one line**, like a mission (`MissionCard.vue`): colour,
 * name, hours, doors. A festival's six days read as a column that way, and the
 * fields are one press on the name away.
 *
 * **It saves itself** about a second after the last edit (ADR-0051,
 * `plan/useAutosave.ts`), and every edit is a step the page can undo
 * (`plan/useEventEditing.ts`). A draft with a problem is not sent; the row
 * says why, and the next edit tries again.
 *
 * **The draft is re-seeded only for a change made elsewhere**, for the reason
 * `MissionCard.vue` gives: a save invalidates the queries behind the page, and
 * re-seeding after every save would rewrite a date field mid-edit.
 */
import {
  eventColor,
  eventColorChoiceCount,
  eventColorChoices,
} from '@evp/shared';
import type { ViewerLocale } from '@evp/shared/intl';
import { computed, onBeforeUnmount, ref, watch } from 'vue';

import type { Event } from '../api/events';
import { useDeleteEvent, useUpdateEventDetails } from '../api/useEvents';
import { formatPeriod, periodText } from '../format/period';
import { t, type AdminMessageKey } from '../i18n';
import {
  draftChanges,
  draftOf,
  draftProblem,
  type DraftProblem,
  type EventDraft,
} from '../plan/eventDraft';
import { useAutosave } from '../plan/useAutosave';
import {
  injectEventEditing,
  type EventSaveState,
} from '../plan/useEventEditing';
import ConfirmDialog from './ConfirmDialog.vue';

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

/** Whether the fields are on screen. A model because the page decides the
 * default: open when it shows one day, closed when it shows a festival. */
const expanded = defineModel<boolean>('expanded', { default: false });

const draft = ref<EventDraft>(draftOf(props.event));
/** Compared against the stored row rather than tracked as a boolean an input
 * handler has to remember to set. */
const pending = computed(() => draftChanges(props.event, draft.value) !== null);

const editing = injectEventEditing();
/** Fixed for the card's life: undo steps are filed under it. */
const eventId = props.event.id;

/** The draft as last recorded, so the next edit's step has a "before". Kept
 * as a copy because `v-model` edits the draft in place. */
let recorded: EventDraft = { ...draft.value };
/** Set while the draft is replaced by the page (undo, re-seed): that is not
 * the coordinator's edit, and recording it would make undo undo itself. */
let replacing = false;

function replaceDraft(next: EventDraft): void {
  replacing = true;
  draft.value = { ...next };
}

watch(
  draft,
  (next) => {
    const after = { ...next };
    if (replacing) {
      replacing = false;
    } else {
      editing?.record({ eventId, before: recorded, after });
    }
    recorded = after;
  },
  { deep: true },
);

watch(
  () => props.event,
  (event, previous) => {
    const wasInStep = draftChanges(previous, draft.value) === null;
    if (wasInStep && draftChanges(event, draft.value) !== null) {
      replaceDraft(draftOf(event));
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

const update = useUpdateEventDetails(() => props.orgId);
const remove = useDeleteEvent(() => props.orgId);

/** What a write was refused for, kept on screen rather than shown as a toast
 * — docs/02 §7. Kept as the reason, not the sentence, so the sentence follows
 * a language switch. */
type Rejection =
  | { readonly reason: 'unavailable' }
  | {
      readonly reason:
        'conflict' | 'validation-failed' | 'forbidden' | 'refused';
      readonly detail: string;
    };
const saveRejection = ref<Rejection | null>(null);
const deleteRejection = ref<Rejection | null>(null);
const confirmingDelete = ref(false);

function rejectionText(
  rejection: Rejection | null,
  write: 'save' | 'delete',
): string | null {
  if (rejection === null) {
    return null;
  }
  if (rejection.reason === 'unavailable') {
    return write === 'save'
      ? t('events.details.saveUnavailable')
      : t('events.details.deleteUnavailable');
  }
  return rejection.reason === 'conflict'
    ? t('events.details.conflict', { detail: rejection.detail })
    : rejection.detail;
}

const saveRefusal = computed(() => rejectionText(saveRejection.value, 'save'));
const deleteRefusal = computed(() =>
  rejectionText(deleteRejection.value, 'delete'),
);

async function save(): Promise<void> {
  const changes = draftChanges(props.event, draft.value);
  if (changes === null) {
    return;
  }
  const outcome = await update.mutateAsync({
    eventId: props.event.id,
    version: props.event.version,
    changes,
  });
  saveRejection.value = outcome.ok ? null : outcome.rejection;
}

const autosave = useAutosave({
  trigger: () => ({ ...draft.value }),
  canSave: () => pending.value && problem.value === null,
  save,
});

const saveState = computed((): EventSaveState => {
  // Before `pending`: a half-typed date is no change `draftChanges` can send,
  // and is still an edit that is not saved.
  if (problem.value !== null) {
    return 'blocked';
  }
  if (!pending.value) {
    return 'saved';
  }
  if (update.isPending.value || autosave.waiting.value) {
    return 'saving';
  }
  return saveRejection.value === null ? 'saving' : 'blocked';
});

if (editing !== null) {
  onBeforeUnmount(
    editing.register(eventId, {
      setDraft: replaceDraft,
      flush: autosave.flush,
      state: () => saveState.value,
    }),
  );
}

/** An edit that cannot be saved survives a collapse, since the draft lives
 * here and not in the form, so the closed row has to say it is there. */
const unsavedWhileCollapsed = computed(
  () => !expanded.value && saveState.value === 'blocked',
);

function askToDelete(): void {
  deleteRejection.value = null;
  confirmingDelete.value = true;
}

async function confirmDelete(): Promise<void> {
  deleteRejection.value = null;
  const outcome = await remove.mutateAsync({
    eventId: props.event.id,
    version: props.event.version,
    festivalId: props.event.festival_id,
  });

  if (outcome.ok) {
    confirmingDelete.value = false;
    emit('deleted', {
      id: props.event.id,
      festivalId: props.event.festival_id,
    });
    return;
  }
  deleteRejection.value = outcome.rejection;
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
 * the pointer the moment another one is picked — it stays until the page is
 * left, and undo can still reach it.
 */
const palette = computed(() =>
  eventColorChoices(draft.value.color).map((index) => ({
    index,
    hex: eventColor(index),
    /** The one past the offered range, if this event holds one. Labelled
     * rather than silently mixed in: it is the only swatch nobody else can
     * reach. */
    retained: index >= eventColorChoiceCount,
  })),
);

/** What the closed row says: the stored hours and doors, not the draft's,
 * because the line is a reading of what volunteers will be shown. */
const stored = computed(() =>
  formatPeriod(props.event.period, props.event.timezone, props.locale),
);
const hoursSummary = computed(() => periodText(stored.value));
const doorsSummary = computed(() => {
  const doors = props.event.public_period;
  if (doors === undefined) {
    return null;
  }
  const display = formatPeriod(doors, props.event.timezone, props.locale);
  return t('events.card.doors', {
    open: display.startTime,
    close: display.endTime,
  });
});

const busy = computed(() => update.isPending.value || remove.isPending.value);

/** Ids are per-event because six of these render at once and a duplicated
 * `for`/`id` pair points every label at the first row on the page. */
const fieldId = (name: string): string => `evp-${props.event.id}-${name}`;
</script>

<template>
  <section
    class="evp-event"
    :class="{ 'evp-event--open': expanded }"
    :aria-labelledby="fieldId('heading')"
  >
    <div class="evp-event-row">
      <h3 :id="fieldId('heading')" class="evp-event-heading">
        <!-- The name is the disclosure, as on a mission row: the biggest
             target on the line, inside the heading so the outline keeps it. -->
        <button
          type="button"
          class="evp-event-toggle"
          :aria-expanded="expanded"
          :aria-controls="fieldId('form')"
          @click="expanded = !expanded"
        >
          <svg
            class="evp-chevron"
            viewBox="0 0 24 24"
            aria-hidden="true"
            focusable="false"
          >
            <path
              d="m9 6 6 6-6 6"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <!-- The draft's colour, not the stored one, so a pick shows on the
               line straight away instead of a second later when it saves. -->
          <span
            class="evp-swatch evp-swatch--tag"
            :style="{ background: eventColor(draft.color) }"
            aria-hidden="true"
          />
          <span class="evp-event-name">{{ event.name }}</span>
        </button>
      </h3>

      <p v-if="!expanded" class="evp-summary">
        <span class="evp-summary-hours">{{ hoursSummary }}</span>
        <span
          class="evp-summary-item"
          :class="{ 'evp-summary-missing': doorsSummary === null }"
          >{{ doorsSummary ?? t('events.card.noDoors') }}</span
        >
      </p>

      <span v-if="unsavedWhileCollapsed" class="evp-tag evp-tag--unsaved">
        {{ t('events.card.unsaved') }}
      </span>

      <div v-if="canDelete" class="evp-event-row-actions">
        <button
          type="button"
          class="evp-icon-button evp-icon-button--danger"
          :disabled="busy"
          :aria-label="t('events.card.remove', { name: event.name })"
          :title="t('events.card.remove', { name: event.name })"
          aria-haspopup="dialog"
          @click="askToDelete"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path
              d="M5 7h14M10 7V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2m-8 0 .8 12.1A2 2 0 0 0 8.8 21h6.4a2 2 0 0 0 2-1.9L18 7"
              fill="none"
              stroke="currentColor"
              stroke-width="1.75"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>
    </div>

    <form
      v-if="expanded"
      :id="fieldId('form')"
      novalidate
      @submit.prevent="autosave.flush"
    >
      <p class="evp-muted evp-event-zone">
        {{ t('events.details.zone', { timeZone: stored.timeZoneLabel }) }}
      </p>

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
                 would fail docs/14 §2, and on a row of colours it would fail
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
      <p v-else-if="saveRefusal !== null" class="evp-error" role="alert">
        {{ saveRefusal }}
      </p>
    </form>

    <ConfirmDialog
      :open="confirmingDelete"
      :title="t('events.card.deleteTitle', { name: event.name })"
      :confirm-label="t('events.details.confirmDelete')"
      :busy-label="t('events.details.deleting')"
      :busy="remove.isPending.value"
      :cancel-label="t('events.details.keep')"
      :error="deleteRefusal"
      @confirm="confirmDelete"
      @cancel="confirmingDelete = false"
    >
      <p class="evp-confirm">
        {{ t('events.details.deleteConfirm', { name: event.name }) }}
      </p>
      <p class="evp-hint">{{ t('events.details.deleteHint') }}</p>
    </ConfirmDialog>
  </section>
</template>

<style scoped>
.evp-event {
  padding: 0.5rem 0.75rem;
}

/* One line: name, hours, doors, actions — `MissionCard.vue`'s row, so the two
   lists read as the same kind of thing. */
.evp-event-row {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem 0.75rem;
}

.evp-event-heading {
  align-items: center;
  display: flex;
  font-size: 1rem;
  margin: 0;
  min-width: 0;
}

.evp-event-toggle {
  align-items: center;
  background: none;
  border: 0;
  border-radius: var(--evp-radius-sm);
  color: inherit;
  cursor: pointer;
  display: inline-flex;
  font: inherit;
  gap: 0.375rem;
  margin: 0 0 0 -0.25rem;
  min-height: 2rem;
  padding: 0 0.25rem;
  text-align: left;
}

.evp-event-toggle:hover .evp-event-name {
  text-decoration: underline;
  text-underline-offset: 0.2em;
}

.evp-chevron {
  color: var(--evp-text-muted);
  flex-shrink: 0;
  height: 1.125rem;
  transition: transform 120ms ease;
  width: 1.125rem;
}

.evp-event--open .evp-chevron {
  transform: rotate(90deg);
}

@media (prefers-reduced-motion: reduce) {
  .evp-chevron {
    transition: none;
  }
}

.evp-event-row-actions {
  display: flex;
  flex-shrink: 0;
  margin-left: auto;
}

.evp-icon-button {
  align-items: center;
  background: transparent;
  border: var(--evp-edge) solid transparent;
  border-radius: var(--evp-radius-md);
  color: var(--evp-text-muted);
  cursor: pointer;
  display: inline-flex;
  height: 2rem;
  justify-content: center;
  padding: 0;
  width: 2rem;
}

.evp-icon-button svg {
  height: 1.125rem;
  width: 1.125rem;
}

.evp-icon-button:hover {
  background: var(--evp-surface-raised);
  border-color: var(--evp-border);
  color: var(--evp-text);
}

.evp-icon-button--danger:hover {
  border-color: var(--evp-danger);
  color: var(--evp-danger);
}

.evp-icon-button[disabled] {
  cursor: not-allowed;
  opacity: 0.5;
}

/* Takes what the row has left, and gives way first when it has nothing. */
.evp-summary {
  color: var(--evp-text-muted);
  display: flex;
  flex: 1 1 14rem;
  font-size: 0.875rem;
  gap: 0.75rem;
  margin: 0;
  min-width: 0;
}

.evp-summary-hours {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.evp-summary-item {
  flex-shrink: 0;
  white-space: nowrap;
}

.evp-summary-item::before {
  content: '·';
  margin-right: 0.75rem;
}

.evp-summary-missing {
  font-style: italic;
}

.evp-tag {
  border: var(--evp-edge) solid var(--evp-border);
  border-radius: var(--evp-radius-md);
  color: var(--evp-text-muted);
  font-size: 0.8125rem;
  padding: 0.0625rem 0.5rem;
}

.evp-tag--unsaved {
  border-color: var(--evp-warning);
  color: var(--evp-text);
}

/* Lined up under the name rather than the chevron, as a mission's form is.
   The list caps the width (`PlanDetailsView.vue`); this caps the fields, since
   a datetime field stretched across a wide row is unreadable. */
.evp-event form {
  margin: 0.75rem 0 0.25rem 1.625rem;
  max-width: 44rem;
}

.evp-event-zone {
  font-size: 0.875rem;
  margin: 0 0 0.75rem;
}

.evp-muted {
  color: var(--evp-text-muted);
}

.evp-group {
  border: none;
  border-top: var(--evp-edge) solid var(--evp-border);
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
   36 px is the colour you get, and a swatch that reflows to 9 px on a phone is
   a swatch nobody can hit (docs/14 §2 puts the floor at 24 px). Never more
   than sixteen to a row (ADR-0050): the offer is one row, and a seventeenth,
   retained swatch starts the next. */
.evp-palette {
  --evp-swatch-size: 2.25rem;
  --evp-swatch-gap: 0.375rem;

  display: grid;
  gap: var(--evp-swatch-gap);
  grid-template-columns: repeat(auto-fill, var(--evp-swatch-size));
  max-width: calc(16 * var(--evp-swatch-size) + 15 * var(--evp-swatch-gap));
}

.evp-swatch-option {
  cursor: pointer;
  display: block;
  position: relative;
}

/* Off-screen rather than `display: none`: a hidden radio is not focusable, and
   the keyboard path through this row is the native radio group. */
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
  border-radius: var(--evp-radius-sm);
  /* The tick is invisible until the swatch is chosen, but it is always laid
     out, so selecting one does not shift the row under the pointer. */
  color: transparent;
  display: flex;
  font-size: 1rem;
  font-weight: 700;
  justify-content: center;
  width: var(--evp-swatch-size);
}

.evp-swatch--tag {
  display: inline-block;
  flex-shrink: 0;
  height: 0.875rem;
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

.evp-error {
  color: var(--evp-danger);
  margin: 0 0 0.75rem;
}

.evp-button--quiet {
  min-height: 2.25rem;
  padding: 0.375rem 0.75rem;
}

.evp-confirm {
  margin: 0 0 0.75rem;
}
</style>
