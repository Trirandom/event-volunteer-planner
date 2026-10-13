<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * The `missions` question's options: which of the scope's missions a
 * volunteer is asked about, and what each is called on the form.
 *
 * A checklist of every mission rather than a list of the offered ones with an
 * "add" button, because the question a coordinator is answering here is "is
 * there anything we should *not* offer?" (ADR-0036: a core-team-only post). A
 * mission created on the missions page after this draft was made therefore
 * turns up unticked at the bottom — offered only once somebody decides to.
 *
 * The days each mission runs on are listed beside it, since the fold is by
 * name (`missionCatalog.ts`) and a fold nobody intended is only visible as a
 * mission running on days that make no sense together.
 */
import { computed } from 'vue';

import type { MissionOption } from '../api/forms';
import {
  missionChoices,
  offerMission,
  renameOption,
  withdrawMission,
  type DraftOption,
} from '../plan/formDraft';
import { t } from '../i18n';

const props = defineProps<{
  readonly options: readonly DraftOption[];
  /** `null` while loading or after a failure: there is then nothing to
   * compare against, and saying "no longer a mission" would be a guess. */
  readonly scopeMissions: readonly MissionOption[] | null;
  readonly eventNames: ReadonlyMap<string, string>;
  readonly idBase: string;
  readonly nextKey: () => string;
}>();

const emit = defineEmits<{ update: [options: DraftOption[]] }>();

const choices = computed(() =>
  missionChoices(props.options, props.scopeMissions ?? []),
);

function toggle(value: string, offered: boolean): void {
  if (offered) {
    emit('update', withdrawMission(props.options, value));
    return;
  }
  const mission = props.scopeMissions?.find((m) => m.value === value);
  if (mission !== undefined) {
    emit('update', offerMission(props.options, mission, props.nextKey()));
  }
}

function rename(key: string, locale: 'fr' | 'en', text: string): void {
  emit(
    'update',
    renameOption(
      props.options,
      key,
      locale === 'fr' ? { fr: text } : { en: text },
    ),
  );
}

function days(mission: MissionOption | null): string {
  if (mission === null) {
    return '';
  }
  return mission.event_ids
    .map((id) => props.eventNames.get(id) ?? '?')
    .join(', ');
}

function inputValue(event: Event): string {
  return event.target instanceof HTMLInputElement ? event.target.value : '';
}

const id = (suffix: string): string => `${props.idBase}-missions-${suffix}`;
</script>

<template>
  <fieldset class="evp-missions">
    <legend>{{ t('forms.missions.legend') }}</legend>

    <!-- Not editable here: both come from the zones, so changing them here
         would be a second place to say the same thing that disagrees with
         the first. -->
    <p class="evp-hint">{{ t('forms.missions.flagsHint') }}</p>

    <p v-if="scopeMissions === null" class="evp-hint">
      {{ t('forms.missions.loadFailed') }}
    </p>
    <p v-else-if="choices.length === 0" class="evp-hint">
      {{ t('forms.missions.none') }}
    </p>

    <ul class="evp-missions-list">
      <li
        v-for="(choice, index) in choices"
        :key="choice.value"
        class="evp-mission-choice"
        :class="{ 'evp-mission-choice--off': choice.option === null }"
      >
        <label :for="id(`offer-${index}`)" class="evp-check">
          <input
            :id="id(`offer-${index}`)"
            type="checkbox"
            :checked="choice.option !== null"
            :disabled="choice.option === null && choice.mission === null"
            @change="toggle(choice.value, choice.option !== null)"
          />
          <span>
            {{ choice.mission?.label ?? choice.option?.labelFr }}
            <span v-if="choice.option === null" class="evp-tag">
              {{ t('forms.missions.notOffered') }}
            </span>
            <span
              v-else-if="choice.mission === null && scopeMissions !== null"
              class="evp-tag evp-tag--warning"
            >
              {{ t('forms.missions.unresolved') }}
            </span>
            <!-- Read from the scope's missions, not the option: they are the
                 zones' settings as of now, which is what publish will stamp. -->
            <span v-if="choice.mission?.adults_only === true" class="evp-tag">
              {{ t('forms.missions.adultsOnly') }}
            </span>
            <span
              v-if="choice.mission?.checked_by_default === false"
              class="evp-tag"
            >
              {{ t('forms.missions.notPreTicked') }}
            </span>
          </span>
        </label>
        <span v-if="choice.mission !== null" class="evp-hint">
          {{ days(choice.mission) }}
        </span>

        <div v-if="choice.option !== null" class="evp-mission-labels">
          <label :for="id(`fr-${index}`)" class="evp-inline-field">
            <span>{{ t('forms.missions.labelFr') }}</span>
            <input
              :id="id(`fr-${index}`)"
              type="text"
              :value="choice.option.labelFr"
              @input="rename(choice.option.key, 'fr', inputValue($event))"
            />
          </label>
          <label :for="id(`en-${index}`)" class="evp-inline-field">
            <span>{{ t('forms.missions.labelEn') }}</span>
            <input
              :id="id(`en-${index}`)"
              type="text"
              :value="choice.option.labelEn"
              @input="rename(choice.option.key, 'en', inputValue($event))"
            />
          </label>
        </div>
      </li>
    </ul>
  </fieldset>
</template>

<style scoped>
.evp-missions {
  border: 1px solid var(--evp-border);
  border-radius: 0.375rem;
  margin: 0 0 1rem;
  padding: 0.5rem 0.75rem 0.75rem;
}

.evp-missions legend {
  font-weight: 500;
  padding: 0 0.25rem;
}

.evp-missions-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.evp-mission-choice {
  border-bottom: 1px solid var(--evp-border);
  padding: 0.5rem 0;
}

.evp-mission-choice:last-child {
  border-bottom: 0;
}

.evp-mission-choice--off {
  color: var(--evp-text-muted);
}

.evp-check {
  align-items: center;
  display: flex;
  gap: 0.5rem;
  min-height: 2rem;
}

.evp-check input {
  height: 1.125rem;
  width: 1.125rem;
}

.evp-mission-labels {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 0.25rem 0 0 1.625rem;
}

.evp-inline-field {
  display: flex;
  flex: 1 1 12rem;
  flex-direction: column;
  font-size: 0.875rem;
}

.evp-inline-field input {
  background: var(--evp-surface);
  border: 1px solid var(--evp-border);
  border-radius: 0.375rem;
  color: var(--evp-text);
  font: inherit;
  min-height: 2.25rem;
  padding: 0.25rem 0.5rem;
}

.evp-hint {
  color: var(--evp-text-muted);
  display: block;
  font-size: 0.8125rem;
  margin: 0 0 0 1.625rem;
}

.evp-missions > .evp-hint {
  margin: 0 0 0.5rem;
}

.evp-tag {
  border: 1px solid var(--evp-border);
  border-radius: 999px;
  font-size: 0.75rem;
  margin-left: 0.25rem;
  padding: 0 0.375rem;
}

.evp-tag--warning {
  border-color: var(--evp-warning);
  color: var(--evp-text);
}
</style>
