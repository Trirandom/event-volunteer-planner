<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * One mission: what it is called, what the job is, where to stand, and whether
 * it should exist.
 *
 * A component per mission rather than one form over a map keyed by mission id,
 * for the reason `EventDetailsForm.vue` gives: a festival has a dozen of these
 * on screen at once, and a coordinator writing the bar's briefing while the
 * entrance's edit is still unsaved needs a dozen independent drafts and a
 * dozen independent error lines. One form would make that one shared dirty
 * flag.
 *
 * **Every write here is a fan-out.** The card shows one mission; the database
 * holds one row per day it runs on, and saving writes all of them
 * (`api/useMissionWrites.ts`). That is why a day count sits right on the
 * heading rather than nowhere — it is what makes "this affects four days"
 * visible *before* the button is pressed. The names behind it (its tooltip)
 * are the fold's own receipt: two unrelated posts that happen to share a word
 * show up here as one mission on days that make no sense together, and the
 * day names are how that becomes visible without reading every row.
 *
 * **The draft is re-seeded when the mission changes underneath it, unless it
 * is dirty.** A save invalidates the queries behind the page, so without the
 * re-seed the fields would keep showing what was typed rather than what was
 * stored, and a server that normalised the value would be invisible. With it
 * and without the dirty check, a background refetch would wipe what somebody
 * was halfway through typing.
 */
import { computed, ref, watch } from 'vue';

import {
  refusedDaysText,
  useDeleteMission,
  useUpdateMission,
  type FanOutOutcome,
} from '../api/useMissionWrites';
import ConfirmDialog from './ConfirmDialog.vue';
import { t, type AdminMessageKey } from '../i18n';
import InfoTooltip from './InfoTooltip.vue';
import {
  missionKind,
  volunteerBoundsLabel,
  type Mission,
} from '../plan/missionCatalog';
import {
  draftChanges,
  draftOf,
  missionProblem,
  type MissionDraft,
  type MissionProblem,
} from '../plan/missionDraft';

const props = defineProps<{
  readonly orgId: string;
  readonly mission: Mission;
  /** Every mission key on the page, this one included. Passed in rather than
   * recomputed here, because a duplicate is a property of the catalog and each
   * card would otherwise hold its own stale copy of it. */
  readonly takenKeys: readonly string[];
  /** How many days this page covers. `1` at event scope, which is what turns
   * the fan-out language off — "saved on 1 day" is noise. */
  readonly dayCount: number;
  /**
   * The posts folded under this mission, when it is a zone — empty for a
   * post, and empty for a zone with none declared yet. Only used to word the
   * delete confirmation: removing a zone cascades to every post nested under
   * it (and their shifts) via `ON DELETE CASCADE`, and that has to be said
   * before the button is pressed, not discovered afterwards (the incident
   * this page exists to stop happening again).
   */
  readonly nestedPosts?: readonly Mission[];
}>();

const emit = defineEmits<{ removed: [key: string] }>();

const draft = ref<MissionDraft>(draftOf(props.mission));

/** Compared against the stored mission rather than tracked as a boolean an
 * input handler has to remember to set. */
const pending = computed(
  () => draftChanges(props.mission, draft.value) !== null,
);

watch(
  () => props.mission,
  (mission) => {
    if (!pending.value) {
      draft.value = draftOf(mission);
    }
  },
);

const problem = computed(() =>
  missionProblem(draft.value, props.takenKeys, props.mission.key),
);

const PROBLEM_TEXT: Readonly<Record<MissionProblem, AdminMessageKey>> = {
  'name-missing': 'missions.problem.nameMissingMission',
  'name-taken': 'missions.problem.nameTakenOnPage',
  'coordinates-invalid': 'missions.problem.coordinatesInvalid',
  'volunteers-invalid': 'missions.problem.volunteersInvalid',
  'volunteers-order': 'missions.problem.volunteersOrder',
};

const update = useUpdateMission(() => props.orgId);
const remove = useDeleteMission(() => props.orgId);

/** What the last write was refused for, kept on screen rather than shown as a
 * toast — docs/02 §7. */
const refusal = ref<string | null>(null);
const saved = ref(false);
/** Drives `ConfirmDialog`'s `open`. */
const confirmingDelete = ref(false);
/** A removal's refusal, shown inside the dialog rather than in the form: the
 * form may be collapsed, and the dialog is where the coordinator is looking. */
const deleteRefusal = ref<string | null>(null);

/** A fan-out's refusals, as one message naming the days (`refusedDaysText`). */
function refusalText(
  outcome: FanOutOutcome,
  write: 'save' | 'remove',
): string | null {
  if (outcome.refusals.length === 0) {
    return null;
  }

  const days = refusedDaysText(outcome);
  if (outcome.applied === 0) {
    return write === 'save'
      ? t('missions.refusal.nothingSaved', { days })
      : t('missions.refusal.nothingRemoved', { days });
  }
  const counts = {
    applied: outcome.applied,
    total: outcome.applied + outcome.refusals.length,
    days,
  };
  return write === 'save'
    ? t('missions.refusal.savedPartly', counts)
    : t('missions.refusal.removedPartly', counts);
}

async function save(): Promise<void> {
  const changes = draftChanges(props.mission, draft.value);
  if (changes === null || problem.value !== null) {
    return;
  }
  refusal.value = null;
  saved.value = false;

  const outcome = await update.mutateAsync({
    placements: props.mission.placements,
    changes,
  });

  refusal.value = refusalText(outcome, 'save');
  saved.value = refusal.value === null;
}

function askToDelete(): void {
  deleteRefusal.value = null;
  confirmingDelete.value = true;
}

/** Closes the dialog only on a clean run. A partial one leaves it up with the
 * refused days named, and the card behind it re-reads with fewer days — the
 * coordinator can retry from there or cancel knowing exactly what is left. */
async function confirmDelete(): Promise<void> {
  deleteRefusal.value = null;
  const outcome = await remove.mutateAsync(props.mission.placements);

  deleteRefusal.value = refusalText(outcome, 'remove');
  if (deleteRefusal.value === null) {
    confirmingDelete.value = false;
    emit('removed', props.mission.key);
  }
}

/**
 * Taking over a field the days disagree about.
 *
 * Until this is pressed the field is `null` — "leave each day as it is" — and
 * the card shows what each day actually says. Pressing it turns the field into
 * one box whose value will be written to every day, which is a decision worth
 * making on purpose rather than by clicking into a textarea.
 */
function unifyDescription(): void {
  draft.value = { ...draft.value, description: '' };
}

function unifyAddress(): void {
  draft.value = { ...draft.value, address: '' };
}

function unifyExactAddress(): void {
  draft.value = { ...draft.value, exactAddress: '' };
}

function unifyCoordinates(): void {
  draft.value = { ...draft.value, coordinates: '' };
}

function unifyMinVolunteers(): void {
  draft.value = { ...draft.value, minVolunteers: '' };
}

function unifyMaxVolunteers(): void {
  draft.value = { ...draft.value, maxVolunteers: '' };
}

/**
 * A tick on a flag the days disagree about is the decision to unify it — the
 * same gesture the text fields' "use one value" buttons ask for, without the
 * extra press, because a checkbox has no empty state to land on first.
 */
function setCheckedByDefault(event: Event): void {
  if (event.target instanceof HTMLInputElement) {
    draft.value = { ...draft.value, checkedByDefault: event.target.checked };
  }
}

function setAdultsOnly(event: Event): void {
  if (event.target instanceof HTMLInputElement) {
    draft.value = { ...draft.value, adultsOnly: event.target.checked };
  }
}

/** Zones only: a post is reached through its zone, not by its own pin
 * (docs/03 §3.4, migration `…093312`). */
const isZone = computed(() => missionKind(props.mission) === 'zone');

/**
 * Whether the field form is on screen.
 *
 * Closed for every card, zones included. With every zone's form open, a
 * festival of a dozen zones was a dozen screens of text boxes, and the page's
 * actual question — what missions are there, and are they staffed and briefed
 * — could only be answered by scrolling through all of them. Closed, each
 * card is its name, its days and a one-line summary (`summary`, below), and
 * the form is one press on the heading away.
 */
const expanded = ref(false);

/**
 * What the collapsed card says about the mission in one line: the briefing's
 * start, where to stand, the volunteer bounds. Each piece is either what is
 * stored, "varies by day", or left out — except the briefing, whose absence is
 * itself worth seeing, since it is the thing volunteers will read.
 */
const briefingSummary = computed(() => {
  if (props.mission.descriptionVaries) {
    return { text: t('missions.card.summary.briefingVaries'), missing: false };
  }
  return props.mission.description === null
    ? { text: t('missions.card.summary.noBriefing'), missing: true }
    : { text: props.mission.description, missing: false };
});

const addressSummary = computed(() =>
  props.mission.addressVaries
    ? t('missions.card.summary.addressVaries')
    : props.mission.address,
);

const volunteersSummary = computed(() => volunteerBoundsLabel(props.mission));

/**
 * How the volunteer form will offer the mission, but only where it departs
 * from the ordinary pre-ticked, open-to-all case: a dozen cards each saying
 * "ticked, all ages" would bury the two that are not.
 */
const formFlagsSummary = computed(() => {
  const mission = props.mission;
  const flags: string[] = [];
  if (mission.adultsOnlyVaries) {
    flags.push(t('missions.card.summary.adultsOnlyVaries'));
  } else if (mission.adultsOnly === true) {
    flags.push(t('missions.card.summary.adultsOnly'));
  }
  if (mission.checkedByDefaultVaries) {
    flags.push(t('missions.card.summary.optInVaries'));
  } else if (mission.checkedByDefault === false) {
    flags.push(t('missions.card.summary.optIn'));
  }
  return flags;
});

/**
 * Ids are per-mission because a dozen of these render at once and a duplicated
 * `for`/`id` pair points every label at the first card.
 *
 * Keyed on a row id rather than on `mission.key`, which is a name a
 * coordinator typed: "Bar & grill" would produce an `id` with a space in it,
 * and `getElementById`-shaped selectors would stop finding the field it
 * labels. The first placement is stable for as long as the card exists.
 */
const idBase = computed(
  () => props.mission.placements[0]?.locationId ?? props.mission.key,
);
const fieldId = (name: string): string => `evp-mission-${idBase.value}-${name}`;

/** The days this mission runs on, and — at festival scope — the ones it does
 * not. Both are the fan-out's reach stated before it happens. */
const dayNames = computed(() =>
  props.mission.placements.map((placement) => placement.eventName),
);

const busy = computed(() => update.isPending.value || remove.isPending.value);

/** Unsaved edits survive a collapse — the draft lives here, not in the form —
 * so the collapsed card has to say they are there, or they are lost the day
 * somebody reloads the page assuming there was nothing to lose. */
const unsavedWhileCollapsed = computed(() => !expanded.value && pending.value);

const kind = computed(() => missionKind(props.mission));

/** "Zone" or "Post", so the two levels of the tree read as different things
 * even when they are laid out identically — the incident this page exists to
 * stop happening again started with a card that gave no sign it would take
 * others down with it. */
const kindLabel = computed(() =>
  kind.value === 'zone' ? t('missions.kind.zone') : t('missions.kind.post'),
);

const confirmLabel = computed(() =>
  kind.value === 'zone'
    ? t('missions.card.deleteConfirm.confirmZone')
    : t('missions.card.deleteConfirm.confirmPost'),
);

/** What removing this row actually takes with it, named rather than implied —
 * a zone's cascade reaches every post folded under it here, a post's reaches
 * nothing but its own shifts. */
const confirmText = computed(() => {
  const posts = props.nestedPosts ?? [];
  const subject = {
    kind: kind.value,
    name: props.mission.name,
    days: dayNames.value.join(', '),
  };
  if (posts.length === 0) {
    return t('missions.card.deleteConfirm.body', subject);
  }
  return t('missions.card.deleteConfirm.bodyWithPosts', {
    ...subject,
    count: posts.length,
    names: posts.map((post) => post.name).join(', '),
  });
});
</script>

<template>
  <section
    class="evp-panel evp-mission"
    :class="{ 'evp-mission--open': expanded }"
    :aria-labelledby="fieldId('heading')"
  >
    <div class="evp-mission-row">
      <h3 :id="fieldId('heading')" class="evp-mission-heading">
        <!-- The name is the disclosure: the biggest target on the card, and
             the thing a coordinator reaches for to "open the bar". A heading
             wrapping a button (not the reverse) keeps the heading in the
             document outline while the button carries `aria-expanded`. -->
        <button
          type="button"
          class="evp-mission-toggle"
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
          <span class="evp-mission-name">{{ mission.name }}</span>
        </button>
        <span class="evp-tag evp-tag--kind">{{ kindLabel }}</span>
        <!-- A zone's card has the room for the days at full size, and it is
             the level a coordinator reads to decide "does this belong on
             every day of the festival?" — worth showing without a hover. A
             post stays compact, so the same information is a count with the
             names behind a tooltip instead. -->
        <span v-if="isZone" class="evp-days">
          <span v-for="day in dayNames" :key="day" class="evp-day">{{
            day
          }}</span>
        </span>
        <span v-else class="evp-days">
          <InfoTooltip
            v-if="dayNames.length > 1"
            :text="dayNames.join(', ')"
            :tooltip-id="fieldId('days')"
            :label="
              t('missions.card.runsOnDays', {
                count: dayNames.length,
                days: dayNames.join(', '),
              })
            "
          >
            {{ t('missions.card.dayCount', { count: dayNames.length }) }}
          </InfoTooltip>
          <span v-else-if="dayNames.length === 1" class="evp-tag">{{
            dayNames[0]
          }}</span>
        </span>
        <span v-if="unsavedWhileCollapsed" class="evp-tag evp-tag--unsaved">
          {{ t('missions.card.unsaved') }}
        </span>
      </h3>

      <div class="evp-mission-row-actions">
        <button
          type="button"
          class="evp-icon-button evp-icon-button--danger"
          :disabled="busy"
          :aria-label="t('missions.card.remove', { name: mission.name })"
          :title="t('missions.card.remove', { name: mission.name })"
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

    <!-- The condensed reading. Hidden once the form is open, where every one
         of these is a field of its own and saying it twice is noise. -->
    <p v-if="!expanded" class="evp-summary">
      <span
        class="evp-summary-briefing"
        :class="{ 'evp-summary-missing': briefingSummary.missing }"
        >{{ briefingSummary.text }}</span
      >
      <span v-if="addressSummary !== null" class="evp-summary-item">{{
        addressSummary
      }}</span>
      <span v-if="volunteersSummary !== null" class="evp-summary-item">{{
        volunteersSummary
      }}</span>
      <span
        v-for="flag in formFlagsSummary"
        :key="flag"
        class="evp-summary-item evp-summary-flag"
        >{{ flag }}</span
      >
    </p>

    <p v-if="mission.missingFrom.length > 0" class="evp-hint">
      {{
        t('missions.card.notDeclaredOn', {
          missing: mission.missingFrom.map((day) => day.eventName).join(', '),
          days: dayNames.join(', '),
        })
      }}
    </p>

    <form
      v-if="expanded"
      :id="fieldId('form')"
      novalidate
      @submit.prevent="save"
    >
      <p class="evp-field">
        <label :for="fieldId('name')">
          <span>{{ t('missions.fields.name') }}</span>
          <input
            :id="fieldId('name')"
            v-model="draft.name"
            type="text"
            :aria-invalid="problem !== null"
            :aria-describedby="
              problem === null ? undefined : fieldId('problem')
            "
          />
        </label>
      </p>

      <p class="evp-field">
        <label :for="fieldId('description')">
          <span
            >{{ t('missions.fields.description') }}
            <InfoTooltip
              :text="t('missions.fields.descriptionHelp')"
              :tooltip-id="fieldId('description-help')"
          /></span>
          <textarea
            v-if="draft.description !== null"
            :id="fieldId('description')"
            v-model="draft.description"
            rows="3"
          />
        </label>
        <!-- Outside the label, because it is not a control for the field: it
             is the decision to *have* one field instead of N. -->
        <template v-if="draft.description === null">
          <ul class="evp-varies">
            <li
              v-for="placement in mission.placements"
              :key="placement.locationId"
            >
              <strong>{{ placement.eventName }}:</strong>
              {{ placement.description ?? t('missions.card.nothingSaid') }}
            </li>
          </ul>
          <button
            type="button"
            class="evp-button evp-button--quiet"
            @click="unifyDescription"
          >
            {{ t('missions.card.unifyDescription') }}
          </button>
        </template>
      </p>

      <p class="evp-field">
        <label :for="fieldId('address')">
          <span
            >{{ t('missions.fields.address') }}
            <InfoTooltip
              :text="t('missions.fields.addressHelp')"
              :tooltip-id="fieldId('address-help')"
          /></span>
          <input
            v-if="draft.address !== null"
            :id="fieldId('address')"
            v-model="draft.address"
            type="text"
          />
        </label>
        <template v-if="draft.address === null">
          <ul class="evp-varies">
            <li
              v-for="placement in mission.placements"
              :key="placement.locationId"
            >
              <strong>{{ placement.eventName }}:</strong>
              {{ placement.address ?? t('missions.card.nothingSaid') }}
            </li>
          </ul>
          <button
            type="button"
            class="evp-button evp-button--quiet"
            @click="unifyAddress"
          >
            {{ t('missions.card.unifyAddress') }}
          </button>
        </template>
      </p>

      <!-- Both levels of the tree are staffed, so both carry bounds. A
           fieldset rather than two loose fields: "Minimum" alone does not say
           of what, and the legend is what gives it that. -->
      <fieldset class="evp-field evp-volunteers">
        <legend>
          {{ t('missions.fields.volunteers') }}
          <InfoTooltip
            :text="t('missions.fields.volunteersHelp')"
            :tooltip-id="fieldId('volunteers-help')"
          />
        </legend>

        <div class="evp-volunteers-pair">
          <p class="evp-volunteers-bound">
            <label :for="fieldId('min-volunteers')">
              <span>{{ t('missions.fields.minimum') }}</span>
              <!-- Text with a numeric keypad rather than type="number": a
                   number input swallows a stray letter into an empty value,
                   so "1O" would silently read as "no bound", and a scroll
                   wheel over it changes the count by accident. -->
              <input
                v-if="draft.minVolunteers !== null"
                :id="fieldId('min-volunteers')"
                v-model="draft.minVolunteers"
                type="text"
                inputmode="numeric"
                autocomplete="off"
                :placeholder="t('missions.fields.noMinimum')"
                :aria-invalid="
                  problem === 'volunteers-invalid' ||
                  problem === 'volunteers-order'
                "
              />
            </label>
            <template v-if="draft.minVolunteers === null">
              <ul class="evp-varies">
                <li
                  v-for="placement in mission.placements"
                  :key="placement.locationId"
                >
                  <strong>{{ placement.eventName }}:</strong>
                  {{ placement.minVolunteers ?? t('missions.card.noBound') }}
                </li>
              </ul>
              <button
                type="button"
                class="evp-button evp-button--quiet"
                @click="unifyMinVolunteers"
              >
                {{ t('missions.card.unifyMinimum') }}
              </button>
            </template>
          </p>

          <p class="evp-volunteers-bound">
            <label :for="fieldId('max-volunteers')">
              <span>{{ t('missions.fields.maximum') }}</span>
              <input
                v-if="draft.maxVolunteers !== null"
                :id="fieldId('max-volunteers')"
                v-model="draft.maxVolunteers"
                type="text"
                inputmode="numeric"
                autocomplete="off"
                :placeholder="t('missions.fields.noMaximum')"
                :aria-invalid="
                  problem === 'volunteers-invalid' ||
                  problem === 'volunteers-order'
                "
              />
            </label>
            <template v-if="draft.maxVolunteers === null">
              <ul class="evp-varies">
                <li
                  v-for="placement in mission.placements"
                  :key="placement.locationId"
                >
                  <strong>{{ placement.eventName }}:</strong>
                  {{ placement.maxVolunteers ?? t('missions.card.noBound') }}
                </li>
              </ul>
              <button
                type="button"
                class="evp-button evp-button--quiet"
                @click="unifyMaxVolunteers"
              >
                {{ t('missions.card.unifyMaximum') }}
              </button>
            </template>
          </p>
        </div>
      </fieldset>

      <template v-if="isZone">
        <p class="evp-field">
          <label :for="fieldId('exact-address')">
            <span
              >{{ t('missions.fields.exactAddress') }}
              <InfoTooltip
                :text="t('missions.fields.exactAddressHelp')"
                :tooltip-id="fieldId('exact-address-help')"
            /></span>
            <input
              v-if="draft.exactAddress !== null"
              :id="fieldId('exact-address')"
              v-model="draft.exactAddress"
              type="text"
            />
          </label>
          <template v-if="draft.exactAddress === null">
            <ul class="evp-varies">
              <li
                v-for="placement in mission.placements"
                :key="placement.locationId"
              >
                <strong>{{ placement.eventName }}:</strong>
                {{ placement.exactAddress ?? t('missions.card.nothingSaid') }}
              </li>
            </ul>
            <button
              type="button"
              class="evp-button evp-button--quiet"
              @click="unifyExactAddress"
            >
              {{ t('missions.card.unifyExactAddress') }}
            </button>
          </template>
        </p>

        <p class="evp-field">
          <label :for="fieldId('coordinates')">
            <span
              >{{ t('missions.fields.coordinates') }}
              <InfoTooltip
                :text="t('missions.fields.coordinatesHelp')"
                :tooltip-id="fieldId('coordinates-help')"
            /></span>
            <input
              v-if="draft.coordinates !== null"
              :id="fieldId('coordinates')"
              v-model="draft.coordinates"
              type="text"
              :placeholder="t('missions.fields.coordinatesPlaceholder')"
              :aria-invalid="problem === 'coordinates-invalid'"
            />
          </label>
          <template v-if="draft.coordinates === null">
            <ul class="evp-varies">
              <li
                v-for="placement in mission.placements"
                :key="placement.locationId"
              >
                <strong>{{ placement.eventName }}:</strong>
                {{ placement.coordinates ?? t('missions.card.nothingSaid') }}
              </li>
            </ul>
            <button
              type="button"
              class="evp-button evp-button--quiet"
              @click="unifyCoordinates"
            >
              {{ t('missions.card.unifyCoordinates') }}
            </button>
          </template>
        </p>

        <!-- Not `evp-field`: its global rule stretches every input to the
             full width and a text box's height, which is wrong for a tick. -->
        <div class="evp-flag">
          <label :for="fieldId('checked-by-default')" class="evp-check">
            <input
              :id="fieldId('checked-by-default')"
              type="checkbox"
              :checked="draft.checkedByDefault === true"
              :indeterminate="draft.checkedByDefault === null"
              :aria-describedby="fieldId('checked-by-default-hint')"
              @change="setCheckedByDefault"
            />
            <span>{{ t('missions.fields.checkedByDefault') }}</span>
          </label>
          <p :id="fieldId('checked-by-default-hint')" class="evp-hint">
            {{ t('missions.fields.checkedByDefaultHint') }}
          </p>
          <template v-if="draft.checkedByDefault === null">
            <ul class="evp-varies">
              <li
                v-for="placement in mission.placements"
                :key="placement.locationId"
              >
                <strong>{{ placement.eventName }}:</strong>
                {{
                  placement.checkedByDefault === true
                    ? t('missions.card.flagOn')
                    : t('missions.card.flagOff')
                }}
              </li>
            </ul>
            <p class="evp-hint">{{ t('missions.card.unifyFlag') }}</p>
          </template>
        </div>

        <div class="evp-flag">
          <label :for="fieldId('adults-only')" class="evp-check">
            <input
              :id="fieldId('adults-only')"
              type="checkbox"
              :checked="draft.adultsOnly === true"
              :indeterminate="draft.adultsOnly === null"
              :aria-describedby="fieldId('adults-only-hint')"
              @change="setAdultsOnly"
            />
            <span>{{ t('missions.fields.adultsOnly') }}</span>
          </label>
          <p :id="fieldId('adults-only-hint')" class="evp-hint">
            {{ t('missions.fields.adultsOnlyHint') }}
          </p>
          <template v-if="draft.adultsOnly === null">
            <ul class="evp-varies">
              <li
                v-for="placement in mission.placements"
                :key="placement.locationId"
              >
                <strong>{{ placement.eventName }}:</strong>
                {{
                  placement.adultsOnly === true
                    ? t('missions.card.flagOn')
                    : t('missions.card.flagOff')
                }}
              </li>
            </ul>
            <p class="evp-hint">{{ t('missions.card.unifyFlag') }}</p>
          </template>
        </div>
      </template>

      <p
        v-if="problem !== null"
        :id="fieldId('problem')"
        class="evp-error"
        role="alert"
      >
        {{ t(PROBLEM_TEXT[problem]) }}
      </p>
      <p v-else-if="refusal !== null" class="evp-error" role="alert">
        {{ refusal }}
      </p>
      <p v-else-if="saved && !pending" class="evp-saved" role="status">
        {{
          dayCount > 1
            ? t('missions.card.savedOnDays', { count: dayNames.length })
            : t('missions.card.saved')
        }}
      </p>

      <div class="evp-actions">
        <button
          type="submit"
          class="evp-button evp-button--primary"
          :disabled="!pending || problem !== null || busy"
        >
          {{
            update.isPending.value
              ? t('common.status.saving')
              : t('missions.card.saveChanges')
          }}
        </button>
      </div>
    </form>

    <!-- Says what goes with it, because the cascade is not obvious and is
         not reversible: removing a mission takes its shifts on every day it
         runs on, and any posts under it. -->
    <ConfirmDialog
      :open="confirmingDelete"
      :title="t('missions.card.deleteConfirm.title', { name: mission.name })"
      :confirm-label="confirmLabel"
      :busy-label="t('missions.card.deleteConfirm.busy')"
      :busy="remove.isPending.value"
      :error="deleteRefusal"
      @confirm="confirmDelete"
      @cancel="confirmingDelete = false"
    >
      <p class="evp-confirm">{{ confirmText }}</p>
      <p>
        <strong>{{ t('missions.card.deleteConfirm.irreversible') }}</strong>
      </p>
    </ConfirmDialog>
  </section>
</template>

<style scoped>
.evp-mission {
  margin-bottom: 1rem;
  /* The section inherits the board's full-window layout so the rail does not
     move between sections (`router/index.ts`); a briefing read at 1800 px is
     a briefing nobody reads. */
  max-width: 44rem;
}

/* One line by default: the heading and its actions share a row, and the
   heading itself only wraps when a long name plus every tag genuinely does
   not fit — the common case (a name, a kind, a day count) stays one line. */
.evp-mission-row {
  align-items: center;
  display: flex;
  gap: 0.5rem;
  justify-content: space-between;
  margin: 0 0 0.375rem;
}

.evp-mission-heading {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  font-size: 1.0625rem;
  gap: 0.5rem;
  margin: 0;
  min-width: 0;
}

.evp-mission-row-actions {
  display: flex;
  flex-shrink: 0;
  gap: 0.25rem;
}

.evp-icon-button {
  align-items: center;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 0.375rem;
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

.evp-tag {
  border: 1px solid var(--evp-border);
  border-radius: 999px;
  color: var(--evp-text-muted);
  font-size: 0.8125rem;
  font-weight: 400;
  padding: 0.0625rem 0.5rem;
}

/* The one label that says which level of the tree this card is — deletion
   safety depends on a coordinator noticing it before pressing Remove. */
.evp-tag--kind {
  background: color-mix(in srgb, var(--evp-accent) 12%, var(--evp-surface));
  border-color: transparent;
  color: var(--evp-accent);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.evp-days {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 0.375rem;
  max-width: 100%;
}

.evp-day {
  background: color-mix(in srgb, var(--evp-accent) 10%, var(--evp-surface));
  border-radius: 0.25rem;
  font-size: 0.8125rem;
  padding: 0.0625rem 0.375rem;
}

.evp-hint {
  color: var(--evp-text-muted);
  font-size: 0.875rem;
  font-weight: 400;
  margin: 0 0 0.5rem;
  max-width: 60ch;
}

.evp-field textarea {
  background: var(--evp-surface);
  border: 1px solid var(--evp-border);
  border-radius: 0.375rem;
  color: var(--evp-text);
  font: inherit;
  padding: 0.5rem 0.75rem;
  resize: vertical;
  width: 100%;
}

/* What each day says, when they do not agree. A list rather than a sentence:
   six days of differing addresses read as six lines and not as one paragraph
   with semicolons in it. */
.evp-varies {
  border-left: 3px solid var(--evp-warning);
  font-size: 0.875rem;
  list-style: none;
  margin: 0 0 0.5rem;
  padding: 0 0 0 0.75rem;
}

.evp-varies li + li {
  margin-top: 0.25rem;
}

.evp-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.evp-error {
  color: var(--evp-danger);
  margin: 0 0 0.75rem;
}

.evp-saved {
  color: var(--evp-success);
  margin: 0 0 0.75rem;
}

.evp-confirm {
  margin: 0 0 0.75rem;
}

/* ── The disclosure ───────────────────────────────────────────────────────── */

/* Looks like the heading it sits in, not like a button: the name is still the
   thing being read, and a boxed name on every card would be a wall of
   buttons. The hover/focus treatment is what says it can be pressed. */
.evp-mission-toggle {
  align-items: center;
  background: none;
  border: 0;
  border-radius: 0.25rem;
  color: inherit;
  cursor: pointer;
  display: inline-flex;
  font: inherit;
  gap: 0.25rem;
  margin: 0 0 0 -0.25rem;
  min-height: 2rem;
  padding: 0 0.25rem;
  text-align: left;
}

.evp-mission-toggle:hover .evp-mission-name {
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

.evp-mission--open .evp-chevron {
  transform: rotate(90deg);
}

@media (prefers-reduced-motion: reduce) {
  .evp-chevron {
    transition: none;
  }
}

.evp-tag--unsaved {
  border-color: var(--evp-warning);
  color: var(--evp-text);
}

/* One line, lined up under the name rather than the chevron, and cut with an
   ellipsis rather than wrapped: the collapsed card's whole point is a
   predictable height. The full text is one press away. */
.evp-summary {
  color: var(--evp-text-muted);
  display: flex;
  font-size: 0.875rem;
  gap: 0.75rem;
  margin: 0 0 0 1.625rem;
  min-width: 0;
}

.evp-summary-briefing {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.evp-summary-missing {
  font-style: italic;
}

.evp-summary-item {
  flex-shrink: 0;
  white-space: nowrap;
}

.evp-summary-item::before {
  content: '·';
  margin-right: 0.75rem;
}

.evp-mission form {
  margin-top: 0.75rem;
}

/* The departures from the ordinary mission — 18+, opt-in — are the ones a
   coordinator scans for, so they read as text rather than muted. */
.evp-summary-flag {
  color: var(--evp-text);
  font-weight: 500;
}

/* ── Form flags ───────────────────────────────────────────────────────────── */

.evp-flag {
  margin: 0 0 0.5rem;
}

.evp-check {
  align-items: center;
  display: inline-flex;
  font-weight: 500;
  gap: 0.5rem;
  min-height: 2rem;
}

.evp-check input {
  height: 1.125rem;
  width: 1.125rem;
}

/* Under the label text, not under the box. */
.evp-flag .evp-hint,
.evp-flag .evp-varies {
  margin-left: 1.625rem;
}

/* ── Volunteer bounds ─────────────────────────────────────────────────────── */

.evp-volunteers {
  border: 0;
  margin: 0 0 1rem;
  min-width: 0;
  padding: 0;
}

.evp-volunteers legend {
  font-weight: 500;
  margin-bottom: 0.25rem;
  padding: 0;
}

.evp-volunteers-pair {
  display: grid;
  gap: 0.75rem;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  max-width: 24rem;
}

.evp-volunteers-bound {
  margin: 0;
}

.evp-volunteers-bound label > span {
  color: var(--evp-text-muted);
  display: block;
  font-size: 0.875rem;
  margin-bottom: 0.25rem;
}

.evp-volunteers-bound input {
  background: var(--evp-surface);
  border: 1px solid var(--evp-border);
  border-radius: 0.375rem;
  color: var(--evp-text);
  font: inherit;
  min-height: 2.75rem;
  padding: 0.5rem 0.75rem;
  width: 100%;
}

.evp-volunteers-bound input[aria-invalid='true'] {
  border-color: var(--evp-danger);
}
</style>
