<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * Adding a day to the production this page is about.
 *
 * The events list already has a create form, and this is not a second copy of
 * it. That one is the org's index: it asks which festival the event belongs
 * to, because at that point nobody has said. Here the answer is the page —
 * a coordinator setting up Soundclash 26 adds its six days from inside
 * Soundclash 26, one after another, and being sent back to the index to pick
 * the festival out of a `<select>` for each of them is the workflow this
 * product exists to replace.
 *
 * So the festival is not a field, the zone is filled in from the production,
 * and the form stays open and empty after each day — the same choice
 * `NewMissionForm.vue` makes, for the same reason: this is used in runs of
 * six, not once.
 *
 * Behind a disclosure, because the common visit to the details section is
 * correcting hours that already exist, and an open five-field form above the
 * day cards pushes them off the first screen.
 */
import { computed, ref } from 'vue';

import { useCreateEvent } from '../api/useEvents';
import { t, type AdminMessageKey } from '../i18n';
import {
  emptyNewEventDraft,
  newEventInput,
  newEventProblem,
  withName,
  withSlug,
  type NewEventDraft,
  type NewEventProblem,
} from '../plan/newEventDraft';

const props = defineProps<{
  readonly orgId: string;
  /** The production this page is about, or `null` when the page is a
   * standalone event — in which case the new event is standalone too. */
  readonly festivalId: string | null;
  /** What the production is called, for the sentence under the heading. */
  readonly productionName: string;
  /** The production's own IANA zone, as the new day's default. */
  readonly timezone: string;
  /** Every slug the days in scope already use, so the clash is caught here
   * rather than as a 409 per attempt. */
  readonly takenSlugs: readonly string[];
}>();

const open = ref(false);
const draft = ref<NewEventDraft>(emptyNewEventDraft(props.timezone));
/** Why the last attempt was refused, kept as the reason rather than as a
 * sentence so the sentence follows a language switch. */
const refusal = ref<
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'server'; readonly detail: string }
  | null
>(null);
const created = ref<string | null>(null);

const create = useCreateEvent(() => props.orgId);

const problem = computed(() => newEventProblem(draft.value, props.takenSlugs));

/** Empty until somebody types, so the form does not open onto a red field
 * complaining that a form nobody has touched is incomplete. */
const touched = ref(false);
const shownProblem = computed(() => (touched.value ? problem.value : null));

const PROBLEM_TEXT: Readonly<Record<NewEventProblem, AdminMessageKey>> = {
  'name-missing': 'events.newEvent.problem.nameMissing',
  'slug-missing': 'events.newEvent.problem.slugMissing',
  'slug-taken': 'events.newEvent.problem.slugTaken',
  'timezone-unknown': 'events.newEvent.problem.timezoneUnknown',
  'start-missing': 'events.newEvent.problem.startMissing',
  'end-missing': 'events.newEvent.problem.endMissing',
  'period-inverted': 'events.newEvent.problem.periodInverted',
};

const refusalText = computed(() => {
  const value = refusal.value;
  if (value === null) {
    return null;
  }
  return value.kind === 'unavailable'
    ? t('events.newEvent.unavailable')
    : value.detail;
});

function reset(): void {
  draft.value = emptyNewEventDraft(props.timezone);
  touched.value = false;
}

/**
 * The name and the slug, as fields that write through the draft module.
 *
 * Writable computeds rather than `v-model="draft.name"`, because these two
 * are not independent: the slug follows the name until it is typed in, which
 * is a rule about both at once and lives where it can be tested
 * (`plan/newEventDraft.ts`). Writing the property directly would leave the
 * rule in a watcher, and a watcher would make it a rule about which field
 * happened to update first.
 */
const name = computed({
  get: () => draft.value.name,
  set: (value: string) => {
    touched.value = true;
    draft.value = withName(draft.value, value);
  },
});

const slug = computed({
  get: () => draft.value.slug,
  set: (value: string) => {
    touched.value = true;
    draft.value = withSlug(draft.value, value);
  },
});

async function submit(): Promise<void> {
  touched.value = true;
  const input = newEventInput(draft.value, props.festivalId);
  if (problem.value !== null || input === null) {
    return;
  }
  refusal.value = null;
  created.value = null;

  const outcome = await create.mutateAsync(input);

  if (!outcome.ok) {
    refusal.value =
      outcome.rejection.reason === 'unavailable'
        ? { kind: 'unavailable' }
        : { kind: 'server', detail: outcome.rejection.detail };
    return;
  }

  created.value = outcome.event.name;
  // Cleared rather than closed: a festival is six of these in a row, and the
  // zone is seeded again from the production rather than kept from the last
  // day, because that is where it came from in the first place.
  reset();
}

function cancel(): void {
  open.value = false;
  reset();
  refusal.value = null;
  created.value = null;
}

const fieldId = (field: string): string => `evp-new-event-${field}`;
</script>

<template>
  <section class="evp-add">
    <button
      v-if="!open"
      type="button"
      class="evp-button evp-button--primary"
      @click="open = true"
    >
      {{
        festivalId === null
          ? t('events.newEvent.addAnotherEvent')
          : t('events.newEvent.addDayButton')
      }}
    </button>

    <form v-else class="evp-panel" novalidate @submit.prevent="submit">
      <h3 class="evp-add-heading">
        {{
          festivalId === null
            ? t('events.newEvent.headingEvent')
            : t('events.newEvent.headingDay')
        }}
      </h3>
      <p class="evp-hint">
        {{
          festivalId === null
            ? t('events.newEvent.hintStandalone', {
                production: productionName,
              })
            : t('events.newEvent.hintDay', { production: productionName })
        }}
      </p>

      <p class="evp-field">
        <label :for="fieldId('name')">
          <span>{{ t('events.newEvent.name') }}</span>
          <input
            :id="fieldId('name')"
            v-model="name"
            type="text"
            :aria-invalid="shownProblem === 'name-missing'"
            :aria-describedby="
              shownProblem === null ? undefined : fieldId('problem')
            "
          />
        </label>
      </p>

      <p class="evp-field">
        <label :for="fieldId('slug')">
          <span>{{ t('events.newEvent.slug') }}</span>
          <span class="evp-hint">{{ t('events.newEvent.slugHint') }}</span>
          <input
            :id="fieldId('slug')"
            v-model="slug"
            type="text"
            spellcheck="false"
            :aria-invalid="
              shownProblem === 'slug-missing' || shownProblem === 'slug-taken'
            "
            :aria-describedby="
              shownProblem === null ? undefined : fieldId('problem')
            "
          />
        </label>
      </p>

      <p class="evp-field">
        <label :for="fieldId('timezone')">
          <span>{{ t('events.newEvent.timezone') }}</span>
          <span class="evp-hint">
            {{
              t('events.newEvent.timezoneHint', { production: productionName })
            }}
          </span>
          <input
            :id="fieldId('timezone')"
            v-model="draft.timezone"
            type="text"
            spellcheck="false"
            :aria-invalid="shownProblem === 'timezone-unknown'"
            :aria-describedby="
              shownProblem === null ? undefined : fieldId('problem')
            "
            @input="touched = true"
          />
        </label>
      </p>

      <div class="evp-row">
        <p class="evp-field">
          <label :for="fieldId('start')">
            <span>{{ t('events.newEvent.starts') }}</span>
            <input
              :id="fieldId('start')"
              v-model="draft.start"
              type="datetime-local"
              :aria-invalid="shownProblem === 'start-missing'"
              @input="touched = true"
            />
          </label>
        </p>
        <p class="evp-field">
          <label :for="fieldId('end')">
            <span>{{ t('events.newEvent.ends') }}</span>
            <input
              :id="fieldId('end')"
              v-model="draft.end"
              type="datetime-local"
              :aria-invalid="
                shownProblem === 'end-missing' ||
                shownProblem === 'period-inverted'
              "
              @input="touched = true"
            />
          </label>
        </p>
      </div>
      <p class="evp-hint">{{ t('events.newEvent.periodHint') }}</p>

      <p
        v-if="shownProblem !== null"
        :id="fieldId('problem')"
        class="evp-error"
        role="alert"
      >
        {{ t(PROBLEM_TEXT[shownProblem]) }}
      </p>
      <p v-else-if="refusalText !== null" class="evp-error" role="alert">
        {{ refusalText }}
      </p>
      <p v-else-if="created !== null" class="evp-saved" role="status">
        {{ t('events.newEvent.created', { name: created }) }}
      </p>

      <div class="evp-actions">
        <button
          type="submit"
          class="evp-button evp-button--primary"
          :disabled="create.isPending.value"
        >
          {{
            create.isPending.value
              ? t('events.newEvent.adding')
              : festivalId === null
                ? t('events.newEvent.addEvent')
                : t('events.newEvent.addDay')
          }}
        </button>
        <button
          type="button"
          class="evp-button"
          :disabled="create.isPending.value"
          @click="cancel"
        >
          {{ t('events.newEvent.done') }}
        </button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.evp-add {
  margin-bottom: 1.5rem;
  /* The same column the detail cards keep: a datetime field stretched across
     the board's full-window layout is unreadable (`EventDetailsForm.vue`). */
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

.evp-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0 1rem;
}

.evp-row .evp-field {
  flex: 1 1 14rem;
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
</style>
