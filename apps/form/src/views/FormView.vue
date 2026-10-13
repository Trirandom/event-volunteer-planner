<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * The volunteer form (docs/09): fetch the live version, render its questions
 * in order, keep a draft, validate, send once.
 *
 * Errors appear only after the first attempt to send. A volunteer typing
 * their email should not be told it is invalid at the second character; once
 * they have pressed «Envoyer», every correction clears its own message as it
 * is made (docs/14 §5: summarised at the top, linked to each field).
 */
import {
  computed,
  nextTick,
  onBeforeUnmount,
  ref,
  shallowRef,
  watch,
} from 'vue';
import { useRoute } from 'vue-router';

import {
  fetchPublicForm,
  submitForm,
  type AnswerValue,
  type Localized,
  type PublicForm,
  type Question,
} from '../api/publicForm';
import AvailabilityQuestion from '../availability/AvailabilityQuestion.vue';
import {
  solve,
  type CaptchaChallenge,
  type CaptchaSolution,
} from '../captcha/solve';
import { dayLabel } from '../availability/format';
import {
  answersFromWindows,
  availabilityErrors,
  dayRows,
  windowsFor,
  type DayAnswer,
} from '../availability/model';
import QuestionField from '../components/QuestionField.vue';
import {
  fieldError,
  initialAnswers,
  wireAnswers,
  type Answers,
  type FieldError,
} from '../form/answers';
import { clearDrafts, loadDraft, saveDraft } from '../form/draft';
import { locale, t } from '../i18n';
import UnavailableView from './UnavailableView.vue';

const route = useRoute();

const slug = computed(() => {
  const raw = route.params['slug'];
  return typeof raw === 'string' ? raw : '';
});

const token = computed(() => {
  const raw = route.query['t'];
  return typeof raw === 'string' && raw !== '' ? raw : null;
});

type Phase =
  'loading' | 'unavailable' | 'unreachable' | 'ready' | 'sending' | 'sent';

const phase = ref<Phase>('loading');
const form = shallowRef<PublicForm | null>(null);
const answers = ref<Answers>({});
const availability = ref<Record<string, DayAnswer>>({});
const restored = ref(false);
const attempted = ref(false);
const banner = ref<string | null>(null);
const honeypot = ref('');
let openedAt = 0;

/**
 * ADR-0043: the proof of work, searched for in the background from the moment
 * the form is on screen. By the time anyone has typed a name it is done; a
 * fast sender waits for it under the "Sending…" label, never on a puzzle.
 */
let solving: Promise<CaptchaSolution | null> = Promise.resolve(null);
let solver: AbortController | null = null;

function startSolving(challenge: CaptchaChallenge | null | undefined): void {
  solver?.abort();
  if (challenge === null || challenge === undefined) {
    solver = null;
    solving = Promise.resolve(null);
    return;
  }
  const controller = new AbortController();
  solver = controller;
  solving = solve(challenge, controller.signal);
}

onBeforeUnmount(() => solver?.abort());

/**
 * Development only: `/f/demo` renders the worked example without an API, so
 * the form can be looked at on a phone before the public endpoint exists.
 * `import.meta.env.DEV` is a build-time constant, so the branch and the
 * fixture's chunk are both absent from the production bundle.
 */
async function load(carry?: {
  answers: Answers;
  availability: Record<string, DayAnswer>;
}): Promise<void> {
  phase.value = 'loading';
  const result =
    import.meta.env.DEV && slug.value === 'demo'
      ? { ok: true as const, value: (await import('../dev/demoForm')).demoForm }
      : await fetchPublicForm(slug.value, token.value);

  if (!result.ok) {
    phase.value =
      result.failure.reason === 'rejected' && result.failure.status === 404
        ? 'unavailable'
        : 'unreachable';
    return;
  }

  const value = result.value;
  const rows = value.events.flatMap(dayRows);
  const draft = carry ?? loadDraft(value.form.slug, value.version.id);
  const base = initialAnswers(value.version.questions, value.prefill);
  const fromPrefill = answersFromWindows(
    rows,
    value.prefill?.availability ?? [],
  );

  // A draft only fills questions that still exist and rows that still exist:
  // the version or the event days may have moved on since it was written.
  answers.value = Object.fromEntries(
    Object.entries(base).map(([id, empty]) => [
      id,
      draft?.answers[id] ?? empty,
    ]),
  );
  const rowKeys = new Set(rows.map((r) => r.key));
  availability.value = {
    ...fromPrefill,
    ...Object.fromEntries(
      Object.entries(draft?.availability ?? {}).filter(([k]) => rowKeys.has(k)),
    ),
  };
  restored.value = carry === undefined && draft !== null;
  form.value = value;
  startSolving(value.captcha);
  openedAt = performance.now();
  phase.value = 'ready';
}

watch([slug, token], () => void load(), { immediate: true });

watch(
  [answers, availability],
  () => {
    const value = form.value;
    if (value !== null && phase.value === 'ready') {
      saveDraft(value.form.slug, value.version.id, {
        answers: answers.value,
        availability: availability.value,
      });
    }
  },
  { deep: true },
);

function pick(text: Localized | null | undefined): string | null {
  if (text == null) {
    return null;
  }
  const en = text.en?.trim() ?? '';
  const chosen = locale.value === 'en' && en !== '' ? en : text.fr;
  return chosen.trim() === '' ? null : chosen;
}

const questions = computed(() => form.value?.version.questions ?? []);
const events = computed(() => form.value?.events ?? []);
const rows = computed(() => events.value.flatMap(dayRows));

const fieldId = (q: Question): string => `q-${q.id}`;

function errorText(q: Question, error: FieldError): string {
  if (error === 'required' && q.kind === 'consent') {
    return t('errors.consent');
  }
  return t(`errors.${error}`);
}

interface ShownError {
  readonly target: string;
  readonly label: string;
  readonly message: string;
}

const validation = computed(() => {
  const fields: Record<string, string> = {};
  const rowMessages: Record<string, string> = {};
  let availabilityMessage: string | null = null;
  const summary: ShownError[] = [];

  for (const q of questions.value) {
    const label = pick(q.label) ?? '';
    if (q.kind === 'section') {
      continue;
    }
    if (q.kind === 'availability') {
      for (const error of availabilityErrors(
        rows.value,
        availability.value,
        q.is_required,
      )) {
        if (error.kind === 'required') {
          availabilityMessage = t('errors.availabilityRequired');
          summary.push({
            target: fieldId(q),
            label,
            message: availabilityMessage,
          });
        } else {
          const row = rows.value.find((r) => r.key === error.rowKey);
          const event = events.value.find((e) => e.id === row?.eventId);
          const message = t('errors.partialEmpty');
          rowMessages[error.rowKey] = message;
          summary.push({
            target: `${fieldId(q)}-${error.rowKey}`,
            label:
              row === undefined || event === undefined
                ? label
                : `${event.name} — ${dayLabel(row, { locale: locale.value, timeZone: event.timezone })}`,
            message,
          });
        }
      }
      continue;
    }
    const error = fieldError(q, answers.value[q.id]);
    if (error !== null) {
      fields[q.id] = errorText(q, error);
      summary.push({ target: fieldId(q), label, message: errorText(q, error) });
    }
  }
  return { fields, rowMessages, availabilityMessage, summary };
});

const shown = computed(() => (attempted.value ? validation.value : null));

const summaryHeading = ref<HTMLElement | null>(null);

function setAnswer(id: string, value: AnswerValue): void {
  answers.value = { ...answers.value, [id]: value };
}

function setDay(key: string, answer: DayAnswer): void {
  availability.value = { ...availability.value, [key]: answer };
}

function focusTarget(id: string): void {
  const element = document.getElementById(id);
  element?.focus();
  element?.scrollIntoView({ block: 'center' });
}

async function send(): Promise<void> {
  const value = form.value;
  if (value === null || phase.value !== 'ready') {
    return;
  }
  attempted.value = true;
  banner.value = null;
  if (validation.value.summary.length > 0) {
    await nextTick();
    summaryHeading.value?.focus();
    return;
  }

  phase.value = 'sending';
  const body = {
    form_version_id: value.version.id,
    locale: locale.value,
    answers: wireAnswers(value.version.questions, answers.value),
    availability: rows.value.flatMap((row) =>
      windowsFor(
        row,
        availability.value[row.key] ?? { status: 'unset', ranges: [] },
      ),
    ),
    website: honeypot.value,
    elapsed_ms: Math.round(performance.now() - openedAt),
  };
  let outcome = await submitForm(value.form.slug, token.value, {
    ...body,
    captcha: await solving,
  });
  if (!outcome.ok && outcome.kind === 'captcha') {
    // Lapsed (a form left open for hours) or already spent: one fresh
    // challenge, solved and sent without bothering the volunteer.
    const fresh = await fetchPublicForm(value.form.slug, token.value);
    if (fresh.ok && fresh.value.captcha) {
      startSolving(fresh.value.captcha);
      outcome = await submitForm(value.form.slug, token.value, {
        ...body,
        captcha: await solving,
      });
    }
  }

  if (outcome.ok) {
    clearDrafts(value.form.slug);
    phase.value = 'sent';
    return;
  }
  phase.value = 'ready';
  switch (outcome.kind) {
    case 'stale':
      await load({ answers: answers.value, availability: availability.value });
      banner.value = t('errors.stale');
      break;
    case 'email_taken':
      banner.value = t('errors.emailTaken');
      break;
    case 'captcha':
      banner.value = t('errors.captcha');
      break;
    case 'refused':
      banner.value = t('errors.refused');
      break;
    case 'unavailable':
      banner.value = t('form.unreachable');
      break;
  }
  await nextTick();
  summaryHeading.value?.focus();
}

function startOver(): void {
  const value = form.value;
  if (value === null) {
    return;
  }
  clearDrafts(value.form.slug);
  answers.value = initialAnswers(value.version.questions, value.prefill);
  availability.value = answersFromWindows(
    rows.value,
    value.prefill?.availability ?? [],
  );
  restored.value = false;
  attempted.value = false;
}

// A heading that moves focus on a phase change, so a screen reader hears
// the new page rather than silence (the router does this on navigation only).
const heading = ref<HTMLElement | null>(null);
watch(phase, async (next, previous) => {
  if (next === 'sent' || (previous === 'loading' && next === 'ready')) {
    await nextTick();
    heading.value?.focus();
  }
});
</script>

<template>
  <UnavailableView v-if="phase === 'unavailable'" />

  <div v-else-if="phase === 'loading'" class="evp-form-note" role="status">
    <h1 class="evp-visually-hidden">{{ t('form.title') }}</h1>
    {{ t('form.loading') }}
  </div>

  <div v-else-if="phase === 'unreachable'" class="evp-banner" role="alert">
    <h1>{{ t('form.title') }}</h1>
    <p>{{ t('form.unreachable') }}</p>
    <button type="button" class="evp-button-secondary" @click="load()">
      {{ t('form.retry') }}
    </button>
  </div>

  <div v-else-if="phase === 'sent'" class="evp-thanks">
    <h1 ref="heading" tabindex="-1">{{ t('thanks.title') }}</h1>
    <p>{{ token === null ? t('thanks.body') : t('thanks.bodyToken') }}</p>
  </div>

  <form
    v-else-if="form !== null"
    class="evp-form"
    novalidate
    @submit.prevent="send"
  >
    <h1 ref="heading" tabindex="-1">{{ form.form.name }}</h1>

    <div v-if="restored" class="evp-restored" role="status">
      <span>{{ t('form.draftRestored') }}</span>
      <button type="button" class="evp-link-button" @click="startOver">
        {{ t('form.draftDiscard') }}
      </button>
    </div>

    <div
      v-if="banner !== null || (shown !== null && shown.summary.length > 0)"
      class="evp-summary"
      role="alert"
    >
      <h2 ref="summaryHeading" tabindex="-1" class="evp-summary-title">
        {{
          banner ??
          t('errors.summaryTitle', { count: shown?.summary.length ?? 0 })
        }}
      </h2>
      <ul
        v-if="shown !== null && shown.summary.length > 0"
        class="evp-summary-list"
      >
        <li v-for="item in shown.summary" :key="item.target">
          <a
            :href="`#${item.target}`"
            @click.prevent="focusTarget(item.target)"
          >
            {{ item.label }} — {{ item.message }}
          </a>
        </li>
      </ul>
    </div>

    <p class="evp-form-note">{{ t('form.requiredLegend') }}</p>

    <template v-for="question in questions" :key="question.id">
      <div v-if="question.kind === 'section'" class="evp-section">
        <h2 v-if="pick(question.label) !== null">{{ pick(question.label) }}</h2>
        <p v-if="pick(question.help_text) !== null" class="evp-section-body">
          {{ pick(question.help_text) }}
        </p>
      </div>

      <AvailabilityQuestion
        v-else-if="question.kind === 'availability'"
        :id="fieldId(question)"
        :question="question"
        :label="pick(question.label) ?? ''"
        :help="pick(question.help_text)"
        :events="events"
        :answers="availability"
        :locale="locale"
        :row-errors="shown?.rowMessages ?? {}"
        :error="shown?.availabilityMessage ?? null"
        @change="setDay"
      />

      <QuestionField
        v-else
        :id="fieldId(question)"
        :question="question"
        :label="pick(question.label) ?? ''"
        :help="pick(question.help_text)"
        :option-labels="
          (question.options ?? []).map((o) => ({
            value: o.value,
            label: pick(o.label) ?? o.value,
            adultsOnly: o.adults_only,
          }))
        "
        :value="answers[question.id]"
        :error="shown?.fields[question.id] ?? null"
        @change="(value) => setAnswer(question.id, value)"
      />
    </template>

    <!-- docs/09 §5: off-screen rather than `display: none`, which the
         simpler bots skip. Out of the tab order, and labelled for the
         screen reader that finds it anyway. -->
    <div class="evp-honeypot" aria-hidden="true">
      <label for="evp-website">
        {{ t('form.honeypot') }}
        <input
          id="evp-website"
          v-model="honeypot"
          type="text"
          name="website"
          tabindex="-1"
          autocomplete="off"
        />
      </label>
    </div>

    <div class="evp-submit-bar">
      <button
        type="submit"
        class="evp-button-primary evp-submit"
        :disabled="phase === 'sending'"
      >
        {{ phase === 'sending' ? t('form.submitting') : t('form.submit') }}
      </button>
    </div>
  </form>
</template>

<style scoped>
h1 {
  font-size: 1.5rem;
  letter-spacing: -0.02em;
  margin: 0 0 0.75rem;
}

.evp-form {
  display: grid;
  gap: 1.5rem;
}

.evp-form > h1 {
  margin: 0;
}

.evp-form-note {
  color: var(--evp-text-muted);
  font-size: 0.875rem;
  margin: 0;
}

.evp-section h2 {
  font-size: 1.1875rem;
  margin: 0 0 0.375rem;
}

.evp-section-body {
  margin: 0;
  white-space: pre-line;
}

.evp-restored,
.evp-banner,
.evp-thanks {
  background: var(--evp-surface-raised);
  border: 1px solid var(--evp-border);
  border-radius: 0.5rem;
  padding: 0.75rem 1rem;
}

.evp-restored {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 0.75rem;
  font-size: 0.9375rem;
}

.evp-thanks {
  border-left: 4px solid var(--evp-success);
}

.evp-link-button {
  background: none;
  border: 0;
  color: var(--evp-accent);
  cursor: pointer;
  font: inherit;
  font-weight: 600;
  min-height: 2.75rem;
  padding: 0;
  text-decoration: underline;
}

.evp-summary {
  border: 2px solid var(--evp-danger);
  border-left-width: 6px;
  border-radius: 0.5rem;
  padding: 0.75rem 1rem;
}

.evp-summary-title {
  font-size: 1.0625rem;
  margin: 0;
}

.evp-summary-list {
  display: grid;
  gap: 0.25rem;
  margin: 0.5rem 0 0;
  padding-left: 1.25rem;
}

.evp-summary-list a {
  color: var(--evp-danger);
  display: inline-block;
  font-weight: 600;
  min-height: 1.5rem;
}

.evp-honeypot {
  height: 1px;
  left: -10000px;
  overflow: hidden;
  position: absolute;
  width: 1px;
}

/* The send button stays reachable at the bottom of the viewport on a long
   form, without covering the last question: it is sticky, not fixed. */
.evp-submit-bar {
  background: var(--evp-surface);
  border-top: 1px solid var(--evp-border);
  bottom: 0;
  margin-inline: -1rem;
  padding: 0.75rem 1rem calc(0.75rem + env(safe-area-inset-bottom));
  position: sticky;
}

.evp-submit {
  width: 100%;
}

@media (min-width: 40rem) {
  .evp-submit {
    width: auto;
  }
}
</style>

<style>
/* Question typography shared by QuestionField and AvailabilityQuestion,
 * which are siblings here and must read as one form. */
.evp-question-label {
  font-weight: 600;
  padding: 0;
}

.evp-required {
  color: var(--evp-text-muted);
  font-size: 0.875rem;
  font-weight: 400;
}

.evp-question-help {
  color: var(--evp-text-muted);
  font-size: 0.9375rem;
  margin: 0;
  white-space: pre-line;
}

.evp-question-error {
  color: var(--evp-danger);
  font-size: 0.875rem;
  font-weight: 600;
  margin: 0;
}

.evp-question-error::before {
  content: '⚠ ';
}
</style>
