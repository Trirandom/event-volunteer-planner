<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * Declaring a post nested under a zone.
 *
 * `NewMissionForm.vue`'s sibling for the other level of the tree: a zone is a
 * physical area a coordinator names outright, a post is a specific job
 * *inside* one they are already looking at, so this form never asks which
 * zone — it is the one the card it lives under is for — and it fans out over
 * that zone's own placements rather than every day in scope (a day the zone
 * does not run on has no row for the post to be filed under).
 *
 * Behind a disclosure for the same reason `NewMissionForm.vue` is: a zone with
 * a dozen posts already declared should not open onto a dozen collapsed
 * fields plus one open one.
 */
import { computed, ref } from 'vue';

import {
  refusedDaysText,
  useCreatePost,
  type FanOutOutcome,
} from '../api/useMissionWrites';
import InfoTooltip from './InfoTooltip.vue';
import { t, type AdminMessageKey } from '../i18n';
import type { Mission } from '../plan/missionCatalog';
import {
  emptyDraft,
  missionProblem,
  newMissionInput,
  type MissionProblem,
  type NewMissionDraft,
} from '../plan/missionDraft';

const props = defineProps<{
  readonly orgId: string;
  /** The zone this post will be filed under. */
  readonly zone: Mission;
  /** Every mission key on the page — the same global check
   * `NewMissionForm.vue` runs, because the fold is by name across the whole
   * festival and a post named the same as some unrelated zone would fold
   * into it. */
  readonly takenKeys: readonly string[];
}>();

const open = ref(false);
const draft = ref<NewMissionDraft>(emptyDraft());
const refusal = ref<string | null>(null);
const created = ref<string | null>(null);

const create = useCreatePost(() => props.orgId);

const problem = computed(() => missionProblem(draft.value, props.takenKeys));

const PROBLEM_TEXT: Readonly<Record<MissionProblem, AdminMessageKey>> = {
  'name-missing': 'missions.problem.nameMissingPost',
  'name-taken': 'missions.problem.nameTakenInProduction',
  // Unreachable here: this form never shows a coordinates field (a post has
  // no map fields of its own, docs/03 §3.4) so `draft.coordinates` is always
  // empty. Kept for exhaustiveness against `MissionProblem`.
  'coordinates-invalid': 'missions.problem.coordinatesInvalidShort',
  'volunteers-invalid': 'missions.problem.volunteersInvalid',
  'volunteers-order': 'missions.problem.volunteersOrder',
};

const touched = ref(false);
const shownProblem = computed(() => (touched.value ? problem.value : null));

const dayCount = computed(() => props.zone.placements.length);

/** Ids per zone, for the same reason `MissionCard.vue`'s are per mission: a
 * dozen of these render at once. */
const idBase = computed(
  () => props.zone.placements[0]?.locationId ?? props.zone.key,
);
const fieldId = (name: string): string =>
  `evp-new-post-${idBase.value}-${name}`;

function refusalText(outcome: FanOutOutcome): string | null {
  if (outcome.refusals.length === 0) {
    return null;
  }

  const days = refusedDaysText(outcome);
  return outcome.applied === 0
    ? t('missions.refusal.postNotCreated', { days })
    : t('missions.refusal.createdPartly', {
        applied: outcome.applied,
        total: dayCount.value,
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
  const outcome = await create.mutateAsync({
    ...input,
    zonePlacements: props.zone.placements,
  });

  refusal.value = refusalText(outcome);
  if (refusal.value !== null) {
    return;
  }

  created.value = input.name;
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
  <section class="evp-add-post">
    <button
      v-if="!open"
      type="button"
      class="evp-button evp-button--quiet"
      @click="open = true"
    >
      {{ t('missions.newPost.open', { zone: zone.name }) }}
    </button>

    <form v-else class="evp-panel" novalidate @submit.prevent="submit">
      <h4 class="evp-add-heading">
        {{ t('missions.newPost.heading', { zone: zone.name }) }}
        <InfoTooltip
          :text="t('missions.newPost.headingHelp')"
          :tooltip-id="fieldId('heading-help')"
        />
      </h4>
      <p v-if="dayCount > 1" class="evp-hint">
        {{ t('missions.newPost.allDays', { count: dayCount }) }}
      </p>

      <p class="evp-field">
        <label :for="fieldId('name')">
          <span>{{ t('missions.fields.name') }}</span>
          <input
            :id="fieldId('name')"
            v-model="draft.name"
            type="text"
            :aria-invalid="shownProblem !== null"
            :aria-describedby="
              shownProblem === null ? undefined : fieldId('problem')
            "
            @input="touched = true"
          />
        </label>
      </p>

      <p class="evp-field">
        <label :for="fieldId('description')">
          <span>{{ t('missions.fields.description') }}</span>
          <textarea
            :id="fieldId('description')"
            v-model="draft.description"
            rows="2"
          />
        </label>
      </p>

      <p class="evp-field">
        <label :for="fieldId('address')">
          <span>{{ t('missions.fields.address') }}</span>
          <input :id="fieldId('address')" v-model="draft.address" type="text" />
        </label>
      </p>

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
              <input
                :id="fieldId('min-volunteers')"
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
            <label :for="fieldId('max-volunteers')">
              <span>{{ t('missions.fields.maximum') }}</span>
              <input
                :id="fieldId('max-volunteers')"
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

      <p
        v-if="shownProblem !== null"
        :id="fieldId('problem')"
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
          dayCount > 1
            ? t('missions.newPost.addedToAllDays', {
                name: created,
                count: dayCount,
              })
            : t('missions.newPost.added', { name: created })
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
              ? t('missions.newPost.adding')
              : t('missions.newPost.submit')
          }}
        </button>
        <button
          type="button"
          class="evp-button"
          :disabled="create.isPending.value"
          @click="cancel"
        >
          {{ t('missions.newPost.done') }}
        </button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.evp-add-post {
  margin: 0.5rem 0 1rem;
  max-width: 42rem;
}

.evp-add-heading {
  font-size: 0.9375rem;
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
