<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * Event details: the settings behind the board, one row per event in scope.
 *
 * Scope-following rather than day-only, for the same reason the missions
 * section is (`PlanDetailView.vue`). A coordinator setting up Soundclash 26
 * fixes six days' hours, doors and colours in one sitting, and a page that
 * only ever showed the selected day would make that six navigations with no
 * way to see that Saturday and Sunday had ended up the same colour. Narrowed
 * to one day it is that day's row, open, which is the other half of the same
idea.

Laid out as the missions page is (ADR-0051): the add form first, then one
list of rows that open into their fields, each saving itself, with the save
status and Ctrl+Z for the whole page kept in view above them.
 *
 * The section is coordinator-visible and its delete button is not: `DELETE
 * /events/{event}` is owner-only (docs/04 §4), so the membership is consulted
 * for the *org this page is under*, never "is this person an owner anywhere".
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRouter } from 'vue-router';

import { usePlanScope } from '../api/usePlan';
import { useSession } from '../api/useSession';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import EventCard from '../components/EventCard.vue';
import HelpModal from '../components/HelpModal.vue';
import NewEventForm from '../components/NewEventForm.vue';
import { formatPeriod, periodText } from '../format/period';
import { locale, t } from '../i18n';
import { undoKeyOf } from '../plan/undoKeys';
import { provideEventEditing } from '../plan/useEventEditing';
import { useRouteParam } from '../router/params';

const router = useRouter();
const orgId = useRouteParam('orgId');
const festivalId = useRouteParam('festivalId');
const eventId = useRouteParam('eventId');

const { data: session } = useSession();

const isOwner = computed(() => {
  const value = session.value;
  if (value?.status !== 'authenticated') {
    return false;
  }
  return value.user.memberships.some(
    (membership) =>
      membership.org_id === orgId.value && membership.role === 'owner',
  );
});

const { scope, isPending } = usePlanScope(orgId, festivalId, eventId);

/** At event scope this is the one day; at festival scope it is every day of
 * the production, in the order the day strip shows them. */
const events = computed(() => {
  const value = scope.value;
  if (value === null) {
    return [];
  }
  return value.selected === null ? value.days : [value.selected];
});

/** The production's dates, here with the rest of its settings rather than
 * above every section: the festival's when there is one, a standalone event's
 * own otherwise. Narrowed to a day, the day summary above the section and the
 * row below already date it. */
const productionPeriod = computed(() => {
  const value = scope.value;
  if (value === null) {
    return null;
  }
  const dated =
    value.festival === null
      ? value.selected
      : value.selected === null
        ? value.festival
        : null;
  return dated === null
    ? null
    : periodText(formatPeriod(dated.period, dated.timezone, locale.value));
});

/**
 * What a new day would be added to, or `null` when the page is a standalone
 * event and there is no production to add to.
 *
 * Narrowed to one day this still answers with that day's festival rather than
 * with the day: adding a day while reading Saturday adds it to Soundclash 26,
 * which is the only reading that makes sense — a day cannot contain a day.
 */
const production = computed(() => {
  const value = scope.value;
  if (value === null) {
    return null;
  }
  const festival = value.festival;
  return festival === null
    ? {
        festivalId: null,
        name: value.selected?.name ?? '',
        timezone: value.selected?.timezone ?? '',
      }
    : {
        festivalId: festival.id,
        name: festival.name,
        timezone: festival.timezone,
      };
});

/**
 * The slugs already spoken for, for the form's own duplicate check.
 *
 * Every day this page covers, which at day scope is still the whole festival
 * (`scope.days`) rather than the one row below — the clash the server would
 * report is against the org, and the days are the part of it this page knows.
 */
const takenSlugs = computed(() =>
  (scope.value?.days ?? []).map((day) => day.slug),
);

/**
 * Where to go once an event is gone.
 *
 * Back to the festival if it had one — its other days are still there and the
 * coordinator is mid-setup — and to the events list otherwise, because a
 * standalone event that has been deleted leaves no page behind. Either way
 * the current URL must not survive: it names a row the server will now answer
 * `404` for.
 *
 * The festival comes from the event that was deleted rather than from `scope`,
 * which is exactly the state the delete has just invalidated: reading it here
 * gave `null` and sent every deletion to the events list, by way of one frame
 * of "this page could not be loaded".
 */
async function afterDelete(deleted: {
  readonly id: string;
  readonly festivalId: string | null;
}): Promise<void> {
  // The day is gone, so nothing of it is left to save or to ask about.
  leavingAfterDelete = true;
  await (deleted.festivalId === null
    ? router.push({ name: 'org-events', params: { orgId: orgId.value } })
    : router.push({
        name: 'org-festival-details',
        params: { orgId: orgId.value, festivalId: deleted.festivalId },
      }));
}

/**
 * Rows whose fields are showing, as the ones that differ from the default.
 * The default is open when the page shows one day, which is the visit that
 * came to change it, and closed at festival scope, where six open forms
 * would bury the column of days the page is for.
 */
const toggled = ref<ReadonlySet<string>>(new Set());
const openByDefault = computed(() => events.value.length === 1);

function isOpen(id: string): boolean {
  return openByDefault.value !== toggled.value.has(id);
}

function setOpen(id: string, open: boolean): void {
  const next = new Set(toggled.value);
  if (open === openByDefault.value) {
    next.delete(id);
  } else {
    next.add(id);
  }
  toggled.value = next;
}

// ── Saving and undo (ADR-0051) ──────────────────────────────────────────────

const editing = provideEventEditing();
const { undoable, redoable, saveState, announcement } = editing;

const saveStatus = computed(() => {
  const state = saveState.value;
  if (state.state === 'blocked') {
    return t('events.toolbar.blocked', { count: state.blocked });
  }
  return state.state === 'saving'
    ? t('common.status.saving')
    : t('events.toolbar.allSaved');
});

const confirmingLeave = ref(false);
let answerLeave: ((leave: boolean) => void) | null = null;
let leavingAfterDelete = false;

/** Sends what is pending, and asks only when something still cannot be saved
 * (ADR-0049's rule, kept here). */
async function confirmLeave(): Promise<boolean> {
  if (leavingAfterDelete) {
    leavingAfterDelete = false;
    return true;
  }
  await editing.flushAll();
  if (saveState.value.state !== 'blocked') {
    return true;
  }
  confirmingLeave.value = true;
  return new Promise((resolve) => {
    answerLeave = resolve;
  });
}

function answer(leave: boolean): void {
  confirmingLeave.value = false;
  answerLeave?.(leave);
  answerLeave = null;
}

onBeforeRouteLeave(confirmLeave);
onBeforeRouteUpdate(confirmLeave);

function onUndoKey(event: KeyboardEvent): void {
  const command = undoKeyOf(event);
  if (command === null || confirmingLeave.value) {
    return;
  }
  event.preventDefault();
  if (command === 'undo') {
    editing.undo();
  } else {
    editing.redo();
  }
}

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (saveState.value.state !== 'saved') {
    event.preventDefault();
  }
}

onMounted(() => {
  window.addEventListener('keydown', onUndoKey);
  window.addEventListener('beforeunload', onBeforeUnload);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onUndoKey);
  window.removeEventListener('beforeunload', onBeforeUnload);
});
</script>

<template>
  <p v-if="isPending">{{ t('common.status.loading') }}</p>

  <template v-else>
    <HelpModal :title="t('events.detailsPage.helpTitle')">
      <p v-if="events.length > 1">
        {{ t('events.detailsPage.allDays') }}
      </p>
      <p>
        <strong>{{ t('events.detailsPage.help.workingHoursTerm') }}</strong> —
        {{ t('events.detailsPage.help.workingHours') }}
      </p>
      <p>
        <strong>{{ t('events.detailsPage.help.doorsTerm') }}</strong> —
        {{ t('events.detailsPage.help.doors') }}
      </p>
      <p>
        <strong>{{ t('events.detailsPage.help.colourTerm') }}</strong> —
        {{ t('events.detailsPage.help.colour') }}
      </p>
    </HelpModal>

    <p v-if="productionPeriod" class="evp-muted evp-period">
      {{ productionPeriod }}
    </p>

    <!-- Whether everything is saved, and undo, as on the missions page. The
         status is a live region, so a save that could not happen is heard,
         not only seen. -->
    <div
      v-if="events.length > 0"
      class="evp-toolbar"
      role="group"
      :aria-label="t('events.toolbar.label')"
    >
      <span
        class="evp-toolbar-status"
        :class="{
          'evp-toolbar-status--blocked': saveState.state === 'blocked',
        }"
        role="status"
        >{{ saveStatus }}</span
      >
      <button
        type="button"
        class="evp-icon-button"
        :disabled="!undoable"
        :aria-label="t('events.toolbar.undo')"
        :title="t('events.toolbar.undoHint')"
        aria-keyshortcuts="Control+Z Meta+Z"
        @click="editing.undo"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M9 14 4 9l5-5" />
          <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
        </svg>
      </button>
      <button
        type="button"
        class="evp-icon-button"
        :disabled="!redoable"
        :aria-label="t('events.toolbar.redo')"
        :title="t('events.toolbar.redoHint')"
        aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y"
        @click="editing.redo"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="m15 14 5-5-5-5" />
          <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
        </svg>
      </button>
      <span class="evp-visually-hidden" role="status">{{ announcement }}</span>
    </div>

    <!-- Above the list, where the missions page puts its own: the button is
         one line until it is pressed, so it costs the rows nothing. -->
    <NewEventForm
      v-if="production !== null"
      :org-id="orgId"
      :festival-id="production.festivalId"
      :production-name="production.name"
      :timezone="production.timezone"
      :taken-slugs="takenSlugs"
    />

    <p v-if="events.length === 0" class="evp-muted">
      {{ t('events.detailsPage.noDays') }}
    </p>

    <div v-else class="evp-event-list">
      <EventCard
        v-for="day in events"
        :key="day.id"
        :org-id="orgId"
        :event="day"
        :locale="locale"
        :can-delete="isOwner"
        :expanded="isOpen(day.id)"
        @update:expanded="setOpen(day.id, $event)"
        @deleted="afterDelete"
      />
    </div>

    <ConfirmDialog
      v-if="confirmingLeave"
      :open="true"
      :title="t('events.leave.title')"
      :confirm-label="t('events.leave.confirm')"
      :busy-label="t('events.leave.confirm')"
      :busy="false"
      :cancel-label="t('events.leave.stay')"
      @confirm="answer(true)"
      @cancel="answer(false)"
    >
      <p>{{ t('events.leave.body') }}</p>
    </ConfirmDialog>
  </template>
</template>

<style scoped>
h2 {
  font-size: 1.125rem;
  margin: 0 0 1rem;
}

.evp-muted {
  color: var(--evp-text-muted);
}

.evp-period {
  margin: 0 0 1rem;
}

.evp-event-list {
  background: var(--evp-surface-raised);
  border: var(--evp-edge) solid var(--evp-border);
  border-radius: var(--evp-radius-lg);
  max-width: 72rem;
}

.evp-event-list > * + * {
  border-top: var(--evp-edge) solid var(--evp-border);
}

/* Kept in view down a long list, as the missions page's is. */
.evp-toolbar {
  align-items: center;
  background: var(--evp-surface);
  display: flex;
  gap: 0.25rem;
  justify-content: flex-end;
  max-width: 72rem;
  padding-block: 0.25rem;
  position: sticky;
  top: 0;
  z-index: 1;
}

.evp-toolbar-status {
  color: var(--evp-text-muted);
  font-size: 0.875rem;
  margin-right: 0.5rem;
}

.evp-toolbar-status--blocked {
  color: var(--evp-danger);
  font-weight: 600;
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
  fill: none;
  height: 1.125rem;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 2;
  width: 1.125rem;
}

.evp-icon-button:hover:not([disabled]) {
  background: var(--evp-surface-raised);
  color: var(--evp-text);
}

.evp-icon-button[disabled] {
  cursor: not-allowed;
  opacity: 0.4;
}

.evp-visually-hidden {
  clip-path: inset(50%);
  height: 1px;
  overflow: hidden;
  position: absolute;
  white-space: nowrap;
  width: 1px;
}
</style>
