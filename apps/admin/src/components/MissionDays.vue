<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * The days a zone runs on, as checkboxes in its open row.
 *
 * Every day of the festival is a box, ticked when the zone has a row on it.
 * Before this, the days were a reading: a zone created on every day stayed on
 * every day unless somebody narrowed the page to one day and deleted it there,
 * and a day missing a zone could only be filled by recreating it by hand.
 *
 * Ticking a day creates the zone there with its posts (`missionDays.ts`'s
 * `dayCopy`). Unticking one deletes that day's row straight away when it
 * holds nothing else, since ticking it again restores it. When it holds posts
 * or shifts, the dialog names them first, because the cascade takes them and
 * ticking the day again would not.
 */
import { computed, ref, useTemplateRef } from 'vue';

import type { LocationWriteRejection } from '../api/locations';
import {
  refusedDaysText,
  useAddZoneDay,
  useRemoveZoneDay,
} from '../api/useMissionWrites';
import { useShiftsReader } from '../api/useShifts';
import ConfirmDialog from './ConfirmDialog.vue';
import { t } from '../i18n';
import { missionId, type DayRef, type ZoneGroup } from '../plan/missionCatalog';
import {
  canRemoveDay,
  dayCopy,
  dayRemoval,
  type DayRemoval,
} from '../plan/missionDays';
import { injectMissionEditing } from '../plan/useMissionEditing';

const props = defineProps<{
  readonly orgId: string;
  readonly group: ZoneGroup;
  /** Every day of the festival, in the day strip's order. */
  readonly days: readonly DayRef[];
}>();

const addDay = useAddZoneDay(() => props.orgId);
const removeDay = useRemoveZoneDay(() => props.orgId);
const readShifts = useShiftsReader(() => props.orgId);
const editing = injectMissionEditing();

/** The day a write or a shift read is in flight for, so only its box says
 * so; the others stay pressable for a different day. */
const workingOn = ref<string | null>(null);
const refusal = ref<string | null>(null);
const confirming = ref<{ day: DayRef; removal: DayRemoval } | null>(null);
const confirmRefusal = ref<string | null>(null);

const zone = computed(() => props.group.zone);
const runsOn = computed(
  () => new Set(zone.value.placements.map((placement) => placement.eventId)),
);
const removable = computed(() => canRemoveDay(zone.value));

/** Keyed on a row id rather than the zone's name, for `MissionCard.vue`'s
 * reason: a typed name is not a safe `id`. */
const boxId = (day: DayRef): string =>
  `evp-mission-days-${zone.value.placements[0]?.locationId ?? ''}-${day.eventId}`;

function oneDayText(day: DayRef, rejection: LocationWriteRejection): string {
  return refusedDaysText({
    applied: 0,
    refusals: [{ ...day, rejection }],
  });
}

async function add(day: DayRef): Promise<void> {
  workingOn.value = day.eventId;
  const outcome = await addDay.mutateAsync({ day, copy: dayCopy(props.group) });
  workingOn.value = null;

  if (outcome.zoneCreated) {
    editing?.record({
      kind: 'day',
      missionId: missionId(zone.value),
      day,
      added: true,
    });
  }
  if (!outcome.zoneCreated) {
    refusal.value = t('missions.days.notAdded', {
      name: zone.value.name,
      days: oneDayText(day, outcome.rejection),
    });
  } else if (outcome.posts.refusals.length > 0) {
    refusal.value = t('missions.days.postsNotCopied', {
      name: zone.value.name,
      day: day.eventName,
      count: outcome.posts.refusals.length,
      days: refusedDaysText(outcome.posts),
    });
  }
}

async function remove(day: DayRef, removal: DayRemoval): Promise<boolean> {
  workingOn.value = day.eventId;
  const result = await removeDay.mutateAsync(removal.placement);
  workingOn.value = null;
  if (result.ok) {
    // A removal that took posts or shifts with it is not a step: ticking the
    // day again would not bring them back (ADR-0049).
    if (!removal.cascades) {
      editing?.record({
        kind: 'day',
        missionId: missionId(zone.value),
        day,
        added: false,
      });
    }
    return true;
  }
  const text = t('missions.days.notRemoved', {
    name: zone.value.name,
    days: oneDayText(day, result.rejection),
  });
  if (confirming.value === null) {
    refusal.value = text;
  } else {
    confirmRefusal.value = text;
  }
  return false;
}

async function askToRemove(day: DayRef): Promise<void> {
  workingOn.value = day.eventId;
  const shifts = await readShifts(day.eventId);
  workingOn.value = null;
  if (!shifts.ok) {
    refusal.value = t('missions.days.checkFailed', { day: day.eventName });
    return;
  }

  const removal = dayRemoval(props.group, day.eventId, shifts.value);
  if (removal === null) {
    return;
  }
  if (removal.cascades) {
    confirmRefusal.value = null;
    confirming.value = { day, removal };
    return;
  }
  await remove(day, removal);
}

const boxes = useTemplateRef<HTMLInputElement[]>('boxes');

/**
 * Puts every box back to what is stored. A click flips the native box before
 * anything is written, and `:checked` only re-renders when its value changes,
 * so a refused write or a cancelled confirmation would otherwise leave a box
 * saying the opposite of the database.
 */
function resync(): void {
  for (const box of boxes.value ?? []) {
    box.checked = runsOn.value.has(box.value);
  }
}

async function toggle(day: DayRef): Promise<void> {
  refusal.value = null;
  if (runsOn.value.has(day.eventId)) {
    await askToRemove(day);
  } else {
    await add(day);
  }
  // Left as ticked by the coordinator while the dialog asks.
  if (confirming.value === null) {
    resync();
  }
}

function cancelRemove(): void {
  confirming.value = null;
  resync();
}

async function confirmRemove(): Promise<void> {
  const pending = confirming.value;
  if (pending === null) {
    return;
  }
  if (await remove(pending.day, pending.removal)) {
    confirming.value = null;
    resync();
  }
}
</script>

<template>
  <!-- Checkboxes rather than pressable chips: a chip's pressed state read as
       decoration, and "which of these days does the bar run on?" is exactly
       the question a labelled checkbox answers. -->
  <fieldset class="evp-day-toggles">
    <legend>{{ t('missions.days.legend') }}</legend>
    <label
      v-for="day in days"
      :key="day.eventId"
      :for="boxId(day)"
      class="evp-day-toggle"
      :class="{ 'evp-day-toggle--busy': workingOn === day.eventId }"
    >
      <input
        :id="boxId(day)"
        ref="boxes"
        type="checkbox"
        :value="day.eventId"
        :checked="runsOn.has(day.eventId)"
        :disabled="
          workingOn !== null || (runsOn.has(day.eventId) && !removable)
        "
        :aria-busy="workingOn === day.eventId"
        @change="toggle(day)"
      />
      <span>{{ day.eventName }}</span>
    </label>
    <!-- Said in text, not only by a greyed-out box: a disabled checkbox
         alone does not say why. -->
    <p v-if="!removable" class="evp-day-hint">
      {{ t('missions.days.lastDay') }}
    </p>
    <p v-if="refusal !== null" class="evp-day-refusal" role="alert">
      {{ refusal }}
    </p>
  </fieldset>

  <!-- Mounted only while asking: a dozen zones would otherwise each carry a
       closed dialog nobody opens. -->
  <ConfirmDialog
    v-if="confirming !== null"
    class="evp-day-confirm"
    :open="true"
    :title="
      t('missions.days.confirm.title', {
        name: zone.name,
        day: confirming.day.eventName,
      })
    "
    :confirm-label="t('missions.days.confirm.confirm')"
    :busy-label="t('missions.days.confirm.busy')"
    :busy="removeDay.isPending.value"
    :error="confirmRefusal"
    @confirm="confirmRemove"
    @cancel="cancelRemove"
  >
    <p>
      {{
        t('missions.days.confirm.intro', {
          name: zone.name,
          day: confirming.day.eventName,
        })
      }}
    </p>
    <ul>
      <li v-if="confirming.removal.postNames.length > 0">
        {{
          t('missions.days.confirm.posts', {
            count: confirming.removal.postNames.length,
            names: confirming.removal.postNames.join(', '),
          })
        }}
      </li>
      <li v-if="confirming.removal.shiftCount > 0">
        {{
          t('missions.days.confirm.shifts', {
            count: confirming.removal.shiftCount,
          })
        }}
      </li>
    </ul>
    <p>
      <strong>{{ t('missions.card.deleteConfirm.irreversible') }}</strong>
    </p>
  </ConfirmDialog>
</template>

<style scoped>
.evp-day-toggles {
  border: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 1rem;
  margin: 0.75rem 0 0 1.625rem;
  min-width: 0;
  padding: 0;
}

.evp-day-toggles legend {
  font-weight: 500;
  margin-bottom: 0.25rem;
  padding: 0;
}

.evp-day-toggle {
  align-items: center;
  cursor: pointer;
  display: inline-flex;
  gap: 0.5rem;
  min-height: 2rem;
}

.evp-day-toggle input {
  height: 1.125rem;
  width: 1.125rem;
}

.evp-day-toggle--busy {
  cursor: progress;
  opacity: 0.6;
}

.evp-day-hint,
.evp-day-refusal {
  flex-basis: 100%;
  font-size: 0.875rem;
  margin: 0;
}

.evp-day-hint {
  color: var(--evp-text-muted);
}

.evp-day-refusal {
  color: var(--evp-danger);
}
</style>
