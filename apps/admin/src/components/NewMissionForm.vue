<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * Declaring a mission.
 *
 * Behind a disclosure rather than always open, because the common visit to
 * this page is reading and correcting what is already there — a festival
 * declares its missions once and edits them for weeks — and an open form above
 * a dozen cards pushes all of them below the fold.
 *
 * **It says how many days it will write to, in the button.** At festival scope
 * this one submit is N `POST`s (`api/useMissionWrites.ts`), which is the
 * behaviour a coordinator wants and exactly the kind of thing that is
 * infuriating to discover afterwards. At event scope the count is 1 and the
 * sentence goes away.
 *
 * The duplicate check runs here rather than only at the server: a name that is
 * already taken would otherwise come back as one `409` per day, five of which
 * say nothing the first did not.
 */
import { computed, ref } from 'vue';

import {
  refusedDaysText,
  useCreateMission,
  type FanOutOutcome,
} from '../api/useMissionWrites';
import InfoTooltip from './InfoTooltip.vue';
import { t, type AdminMessageKey } from '../i18n';
import type { DayRef } from '../plan/missionCatalog';
import {
  emptyDraft,
  missionProblem,
  newMissionInput,
  type MissionProblem,
  type NewMissionDraft,
} from '../plan/missionDraft';

const props = defineProps<{
  readonly orgId: string;
  /** The days the new mission is declared on — every day this page covers. */
  readonly days: readonly DayRef[];
  readonly takenKeys: readonly string[];
}>();

const open = ref(false);
const draft = ref<NewMissionDraft>(emptyDraft());
const refusal = ref<string | null>(null);
const created = ref<string | null>(null);

const create = useCreateMission(() => props.orgId);

const problem = computed(() => missionProblem(draft.value, props.takenKeys));

const PROBLEM_TEXT: Readonly<Record<MissionProblem, AdminMessageKey>> = {
  'name-missing': 'missions.problem.nameMissingMission',
  'name-taken': 'missions.problem.nameTakenInProduction',
  'coordinates-invalid': 'missions.problem.coordinatesInvalid',
  'volunteers-invalid': 'missions.problem.volunteersInvalid',
  'volunteers-order': 'missions.problem.volunteersOrder',
};

/** Empty until somebody types, so the form does not open onto a red field. */
const touched = ref(false);
const shownProblem = computed(() => (touched.value ? problem.value : null));

function refusalText(outcome: FanOutOutcome): string | null {
  if (outcome.refusals.length === 0) {
    return null;
  }

  const days = refusedDaysText(outcome);
  return outcome.applied === 0
    ? t('missions.refusal.missionNotCreated', { days })
    : t('missions.refusal.createdPartly', {
        applied: outcome.applied,
        total: props.days.length,
        days,
      });
}

async function submit(): Promise<void> {
  touched.value = true;
  if (problem.value !== null) {
    return;
  }
  refusal.value = null;
  created.value = null;

  const input = newMissionInput(draft.value);
  const outcome = await create.mutateAsync({ ...input, days: props.days });

  refusal.value = refusalText(outcome);
  if (refusal.value !== null) {
    return;
  }

  created.value = input.name;
  // Cleared rather than closed: declaring the missions of a new festival is a
  // dozen of these in a row, and a form that shuts after each one makes that a
  // dozen extra clicks.
  draft.value = emptyDraft();
  touched.value = false;
}

function cancel(): void {
  open.value = false;
  draft.value = emptyDraft();
  touched.value = false;
  refusal.value = null;
  created.value = null;
}
</script>

<template>
  <section class="evp-add">
    <button
      v-if="!open"
      type="button"
      class="evp-button evp-button--primary"
      @click="open = true"
    >
      {{ t('missions.newZone.open') }}
    </button>

    <form v-else class="evp-panel" novalidate @submit.prevent="submit">
      <h3 class="evp-add-heading">
        {{ t('missions.newZone.heading') }}
        <InfoTooltip
          :text="t('missions.newZone.headingHelp')"
          tooltip-id="evp-new-mission-heading-help"
        />
      </h3>
      <p v-if="days.length > 1" class="evp-hint">
        {{ t('missions.newZone.allDays', { count: days.length }) }}
      </p>

      <p class="evp-field">
        <label for="evp-new-mission-name">
          <span>{{ t('missions.fields.name') }}</span>
          <input
            id="evp-new-mission-name"
            v-model="draft.name"
            type="text"
            :aria-invalid="shownProblem !== null"
            :aria-describedby="
              shownProblem === null ? undefined : 'evp-new-mission-problem'
            "
            @input="touched = true"
          />
        </label>
      </p>

      <p class="evp-field">
        <label for="evp-new-mission-description">
          <span
            >{{ t('missions.fields.description') }}
            <InfoTooltip
              :text="t('missions.fields.descriptionHelpNew')"
              tooltip-id="evp-new-mission-description-help"
          /></span>
          <textarea
            id="evp-new-mission-description"
            v-model="draft.description"
            rows="3"
          />
        </label>
      </p>

      <p class="evp-field">
        <label for="evp-new-mission-address">
          <span>{{ t('missions.fields.address') }}</span>
          <input
            id="evp-new-mission-address"
            v-model="draft.address"
            type="text"
          />
        </label>
      </p>

      <fieldset class="evp-field evp-volunteers">
        <legend>
          {{ t('missions.fields.volunteers') }}
          <InfoTooltip
            :text="t('missions.fields.volunteersHelp')"
            tooltip-id="evp-new-mission-volunteers-help"
          />
        </legend>
        <div class="evp-volunteers-pair">
          <p class="evp-volunteers-bound">
            <label for="evp-new-mission-min-volunteers">
              <span>{{ t('missions.fields.minimum') }}</span>
              <input
                id="evp-new-mission-min-volunteers"
                v-model="draft.minVolunteers"
                type="text"
                inputmode="numeric"
                autocomplete="off"
                :placeholder="t('missions.fields.noMinimum')"
                :aria-invalid="
                  shownProblem === 'volunteers-invalid' ||
                  shownProblem === 'volunteers-order'
                "
              />
            </label>
          </p>
          <p class="evp-volunteers-bound">
            <label for="evp-new-mission-max-volunteers">
              <span>{{ t('missions.fields.maximum') }}</span>
              <input
                id="evp-new-mission-max-volunteers"
                v-model="draft.maxVolunteers"
                type="text"
                inputmode="numeric"
                autocomplete="off"
                :placeholder="t('missions.fields.noMaximum')"
                :aria-invalid="
                  shownProblem === 'volunteers-invalid' ||
                  shownProblem === 'volunteers-order'
                "
              />
            </label>
          </p>
        </div>
      </fieldset>

      <p class="evp-field">
        <label for="evp-new-mission-exact-address">
          <span
            >{{ t('missions.fields.exactAddress') }}
            <InfoTooltip
              :text="t('missions.fields.exactAddressHelp')"
              tooltip-id="evp-new-mission-exact-address-help"
          /></span>
          <input
            id="evp-new-mission-exact-address"
            v-model="draft.exactAddress"
            type="text"
          />
        </label>
      </p>

      <p class="evp-field">
        <label for="evp-new-mission-coordinates">
          <span
            >{{ t('missions.fields.coordinates') }}
            <InfoTooltip
              :text="t('missions.fields.coordinatesHelp')"
              tooltip-id="evp-new-mission-coordinates-help"
          /></span>
          <input
            id="evp-new-mission-coordinates"
            v-model="draft.coordinates"
            type="text"
            :placeholder="t('missions.fields.coordinatesPlaceholder')"
            :aria-invalid="shownProblem === 'coordinates-invalid'"
          />
        </label>
      </p>

      <!-- Not `evp-field`: its global rule stretches every input to the full
           width and a text box's height, which is right for a box and wrong
           for a tick. -->
      <div class="evp-flag">
        <label for="evp-new-mission-checked-by-default" class="evp-check">
          <input
            id="evp-new-mission-checked-by-default"
            v-model="draft.checkedByDefault"
            type="checkbox"
            aria-describedby="evp-new-mission-checked-by-default-hint"
          />
          <span>{{ t('missions.fields.checkedByDefault') }}</span>
        </label>
        <p id="evp-new-mission-checked-by-default-hint" class="evp-hint">
          {{ t('missions.fields.checkedByDefaultHint') }}
        </p>
      </div>

      <div class="evp-flag">
        <label for="evp-new-mission-adults-only" class="evp-check">
          <input
            id="evp-new-mission-adults-only"
            v-model="draft.adultsOnly"
            type="checkbox"
            aria-describedby="evp-new-mission-adults-only-hint"
          />
          <span>{{ t('missions.fields.adultsOnly') }}</span>
        </label>
        <p id="evp-new-mission-adults-only-hint" class="evp-hint">
          {{ t('missions.fields.adultsOnlyHint') }}
        </p>
      </div>

      <p
        v-if="shownProblem !== null"
        id="evp-new-mission-problem"
        class="evp-error"
        role="alert"
      >
        {{ t(PROBLEM_TEXT[shownProblem]) }}
      </p>
      <p v-else-if="refusal !== null" class="evp-error" role="alert">
        {{ refusal }}
      </p>
      <p v-else-if="created !== null" class="evp-saved" role="status">
        {{
          days.length > 1
            ? t('missions.newZone.addedToAllDays', {
                name: created,
                count: days.length,
              })
            : t('missions.newZone.added', { name: created })
        }}
      </p>

      <div class="evp-actions">
        <button
          type="submit"
          class="evp-button evp-button--primary"
          :disabled="create.isPending.value"
        >
          {{
            create.isPending.value
              ? t('missions.newZone.adding')
              : t('missions.newZone.submit')
          }}
        </button>
        <button
          type="button"
          class="evp-button"
          :disabled="create.isPending.value"
          @click="cancel"
        >
          {{ t('missions.newZone.done') }}
        </button>
      </div>
    </form>
  </section>
</template>

<style scoped>
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

/* The hint sits under the label text, not under the box. */
.evp-flag .evp-hint {
  margin-left: 1.625rem;
}

.evp-add {
  margin-bottom: 1.5rem;
  max-width: 44rem;
}

.evp-add-heading {
  font-size: 1.0625rem;
  margin: 0 0 0.5rem;
}

.evp-hint {
  color: var(--evp-text-muted);
  font-size: 0.875rem;
  font-weight: 400;
  margin: 0 0 0.75rem;
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
</style>
