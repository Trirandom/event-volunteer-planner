<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * One question of a draft: its wording in both locales, whether it is
 * required, and what it offers.
 *
 * Unlike `MissionCard.vue` this card holds no draft of its own. A form is
 * saved whole (`PUT …/versions/{v}` is an atomic replacement, docs/04 §1), so
 * a per-card draft would be a dozen partial states that only mean something
 * together; the page holds the one draft and this card emits patches to it.
 *
 * **Locked toggles stay visible, disabled, with the reason under them.** A
 * required switch that simply is not there on the e-mail question reads as a
 * missing feature; one that is there, on, and says why it cannot be turned
 * off is the rule explained where it applies (ADR-0025, ADR-0037).
 *
 * **Reordering has three paths**, none of them a drag: the Monter/Descendre
 * buttons, and `Alt+↑`/`Alt+↓` anywhere on the card outside a text field
 * (docs/14 §5: focus-scoped, never while typing). The page moves focus with
 * the card and announces where it landed.
 */
import {
  computed,
  nextTick,
  onBeforeUnmount,
  useTemplateRef,
  watch,
} from 'vue';

import type { MissionOption } from '../api/forms';
import {
  addOption,
  builtinOf,
  hasEditableOptions,
  isRemovable,
  removeOption,
  renameOption,
  requiredRule,
  sensitiveRule,
  type DraftOption,
  type DraftProblem,
  type DraftQuestion,
  type QuestionPatch,
} from '../plan/formDraft';
import { t } from '../i18n';
import {
  destinationOf,
  kindLabel,
  requiredReason as requiredReasonOf,
} from '../plan/formLabels';
import FormMissionsEditor from './FormMissionsEditor.vue';
import InfoTooltip from './InfoTooltip.vue';

const props = defineProps<{
  readonly question: DraftQuestion;
  readonly index: number;
  readonly total: number;
  readonly problems: readonly DraftProblem[];
  readonly expanded: boolean;
  readonly scopeMissions: readonly MissionOption[] | null;
  readonly eventNames: ReadonlyMap<string, string>;
  readonly nextKey: () => string;
}>();

const emit = defineEmits<{
  update: [patch: QuestionPatch];
  move: [delta: -1 | 1, via: 'up' | 'down' | 'keyboard'];
  remove: [];
  toggle: [];
}>();

const base = computed(() => `evp-q-${props.question.key}`);
const id = (suffix: string): string => `${base.value}-${suffix}`;

const builtin = computed(() => builtinOf(props.question));
const isSection = computed(() => props.question.kind === 'section');
const required = computed(() => requiredRule(props.question));
const sensitive = computed(() => sensitiveRule(props.question));
const removable = computed(() => isRemovable(props.question));

const title = computed(() => {
  const label = props.question.labelFr.trim();
  return label === '' ? t('forms.card.untitled') : label;
});

const destination = computed(() => destinationOf(builtin.value));

const requiredReason = computed(() => requiredReasonOf(builtin.value));

/** The `builtin` argument of the origin messages. */
const origin = computed(() => (builtin.value === null ? 'no' : 'yes'));

const isTshirt = computed(() => builtin.value === 'tshirt_size');

function text(event: Event): string {
  return event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLTextAreaElement
    ? event.target.value
    : '';
}

function checked(event: Event): boolean {
  return event.target instanceof HTMLInputElement && event.target.checked;
}

function setOptions(options: DraftOption[]): void {
  emit('update', { options });
}

function addChoice(): void {
  const key = props.nextKey();
  setOptions(addOption(props.question.options ?? [], key));
  // The new option's label box is what the coordinator wants next. The
  // patch is applied by the page synchronously inside the emit, so the next
  // tick is the render that contains the box.
  void nextTick(() => {
    document.getElementById(id(`opt-${key}-fr`))?.focus();
  });
}

function renameChoice(key: string, locale: 'fr' | 'en', value: string): void {
  setOptions(
    renameOption(
      props.question.options ?? [],
      key,
      locale === 'fr' ? { fr: value } : { en: value },
    ),
  );
}

function removeChoice(key: string): void {
  setOptions(removeOption(props.question.options ?? [], key));
}

/**
 * `Alt+↑`/`Alt+↓` on the card. Bound by hand rather than as `@keydown` on
 * the `<section>`, for the reason `HelpModal.vue` binds its backdrop click:
 * the accessibility linter reads a key handler on a landmark as a hand-rolled
 * control, when every control it drives is already a real button.
 */
function onKeydown(event: KeyboardEvent): void {
  if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) {
    return;
  }
  const target = event.target;
  if (
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLInputElement &&
      target.type !== 'checkbox' &&
      target.type !== 'radio')
  ) {
    return;
  }
  event.preventDefault();
  emit('move', event.key === 'ArrowUp' ? -1 : 1, 'keyboard');
}

const card = useTemplateRef<HTMLElement>('card');
watch(card, (element, previous) => {
  previous?.removeEventListener('keydown', onKeydown);
  element?.addEventListener('keydown', onKeydown);
});
onBeforeUnmount(() => {
  card.value?.removeEventListener('keydown', onKeydown);
});

/** The `field` argument of `forms.card.field`: a section's label is its
 * title and its help is its body text. */
const labelNoun = computed(() => (isSection.value ? 'title' : 'label'));
const helpNoun = computed(() => (isSection.value ? 'text' : 'help'));
</script>

<template>
  <section
    ref="card"
    class="evp-panel evp-question"
    :class="{
      'evp-question--open': expanded,
      'evp-question--problem': problems.length > 0,
    }"
    :aria-labelledby="id('heading')"
  >
    <div class="evp-question-row">
      <h3 :id="id('heading')" class="evp-question-heading">
        <button
          :id="id('toggle')"
          type="button"
          class="evp-question-toggle"
          :aria-expanded="expanded"
          :aria-controls="id('body')"
          @click="emit('toggle')"
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
          <span class="evp-question-number">{{ index + 1 }}.</span>
          <span class="evp-question-title">{{ title }}</span>
        </button>
        <span class="evp-tag evp-tag--kind">{{
          kindLabel(question.kind)
        }}</span>
        <InfoTooltip
          v-if="!isSection"
          :text="destination"
          :tooltip-id="id('origin')"
          :label="t('forms.card.originLabel', { builtin: origin, destination })"
        >
          {{ t('forms.card.origin', { builtin: origin }) }}
        </InfoTooltip>
        <span v-if="question.isRequired" class="evp-tag">{{
          t('forms.tags.required')
        }}</span>
        <span v-if="question.isSensitive" class="evp-tag evp-tag--sensitive">
          {{ t('forms.tags.sensitive') }}
        </span>
        <span v-if="problems.length > 0" class="evp-tag evp-tag--problem">
          {{ t('forms.card.problemCount', { count: problems.length }) }}
        </span>
      </h3>

      <div class="evp-question-actions">
        <button
          :id="id('up')"
          type="button"
          class="evp-icon-button"
          :disabled="index === 0"
          :aria-label="t('forms.card.moveUp', { title })"
          :title="t('forms.card.moveUpHint')"
          aria-keyshortcuts="Alt+ArrowUp"
          @click="emit('move', -1, 'up')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path
              d="m6 15 6-6 6 6"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <button
          :id="id('down')"
          type="button"
          class="evp-icon-button"
          :disabled="index === total - 1"
          :aria-label="t('forms.card.moveDown', { title })"
          :title="t('forms.card.moveDownHint')"
          aria-keyshortcuts="Alt+ArrowDown"
          @click="emit('move', 1, 'down')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path
              d="m6 9 6 6 6-6"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <button
          v-if="removable"
          type="button"
          class="evp-icon-button evp-icon-button--danger"
          :aria-label="t('forms.card.remove', { title })"
          :title="t('forms.card.remove', { title })"
          @click="emit('remove')"
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

    <!-- Listed on the collapsed card too: a problem hidden behind a closed
         disclosure is a problem found only by the server. -->
    <ul
      v-if="problems.length > 0"
      :id="id('problems')"
      class="evp-question-problems"
    >
      <li v-for="(p, i) in problems" :key="`${p.code}-${i}`">
        {{ p.message }}
      </li>
    </ul>

    <div v-if="expanded" :id="id('body')" class="evp-question-body">
      <div class="evp-question-grid">
        <p class="evp-field">
          <label :for="id('label-fr')">
            <span>{{
              t('forms.card.field', { field: labelNoun, lang: 'fr' })
            }}</span>
            <input
              :id="id('label-fr')"
              type="text"
              :value="question.labelFr"
              :aria-invalid="question.labelFr.trim() === ''"
              :aria-describedby="
                problems.length > 0 ? id('problems') : undefined
              "
              @input="emit('update', { labelFr: text($event) })"
            />
          </label>
        </p>
        <p class="evp-field">
          <label :for="id('label-en')">
            <span
              >{{ t('forms.card.field', { field: labelNoun, lang: 'en' }) }}
              <span class="evp-optional">{{
                t('forms.card.optional')
              }}</span></span
            >
            <input
              :id="id('label-en')"
              type="text"
              :value="question.labelEn"
              @input="emit('update', { labelEn: text($event) })"
            />
          </label>
        </p>
        <p class="evp-field">
          <label :for="id('help-fr')">
            <span
              >{{ t('forms.card.field', { field: helpNoun, lang: 'fr' }) }}
              <span class="evp-optional">{{
                t('forms.card.optional')
              }}</span></span
            >
            <textarea
              :id="id('help-fr')"
              :value="question.helpFr"
              :rows="isSection ? 4 : 2"
              @input="emit('update', { helpFr: text($event) })"
            />
          </label>
        </p>
        <p class="evp-field">
          <label :for="id('help-en')">
            <span
              >{{ t('forms.card.field', { field: helpNoun, lang: 'en' }) }}
              <span class="evp-optional">{{
                t('forms.card.optional')
              }}</span></span
            >
            <textarea
              :id="id('help-en')"
              :value="question.helpEn"
              :rows="isSection ? 4 : 2"
              @input="emit('update', { helpEn: text($event) })"
            />
          </label>
        </p>
      </div>

      <!-- The coordinator's own options. The value beside each is shown
           because it is what an answer is stored as: once saved it no longer
           follows the label, and a coordinator renaming "Débutant" should see
           that earlier answers still say `debutant`. -->
      <fieldset v-if="hasEditableOptions(question)" class="evp-options">
        <legend>{{ t('forms.card.options') }}</legend>
        <ol class="evp-options-list">
          <li
            v-for="(option, i) in question.options ?? []"
            :key="option.key"
            class="evp-option"
          >
            <label :for="id(`opt-${option.key}-fr`)" class="evp-inline-field">
              <span>{{ t('forms.card.optionFr', { number: i + 1 }) }}</span>
              <input
                :id="id(`opt-${option.key}-fr`)"
                type="text"
                :value="option.labelFr"
                @input="renameChoice(option.key, 'fr', text($event))"
              />
            </label>
            <label :for="id(`opt-${option.key}-en`)" class="evp-inline-field">
              <span>{{ t('forms.card.optionEn') }}</span>
              <input
                :id="id(`opt-${option.key}-en`)"
                type="text"
                :value="option.labelEn"
                @input="renameChoice(option.key, 'en', text($event))"
              />
            </label>
            <code
              class="evp-option-value"
              :title="
                option.valueFixed
                  ? t('forms.card.valueFixed')
                  : t('forms.card.valueDerived')
              "
              >{{ option.value || '—' }}</code
            >
            <button
              type="button"
              class="evp-icon-button evp-icon-button--danger"
              :aria-label="
                option.labelFr === ''
                  ? t('forms.card.removeOption', { number: i + 1 })
                  : t('forms.card.removeOptionNamed', {
                      number: i + 1,
                      label: option.labelFr,
                    })
              "
              @click="removeChoice(option.key)"
            >
              <span aria-hidden="true">×</span>
            </button>
          </li>
        </ol>
        <button
          type="button"
          class="evp-button evp-button--small"
          @click="addChoice"
        >
          {{ t('forms.card.addOption') }}
        </button>
      </fieldset>

      <p v-else-if="isTshirt" class="evp-hint">
        {{
          t('forms.card.tshirtSizes', {
            sizes: (question.options ?? []).map((o) => o.labelFr).join(', '),
          })
        }}
      </p>

      <FormMissionsEditor
        v-else-if="question.kind === 'missions'"
        :options="question.options ?? []"
        :scope-missions="scopeMissions"
        :event-names="eventNames"
        :id-base="base"
        :next-key="nextKey"
        @update="setOptions"
      />

      <p v-if="question.kind === 'availability'" class="evp-hint">
        {{ t('forms.card.availabilityHint') }}
      </p>
      <p v-if="question.kind === 'boolean'" class="evp-hint">
        {{ t('forms.card.booleanHint') }}
      </p>

      <div v-if="!isSection" class="evp-toggles">
        <div class="evp-toggle">
          <label :for="id('required')" class="evp-check">
            <input
              :id="id('required')"
              type="checkbox"
              :checked="question.isRequired"
              :disabled="required !== 'choice'"
              :aria-describedby="
                requiredReason === undefined ? undefined : id('required-why')
              "
              @change="emit('update', { isRequired: checked($event) })"
            />
            <span>{{ t('forms.tags.required') }}</span>
          </label>
          <p
            v-if="requiredReason !== undefined"
            :id="id('required-why')"
            class="evp-hint"
          >
            {{ requiredReason }}
          </p>
        </div>

        <div v-if="sensitive !== 'fixed'" class="evp-toggle">
          <label :for="id('sensitive')" class="evp-check">
            <input
              :id="id('sensitive')"
              type="checkbox"
              :checked="question.isSensitive"
              :disabled="sensitive === 'always'"
              :aria-describedby="id('sensitive-why')"
              @change="emit('update', { isSensitive: checked($event) })"
            />
            <span>{{ t('forms.tags.sensitive') }}</span>
          </label>
          <p :id="id('sensitive-why')" class="evp-hint">
            <template v-if="sensitive === 'always'">
              {{ t('forms.labels.dietarySensitive') }}
            </template>
            {{ t('forms.labels.sensitiveEffect') }}
          </p>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.evp-question {
  margin-bottom: 0.75rem;
  max-width: 48rem;
}

.evp-question--problem {
  border-left: 4px solid var(--evp-danger);
}

.evp-question-row {
  align-items: center;
  display: flex;
  gap: 0.5rem;
  justify-content: space-between;
}

.evp-question-heading {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  font-size: 1rem;
  gap: 0.375rem 0.5rem;
  margin: 0;
  min-width: 0;
}

.evp-question-toggle {
  align-items: center;
  background: none;
  border: 0;
  border-radius: 0.25rem;
  color: inherit;
  cursor: pointer;
  display: inline-flex;
  font: inherit;
  gap: 0.25rem;
  margin-left: -0.25rem;
  min-height: 2rem;
  padding: 0 0.25rem;
  text-align: left;
}

.evp-question-toggle:hover .evp-question-title {
  text-decoration: underline;
  text-underline-offset: 0.2em;
}

.evp-question-number {
  color: var(--evp-text-muted);
  font-variant-numeric: tabular-nums;
}

.evp-question-title {
  overflow-wrap: anywhere;
}

.evp-chevron {
  color: var(--evp-text-muted);
  flex-shrink: 0;
  height: 1.125rem;
  transition: transform 120ms ease;
  width: 1.125rem;
}

.evp-question--open .evp-chevron {
  transform: rotate(90deg);
}

@media (prefers-reduced-motion: reduce) {
  .evp-chevron {
    transition: none;
  }
}

.evp-question-actions {
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
  font-size: 1.125rem;
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
  opacity: 0.4;
}

.evp-tag {
  border: 1px solid var(--evp-border);
  border-radius: 999px;
  color: var(--evp-text-muted);
  font-size: 0.8125rem;
  font-weight: 400;
  padding: 0.0625rem 0.5rem;
}

.evp-tag--kind {
  background: color-mix(in srgb, var(--evp-accent) 12%, var(--evp-surface));
  border-color: transparent;
  color: var(--evp-accent);
  font-weight: 600;
}

.evp-tag--sensitive {
  border-color: var(--evp-warning);
  color: var(--evp-text);
}

.evp-tag--problem {
  border-color: var(--evp-danger);
  color: var(--evp-danger);
  font-weight: 600;
}

.evp-question-problems {
  color: var(--evp-danger);
  font-size: 0.875rem;
  margin: 0.5rem 0 0;
  padding-left: 1.25rem;
}

.evp-question-body {
  margin-top: 0.75rem;
}

.evp-question-grid {
  column-gap: 1rem;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
}

.evp-question-grid .evp-field {
  margin: 0 0 0.75rem;
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

.evp-optional {
  color: var(--evp-text-muted);
  font-size: 0.8125rem;
  font-weight: 400;
}

.evp-options {
  border: 1px solid var(--evp-border);
  border-radius: 0.375rem;
  margin: 0 0 1rem;
  padding: 0.5rem 0.75rem 0.75rem;
}

.evp-options legend {
  font-weight: 500;
  padding: 0 0.25rem;
}

.evp-options-list {
  list-style: none;
  margin: 0 0 0.5rem;
  padding: 0;
}

.evp-option {
  align-items: flex-end;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.evp-inline-field {
  display: flex;
  flex: 1 1 10rem;
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

.evp-option-value {
  color: var(--evp-text-muted);
  font-size: 0.8125rem;
  padding-bottom: 0.5rem;
}

.evp-button--small {
  min-height: 2.25rem;
  padding: 0.375rem 0.875rem;
}

.evp-toggles {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 2rem;
}

.evp-toggle {
  flex: 1 1 16rem;
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

.evp-hint {
  color: var(--evp-text-muted);
  font-size: 0.875rem;
  margin: 0 0 0.75rem;
  max-width: 60ch;
}
</style>
