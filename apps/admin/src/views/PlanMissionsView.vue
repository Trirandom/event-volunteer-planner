<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * Missions: what the work *is*, as opposed to when it happens.
 *
 * The shift board next door answers "where is the hole?" and it answers it as
 * a shape on a timeline. It has no room for the two things a volunteer needs
 * before they can work a post — what the job is and where to stand — and a
 * gutter label is not a briefing. Those lived in the free-text column of the
 * Google Sheet this replaces and were the first thing lost in the move; this
 * is where they come back.
 *
 * **Scope-following, like the details section.** A coordinator setting up
 * Soundclash 26 declares its missions once for the whole production, so at
 * festival scope this page is the fold across every day (`missionCatalog.ts`)
 * and each write fans out over the rows behind it (`useMissionWrites.ts`).
 * Narrowed to Saturday it is Saturday's rows, which is the same page with one
 * day in it — and the way to correct a single day after the festival-wide edit
 * that created it.
 *
 * The fold is by name, which is honest about what it can get wrong: two
 * unrelated posts sharing a word become one card, a typo splits one in two.
 * Both are visible, because every card lists the days it covers — a reading no
 * card can give without also giving away a fold nobody intended.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router';

import { useMissionCatalog, usePlanScope } from '../api/usePlan';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import HelpModal from '../components/HelpModal.vue';
import MissionCard from '../components/MissionCard.vue';
import NewMissionForm from '../components/NewMissionForm.vue';
import NewPostForm from '../components/NewPostForm.vue';
import { groupByZone, missionId } from '../plan/missionCatalog';
import { undoKeyOf } from '../plan/undoKeys';
import { provideMissionEditing } from '../plan/useMissionEditing';
import { t } from '../i18n';
import { useRouteParam } from '../router/params';

const orgId = useRouteParam('orgId');
const festivalId = useRouteParam('festivalId');
const eventId = useRouteParam('eventId');

const { scope, isPending: scopePending } = usePlanScope(
  orgId,
  festivalId,
  eventId,
);

/** At event scope this is the one day; at festival scope it is every day of
 * the production, in the order the day strip shows them — the same narrowing
 * `PlanDetailsView.vue` makes, and for the same reason. */
const events = computed(() => {
  const value = scope.value;
  if (value === null) {
    return [];
  }
  return value.selected === null ? value.days : [value.selected];
});

const {
  catalog,
  isPending: catalogPending,
  locationsFailed,
} = useMissionCatalog(orgId, events);

const isPending = computed(() => scopePending.value || catalogPending.value);

/** Every name in use, so a card and the add form can both refuse a duplicate
 * before the fan-out turns one collision into six identical refusals. */
const takenKeys = computed(() =>
  catalog.value.missions.map((mission) => mission.key),
);

const dayCount = computed(() => catalog.value.days.length);

/**
 * The fold, reassembled into the tree it actually is — a zone's card and the
 * posts nested under it, rather than one undifferentiated list where a zone
 * that holds a dozen posts looks exactly like a post that holds none. This is
 * also where deletion's blast radius becomes visible: `group.posts` is
 * passed to the zone's card so its confirmation can name every post the
 * cascade would take with it.
 */
const grouped = computed(() => groupByZone(catalog.value.missions));

/**
 * Zones whose row is open, by `missionId`. Kept here rather than in each card
 * because the open state is also what shows "add a post" under the zone's
 * posts: most zones never get one, and the button under every zone was most
 * of the page. By id and not by name, so a rename, saved mid-word, does not
 * close the row being typed in.
 */
const openZones = ref<ReadonlySet<string>>(new Set());

function setZoneOpen(key: string, open: boolean): void {
  const next = new Set(openZones.value);
  if (open) {
    next.add(key);
  } else {
    next.delete(key);
  }
  openZones.value = next;
}

// ── Saving and undo (ADR-0049) ──────────────────────────────────────────────

const editing = provideMissionEditing({
  orgId,
  groups: () => grouped.value.zones,
});
const { undoable, redoable, saveState, announcement } = editing;

const saveStatus = computed(() => {
  const state = saveState.value;
  if (state.state === 'blocked') {
    return t('missions.toolbar.blocked', { count: state.blocked });
  }
  return state.state === 'saving'
    ? t('common.status.saving')
    : t('missions.toolbar.allSaved');
});

const confirmingLeave = ref(false);
let answerLeave: ((leave: boolean) => void) | null = null;

/** Sends what is pending, and asks only when something still cannot be saved
 * (ADR-0048's rule, kept here). */
async function confirmLeave(): Promise<boolean> {
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
  void (command === 'undo' ? editing.undo() : editing.redo());
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
    <HelpModal :title="t('missions.view.help.title')">
      <p>{{ t('missions.view.help.intro') }}</p>
      <p v-if="dayCount > 1">
        {{ t('missions.view.help.festival', { count: dayCount }) }}
      </p>
    </HelpModal>

    <!-- Louder than the board's version of this warning, because a day whose
         tree did not load is indistinguishable from a day that simply does not
         run the mission — and the difference decides whether "add to the
         missing days" would create a duplicate. -->
    <p v-if="locationsFailed" role="alert" class="evp-error">
      {{ t('missions.view.locationsFailed') }}
    </p>

    <!-- Whether everything is saved, and undo: the two things a coordinator
         needs from anywhere down a long list. The status is a live region,
         so a save that could not happen is heard, not only seen. -->
    <div
      v-if="catalog.missions.length > 0"
      class="evp-toolbar"
      role="group"
      :aria-label="t('missions.toolbar.label')"
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
        :aria-label="t('missions.toolbar.undo')"
        :title="t('missions.toolbar.undoHint')"
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
        :aria-label="t('missions.toolbar.redo')"
        :title="t('missions.toolbar.redoHint')"
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

    <NewMissionForm
      v-if="catalog.days.length > 0"
      :org-id="orgId"
      :days="catalog.days"
      :taken-keys="takenKeys"
    />

    <p v-if="catalog.days.length === 0" class="evp-muted">
      {{ t('missions.view.noDays') }}
    </p>
    <p v-else-if="catalog.missions.length === 0" class="evp-empty">
      {{ t('missions.view.empty') }}
    </p>

    <!-- One list rather than a panel per mission: a festival's missions are
         read as a column, name by name, and a dozen boxed cards spent most
         of their height on borders. A zone's posts sit indented under it, so
         the tree is a shape rather than a fact only the kind tags state. -->
    <div
      v-if="grouped.zones.length > 0 || grouped.orphans.length > 0"
      class="evp-mission-list"
    >
      <div
        v-for="group in grouped.zones"
        :key="missionId(group.zone)"
        class="evp-mission-group"
      >
        <MissionCard
          :org-id="orgId"
          :mission="group.zone"
          :taken-keys="takenKeys"
          :day-count="dayCount"
          :nested-posts="group.posts"
          :days="catalog.days"
          :expanded="openZones.has(missionId(group.zone))"
          @update:expanded="setZoneOpen(missionId(group.zone), $event)"
        />

        <div
          v-if="group.posts.length > 0 || openZones.has(missionId(group.zone))"
          class="evp-posts"
          role="group"
          :aria-label="
            t('missions.view.postsInZone', { zone: group.zone.name })
          "
        >
          <MissionCard
            v-for="post in group.posts"
            :key="missionId(post)"
            :org-id="orgId"
            :mission="post"
            :taken-keys="takenKeys"
            :day-count="dayCount"
          />

          <NewPostForm
            v-if="openZones.has(missionId(group.zone))"
            :org-id="orgId"
            :zone="group.zone"
            :taken-keys="takenKeys"
          />
        </div>
      </div>

      <!-- A post whose zone this catalog cannot identify: its own zone row is
           gone, or the days disagree about which zone it is in. Shown flat
           rather than dropped, with the same "Post" tag, so it stays
           reachable even when it cannot be nested with confidence. -->
      <MissionCard
        v-for="orphan in grouped.orphans"
        :key="missionId(orphan)"
        class="evp-mission-group"
        :org-id="orgId"
        :mission="orphan"
        :taken-keys="takenKeys"
        :day-count="dayCount"
      />
    </div>

    <!-- Mounted only while asking, so it is never in the way of the page's
         own dialogs. -->
    <ConfirmDialog
      v-if="confirmingLeave"
      :open="true"
      :title="t('missions.leave.title')"
      :confirm-label="t('missions.leave.confirm')"
      :busy-label="t('missions.leave.confirm')"
      :busy="false"
      :cancel-label="t('missions.leave.stay')"
      @confirm="answer(true)"
      @cancel="answer(false)"
    >
      <p>{{ t('missions.leave.body') }}</p>
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

.evp-empty {
  color: var(--evp-text-muted);
  max-width: 60ch;
}

.evp-error {
  background: var(--evp-surface);
  border: 1px solid var(--evp-danger);
  border-left-width: 4px;
  border-radius: 0.375rem;
  color: var(--evp-danger);
  margin: 0 0 1rem;
  max-width: 60ch;
  padding: 0.75rem;
}

.evp-mission-list {
  background: var(--evp-surface-raised);
  border: var(--evp-edge) solid var(--evp-border);
  border-radius: var(--evp-radius-lg);
  margin-top: 1rem;
  max-width: 72rem;
}

.evp-mission-group + .evp-mission-group {
  border-top: var(--evp-edge) solid var(--evp-border);
}

/* Indented under the zone, with a rail, so the grouping survives for
   somebody skimming past the text tags. */
.evp-posts {
  border-left: 2px solid var(--evp-border);
  margin: 0 0 0.5rem 1.5rem;
  padding-left: 0.5rem;
}

.evp-posts :deep(.evp-mission) {
  padding-block: 0.25rem;
}

.evp-posts :deep(.evp-add-post) {
  margin: 0.25rem 0.75rem 0.5rem;
}

/* Kept in view down a long list, as the form builder's is. */
.evp-toolbar {
  align-items: center;
  background: var(--evp-surface);
  display: flex;
  gap: 0.25rem;
  justify-content: flex-end;
  margin-top: 1rem;
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
