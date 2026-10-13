<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * Formulaire: the questions volunteers answer, drafted here and published
 * when they are right (docs/09).
 *
 * **Scope.** A festival has one form covering every one of its events
 * (ADR-0035) — that is what replaced the five availability questions of the
 * old Google Form. So at festival scope this page is that form; on a day of
 * the festival it says so and links there, rather than offering to make a
 * second form nobody asked for; and a standalone event, which has no festival
 * to share one with, manages its own.
 *
 * **Draft, then publish.** Every edit goes into the draft version, which is
 * saved whole (`PUT …/versions/{v}`, an atomic replacement) and can be saved
 * any number of times. Publishing freezes it: a submission is interpreted
 * against the version it answered, forever (docs/09 §2), so a live version is
 * shown read-only and changing it means starting a new draft from it. That is
 * the mechanism, not a restriction, and the page words it that way.
 *
 * **One draft, held here.** The cards emit patches; this view owns the
 * `FormDraft`, decides what is dirty by comparing it with the stored version
 * (`plan/formDraft.ts`), and guards leaving with unsaved edits — the route
 * guard for in-app navigation, `beforeunload` for the tab.
 */
import { eventTimeZone, formatDate } from '@evp/shared/intl';
import { Temporal } from '@evp/shared/time';
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  useId,
  watch,
} from 'vue';
import {
  RouterLink,
  onBeforeRouteLeave,
  onBeforeRouteUpdate,
} from 'vue-router';

import type { Event } from '../api/events';
import type { Form, FormScope, FormWriteRejection } from '../api/forms';
import {
  useCreateFormVersion,
  useForm,
  useFormVersion,
  useMissionOptions,
  usePublishFormVersion,
  useSaveFormVersion,
  useScopedForms,
} from '../api/useForms';
import { usePlanScope } from '../api/usePlan';
import { useSession } from '../api/useSession';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import FormPreview from '../components/FormPreview.vue';
import FormQuestionCard from '../components/FormQuestionCard.vue';
import FormSettingsPanel from '../components/FormSettingsPanel.vue';
import HelpModal from '../components/HelpModal.vue';
import NewFormPanel from '../components/NewFormPanel.vue';
import ToastMessage from '../components/ToastMessage.vue';
import ToastStack from '../components/ToastStack.vue';
import {
  appendQuestion,
  availableBuiltins,
  builtinQuestion,
  CUSTOM_KINDS,
  customQuestion,
  draftOf,
  isDirty,
  locateServerProblems,
  moveQuestion,
  patchQuestion,
  positionBase,
  privacyNoticeOf,
  publishProblems,
  removeQuestion,
  saveProblems,
  toInput,
  type BuiltinId,
  type CustomKind,
  type DraftProblem,
  type FormDraft,
  type QuestionPatch,
} from '../plan/formDraft';
import { t, locale } from '../i18n';
import { builtinLabel, kindLabel } from '../plan/formLabels';
import { useRouteParam } from '../router/params';

const orgId = useRouteParam('orgId');
const festivalId = useRouteParam('festivalId');
const eventId = useRouteParam('eventId');

const { scope, isPending: scopePending } = usePlanScope(
  orgId,
  festivalId,
  eventId,
);

interface Subject {
  readonly name: string;
  readonly slug: string;
  readonly timezone: string;
}

/** What this page manages at the scope the URL names. */
type PageScope =
  | {
      readonly kind: 'own';
      readonly formScope: FormScope;
      readonly subject: Subject;
      readonly events: readonly Event[];
    }
  | {
      readonly kind: 'covered';
      readonly festivalId: string;
      readonly festivalName: string | null;
      readonly dayName: string;
    };

const page = computed((): PageScope | null => {
  const value = scope.value;
  if (value === null) {
    return null;
  }
  if (value.kind === 'festival') {
    return {
      kind: 'own',
      formScope: { festivalId: value.festival.id },
      subject: value.festival,
      events: value.days,
    };
  }
  // Read off the event, not off `value.festival`: a day whose festival failed
  // to load is still a festival day, and offering it a form of its own would
  // be offering the wrong thing on a network error.
  const day = value.selected;
  if (day.festival_id !== null) {
    return {
      kind: 'covered',
      festivalId: day.festival_id,
      festivalName: value.festival?.name ?? null,
      dayName: day.name,
    };
  }
  return {
    kind: 'own',
    formScope: { eventId: day.id },
    subject: day,
    events: [day],
  };
});

const formScope = computed(() =>
  page.value?.kind === 'own' ? page.value.formScope : null,
);
const events = computed(() =>
  page.value?.kind === 'own' ? page.value.events : [],
);
const eventNames = computed(
  () => new Map(events.value.map((event) => [event.id, event.name])),
);

// ── The form and its versions ───────────────────────────────────────────────

const { data: formsResult, isPending: formsPending } = useScopedForms(
  orgId,
  formScope,
);
const forms = computed(() =>
  formsResult.value?.ok === true ? formsResult.value.value : [],
);
const formsFailed = computed(() => formsResult.value?.ok === false);

const chosenFormId = ref<string | null>(null);
const formId = computed(() => {
  const list = forms.value;
  return (
    list.find((form) => form.id === chosenFormId.value)?.id ?? list[0]?.id ?? ''
  );
});

const { data: formResult } = useForm(orgId, formId);
/** The form's own query once it answers, the list's copy until then — the
 * list already carries the whole row, so there is no reason to show a
 * spinner for a second request. */
const form = computed(
  (): Form | null =>
    (formResult.value?.ok === true ? formResult.value.value : null) ??
    forms.value.find((candidate) => candidate.id === formId.value) ??
    null,
);

const draftSummary = computed(
  () => form.value?.versions.find((v) => v.published_at === null) ?? null,
);
const liveSummary = computed(
  () =>
    form.value?.versions.find((v) => v.id === form.value?.live_version_id) ??
    null,
);

const chosenVersion = ref<number | null>(null);
/** The version on screen: the one picked from the list, else the draft being
 * worked on, else the live one — what a coordinator opening the page most
 * likely came to change, then what volunteers currently see. */
const versionNumber = computed(() => {
  const value = form.value;
  if (value === null) {
    return 0;
  }
  if (
    chosenVersion.value !== null &&
    value.versions.some((v) => v.version === chosenVersion.value)
  ) {
    return chosenVersion.value;
  }
  return (
    draftSummary.value?.version ??
    liveSummary.value?.version ??
    value.versions.reduce((highest, v) => Math.max(highest, v.version), 0)
  );
});

const { data: versionResult, refetch: refetchVersion } = useFormVersion(
  orgId,
  formId,
  versionNumber,
);
const version = computed(() =>
  versionResult.value?.ok === true ? versionResult.value.value : null,
);
const versionFailed = computed(() => versionResult.value?.ok === false);
const isDraft = computed(() => version.value?.published_at === null);

watch(formScope, () => {
  chosenFormId.value = null;
  chosenVersion.value = null;
});

const { data: missionOptionsResult } = useMissionOptions(orgId, formId, {
  enabled: isDraft,
});
/** `null` until it answers, and after a failure — `formDraft.ts` then calls
 * nothing unresolved rather than everything. */
const scopeMissions = computed(() =>
  missionOptionsResult.value?.ok === true
    ? missionOptionsResult.value.value
    : null,
);

// ── The draft ───────────────────────────────────────────────────────────────

const draft = ref<FormDraft | null>(null);
/** What the server last refused, pinned to questions. Kept until the next
 * attempt rather than cleared on every keystroke: fixing one of three should
 * not make the other two vanish. */
const serverProblems = ref<readonly DraftProblem[]>([]);

/**
 * Re-seeded when a different version arrives, or when the same one is
 * re-read while nothing here is unsaved. A background refetch must not wipe
 * what somebody is halfway through typing — the same rule `MissionCard.vue`
 * follows for the same reason.
 */
watch(
  version,
  (next, previous) => {
    if (next === null) {
      return;
    }
    const current = draft.value;
    if (
      current === null ||
      previous?.id !== next.id ||
      !isDirty(previous, current)
    ) {
      draft.value = draftOf(next);
      serverProblems.value = [];
    }
  },
  { immediate: true },
);

const dirty = computed(() => {
  const saved = version.value;
  const current = draft.value;
  return (
    isDraft.value &&
    saved !== null &&
    current !== null &&
    isDirty(saved, current)
  );
});

let keyCounter = 0;
/** Client keys for questions and options not yet saved. A counter rather than
 * random ids: they only have to be unique on this page, and a predictable
 * key is one a test can name. */
function nextKey(): string {
  keyCounter += 1;
  return `new-${String(keyCounter)}`;
}

const expanded = ref<ReadonlySet<string>>(new Set());

function setExpanded(key: string, open: boolean): void {
  const next = new Set(expanded.value);
  if (open) {
    next.add(key);
  } else {
    next.delete(key);
  }
  expanded.value = next;
}

/** Spoken after a move, an add or a removal — the card itself is where focus
 * goes, and this says what happened to it. */
const announcement = ref('');

/** A question's French label as the announcements name it: `named` is `no`
 * when it has none yet, and the message then says "the question". */
function labelOf(key: string): { named: 'yes' | 'no'; label: string } {
  const label =
    draft.value?.questions.find((q) => q.key === key)?.labelFr.trim() ?? '';
  return { named: label === '' ? 'no' : 'yes', label };
}

function update(key: string, patch: QuestionPatch): void {
  if (draft.value !== null) {
    draft.value = patchQuestion(draft.value, key, patch);
  }
}

function move(key: string, delta: -1 | 1): void {
  const current = draft.value;
  if (current === null) {
    return;
  }
  const moved = moveQuestion(current, key, delta);
  if (moved === null) {
    return;
  }
  // Vue moves the keyed card's node, which drops focus in some engines; the
  // element that had it is put back, or the card's own toggle when that
  // element has just been disabled (Monter on the new first question).
  const active = document.activeElement;
  draft.value = moved.draft;
  announcement.value = t('forms.page.announce.moved', {
    ...labelOf(key),
    position: moved.index + 1,
    total: moved.draft.questions.length,
  });
  void nextTick(() => {
    if (
      active instanceof HTMLElement &&
      active.isConnected &&
      !(active instanceof HTMLButtonElement && active.disabled)
    ) {
      active.focus();
      return;
    }
    document.getElementById(`evp-q-${key}-toggle`)?.focus();
  });
}

function remove(key: string): void {
  const current = draft.value;
  if (current === null) {
    return;
  }
  const index = current.questions.findIndex((q) => q.key === key);
  const label = labelOf(key);
  const next = removeQuestion(current, key);
  if (next.questions.length === current.questions.length) {
    return;
  }
  draft.value = next;
  announcement.value = t('forms.page.announce.removed', label);
  const neighbour =
    next.questions[Math.min(index, next.questions.length - 1)]?.key ?? null;
  void nextTick(() => {
    (neighbour === null
      ? document.getElementById(paletteHeadingId)
      : document.getElementById(`evp-q-${neighbour}-toggle`)
    )?.focus();
  });
}

function added(key: string): void {
  setExpanded(key, true);
  announcement.value = t('forms.page.announce.added', labelOf(key));
  void nextTick(() => {
    document.getElementById(`evp-q-${key}-label-fr`)?.focus();
  });
}

const { data: session } = useSession();

/** What the commitment names (ADR-0040). The session lists every
 * membership, so this is the organisation of the route, not the first one. */
const organizationName = computed(() => {
  const value = session.value;
  if (value?.status !== 'authenticated') {
    return '';
  }
  return (
    value.user.memberships.find((m) => m.org_id === orgId.value)?.name ?? ''
  );
});

function addBuiltin(id: BuiltinId): void {
  if (draft.value === null) {
    return;
  }
  const key = nextKey();
  draft.value = appendQuestion(
    draft.value,
    builtinQuestion(
      id,
      key,
      scopeMissions.value ?? [],
      nextKey,
      organizationName.value,
    ),
  );
  added(key);
}

function addCustom(kind: CustomKind | 'section'): void {
  if (draft.value === null) {
    return;
  }
  const key = nextKey();
  draft.value = appendQuestion(draft.value, customQuestion(kind, key));
  added(key);
}

function setNotice(event: globalThis.Event): void {
  if (draft.value !== null && event.target instanceof HTMLInputElement) {
    draft.value = { ...draft.value, privacyNoticeVersion: event.target.value };
  }
}

function discard(): void {
  if (version.value !== null) {
    draft.value = draftOf(version.value);
    serverProblems.value = [];
    announcement.value = t('forms.page.announce.discarded');
  }
}

const palette = computed(() =>
  draft.value === null ? [] : availableBuiltins(draft.value, true),
);

// ── Problems ────────────────────────────────────────────────────────────────

const blocking = computed(() =>
  draft.value === null || !isDraft.value
    ? []
    : saveProblems(draft.value, { scoped: true }),
);

const beforePublish = computed(() => {
  const current = draft.value;
  const value = form.value;
  if (current === null || value === null || !isDraft.value) {
    return [];
  }
  return publishProblems(current, {
    defaultLocale: value.default_locale,
    missionValues:
      scopeMissions.value === null
        ? null
        : new Set(scopeMissions.value.map((m) => m.value)),
  });
});

const allProblems = computed(() => [
  ...blocking.value,
  ...beforePublish.value,
  ...serverProblems.value,
]);

function problemsFor(key: string): DraftProblem[] {
  return allProblems.value.filter((p) => p.questionKey === key);
}

function positionOf(key: string | null): number | null {
  if (key === null) {
    return null;
  }
  const index = draft.value?.questions.findIndex((q) => q.key === key) ?? -1;
  return index === -1 ? null : index + 1;
}

function openProblem(key: string | null): void {
  if (key === null) {
    return;
  }
  setExpanded(key, true);
  void nextTick(() => {
    document.getElementById(`evp-q-${key}-toggle`)?.focus();
  });
}

const summaryId = useId();
const paletteHeadingId = useId();

// ── Writes ──────────────────────────────────────────────────────────────────

const toast = ref<{
  readonly tone: 'danger' | 'info';
  readonly text: string;
  readonly offerReload?: boolean;
} | null>(null);

const save = useSaveFormVersion(orgId);
const publish = usePublishFormVersion(orgId);
const createVersion = useCreateFormVersion(orgId);

/** The one sentence for a refusal nothing more specific handles. */
function rejectionText(rejection: FormWriteRejection): string {
  return rejection.reason === 'unavailable'
    ? t('forms.errors.unavailable')
    : rejection.detail;
}

function problemsToast(count: number, action: 'save' | 'publish'): string {
  return t(
    action === 'save'
      ? 'forms.page.toast.saveRefused'
      : 'forms.page.toast.publishRefused',
    { count },
  );
}

function expandProblems(problems: readonly DraftProblem[]): void {
  const next = new Set(expanded.value);
  for (const p of problems) {
    if (p.questionKey !== null) {
      next.add(p.questionKey);
    }
  }
  expanded.value = next;
}

async function saveDraft(): Promise<void> {
  const saved = version.value;
  const current = draft.value;
  const value = form.value;
  if (saved === null || current === null || value === null || !dirty.value) {
    return;
  }
  if (blocking.value.length > 0) {
    expandProblems(blocking.value);
    void nextTick(() => document.getElementById(summaryId)?.focus());
    return;
  }

  toast.value = null;
  serverProblems.value = [];
  // The positions the server will call these questions by, captured now:
  // a refusal names the array that was sent, not whatever is on screen by
  // the time it arrives.
  const base = positionBase(saved);
  const positioned = current.questions.map((q, i) => ({
    position: base + i,
    key: q.key,
  }));

  const result = await save.mutateAsync({
    formId: value.id,
    save: {
      version: saved.version,
      etag: saved.etag_version,
      privacyNoticeVersion: privacyNoticeOf(current),
      questions: toInput(current),
    },
  });

  if (result.ok) {
    // Only when nothing was typed while the request was in flight; if it
    // was, those edits stay, and they are dirty against what was just saved.
    if (draft.value === current) {
      draft.value = draftOf(result.value);
    }
    toast.value = { tone: 'info', text: t('forms.page.toast.saved') };
    return;
  }

  const { rejection } = result;
  if (rejection.reason === 'conflict') {
    toast.value = {
      tone: 'danger',
      text: t('forms.page.toast.saveConflict'),
      offerReload: true,
    };
    await refetchVersion();
    return;
  }
  if (rejection.reason === 'invalid') {
    serverProblems.value = locateServerProblems(rejection.problems, positioned);
    expandProblems(serverProblems.value);
    toast.value = {
      tone: 'danger',
      text:
        rejection.problems.length === 0
          ? rejection.detail
          : problemsToast(rejection.problems.length, 'save'),
    };
    return;
  }
  toast.value = {
    tone: 'danger',
    text: rejectionText(rejection),
  };
}

async function reload(): Promise<void> {
  toast.value = null;
  const fresh = await refetchVersion();
  if (fresh.data?.ok === true) {
    draft.value = draftOf(fresh.data.value);
    serverProblems.value = [];
  }
}

const confirmingPublish = ref(false);
const publishError = ref<string | null>(null);

function askToPublish(): void {
  publishError.value = null;
  confirmingPublish.value = true;
}

async function confirmPublish(): Promise<void> {
  const saved = version.value;
  const value = form.value;
  if (saved === null || value === null) {
    return;
  }
  publishError.value = null;
  const result = await publish.mutateAsync({
    formId: value.id,
    version: saved.version,
    etag: saved.etag_version,
  });

  if (result.ok) {
    confirmingPublish.value = false;
    chosenVersion.value = result.value.version;
    toast.value = {
      tone: 'info',
      text: t('forms.page.toast.published', {
        version: result.value.version,
      }),
    };
    return;
  }

  const { rejection } = result;
  if (rejection.reason === 'invalid') {
    confirmingPublish.value = false;
    serverProblems.value = locateServerProblems(
      rejection.problems,
      saved.questions.map((q) => ({ position: q.position, key: q.id })),
    );
    expandProblems(serverProblems.value);
    toast.value = {
      tone: 'danger',
      text:
        rejection.problems.length === 0
          ? rejection.detail
          : problemsToast(rejection.problems.length, 'publish'),
    };
    void nextTick(() => document.getElementById(summaryId)?.focus());
    return;
  }
  publishError.value =
    rejection.reason === 'conflict'
      ? t('forms.page.toast.publishConflict')
      : rejectionText(rejection);
}

async function startNewVersion(): Promise<void> {
  const value = form.value;
  if (value === null) {
    return;
  }
  toast.value = null;
  const result = await createVersion.mutateAsync(value.id);
  if (result.ok) {
    chosenVersion.value = result.value.version;
    toast.value = {
      tone: 'info',
      text: t('forms.page.toast.versionCreated', {
        version: result.value.version,
      }),
    };
    return;
  }
  if (result.rejection.reason === 'conflict') {
    // A draft already exists; the form has been re-read, and clearing the
    // choice lets the default — the draft — take over.
    chosenVersion.value = null;
    toast.value = {
      tone: 'info',
      text: t('forms.page.toast.draftExists'),
    };
    return;
  }
  toast.value = {
    tone: 'danger',
    text: rejectionText(result.rejection),
  };
}

// ── Leaving with unsaved edits ──────────────────────────────────────────────

const confirmingLeave = ref(false);
let answerLeave: ((leave: boolean) => void) | null = null;

/** Resolves once the coordinator has answered the dialog. */
async function confirmDiscard(): Promise<boolean> {
  if (!dirty.value) {
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

onBeforeRouteLeave(confirmDiscard);
onBeforeRouteUpdate(confirmDiscard);

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (dirty.value) {
    event.preventDefault();
  }
}

onMounted(() => {
  window.addEventListener('beforeunload', onBeforeUnload);
});
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onBeforeUnload);
});

async function selectVersion(number: number): Promise<void> {
  if (number === versionNumber.value || !(await confirmDiscard())) {
    return;
  }
  chosenVersion.value = number;
  serverProblems.value = [];
}

async function selectForm(event: globalThis.Event): Promise<void> {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) {
    return;
  }
  if (!(await confirmDiscard())) {
    target.value = formId.value;
    return;
  }
  chosenFormId.value = target.value;
  chosenVersion.value = null;
}

function created(value: Form): void {
  chosenFormId.value = value.id;
  chosenVersion.value = null;
  toast.value = {
    tone: 'info',
    text: t('forms.page.toast.formCreated'),
  };
}

// ── Presentation ────────────────────────────────────────────────────────────

const tab = ref<'questions' | 'preview'>('questions');
const tabsId = useId();

function onTabKey(event: KeyboardEvent): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
    return;
  }
  event.preventDefault();
  tab.value = tab.value === 'questions' ? 'preview' : 'questions';
  void nextTick(() => {
    document.getElementById(`${tabsId}-${tab.value}`)?.focus();
  });
}

function publishedOn(instant: string): string {
  const subject = page.value?.kind === 'own' ? page.value.subject : null;
  return formatDate(Temporal.Instant.from(instant).epochMilliseconds, {
    locale: locale.value,
    timeZone: eventTimeZone(subject?.timezone ?? 'UTC'),
  });
}

const versions = computed(() =>
  [...(form.value?.versions ?? [])].sort((a, b) => a.version - b.version),
);

const isPending = computed(
  () =>
    scopePending.value ||
    (formScope.value !== null &&
      formsPending.value &&
      formsResult.value === undefined),
);
</script>

<template>
  <p v-if="isPending">{{ t('common.status.loading') }}</p>

  <template v-else-if="page !== null">
    <HelpModal :title="t('forms.page.title')">
      <p>{{ t('forms.page.help.intro') }}</p>
      <p>{{ t('forms.page.help.draft') }}</p>
      <p>{{ t('forms.page.help.reorder') }}</p>
      <p>
        <kbd>{{ t('forms.page.help.shortcutUp') }}</kbd> /
        <kbd>{{ t('forms.page.help.shortcutDown') }}</kbd>
      </p>
    </HelpModal>

    <h2 class="evp-form-title">{{ t('forms.page.title') }}</h2>

    <!-- A day of a festival: the festival's form already covers it. -->
    <div v-if="page.kind === 'covered'" class="evp-panel evp-covered">
      <p>
        {{
          page.festivalName === null
            ? t('forms.page.covered.unnamed', { day: page.dayName })
            : t('forms.page.covered.named', {
                day: page.dayName,
                festival: page.festivalName,
              })
        }}
      </p>
      <RouterLink
        class="evp-button"
        :to="{
          name: 'org-festival-form',
          params: { orgId, festivalId: page.festivalId },
        }"
      >
        {{ t('forms.page.covered.open') }}
      </RouterLink>
    </div>

    <p v-else-if="formsFailed" role="alert" class="evp-error-panel">
      {{ t('forms.page.formsFailed') }}
    </p>

    <NewFormPanel
      v-else-if="forms.length === 0"
      :org-id="orgId"
      :scope="page.formScope"
      :default-name="page.subject.name"
      :default-slug="page.subject.slug"
      @created="created"
    />

    <template v-else-if="form !== null">
      <p v-if="forms.length > 1" class="evp-field evp-form-picker">
        <label for="evp-form-picker">
          <span>{{ t('forms.page.picker') }}</span>
          <select id="evp-form-picker" :value="formId" @change="selectForm">
            <option
              v-for="candidate in forms"
              :key="candidate.id"
              :value="candidate.id"
            >
              {{ candidate.name }}
            </option>
          </select>
        </label>
      </p>

      <FormSettingsPanel :key="form.id" :org-id="orgId" :form="form" />

      <nav class="evp-versions" aria-labelledby="evp-versions-heading">
        <h3 id="evp-versions-heading">
          {{ t('forms.page.versions.heading') }}
        </h3>
        <ol>
          <li v-for="entry in versions" :key="entry.id">
            <button
              type="button"
              class="evp-version"
              :aria-current="
                entry.version === versionNumber ? 'true' : undefined
              "
              @click="selectVersion(entry.version)"
            >
              <strong>{{
                t('forms.page.versions.number', { version: entry.version })
              }}</strong>
              <span v-if="entry.published_at === null">{{
                t('forms.page.versions.draft')
              }}</span>
              <span v-else>{{
                t('forms.page.versions.publishedOn', {
                  date: publishedOn(entry.published_at),
                })
              }}</span>
              <span
                v-if="entry.id === form.live_version_id"
                class="evp-tag evp-tag--live"
              >
                {{ t('forms.page.versions.live') }}
              </span>
              <span class="evp-muted">
                {{
                  t('forms.page.versions.questionCount', {
                    count: entry.question_count,
                  })
                }}
              </span>
            </button>
          </li>
        </ol>
      </nav>

      <p v-if="versionFailed" role="alert" class="evp-error-panel">
        {{ t('forms.page.versionFailed') }}
      </p>

      <template v-else-if="version !== null && draft !== null">
        <!-- The draft's own controls, kept in view down a long list: saving
             and the unsaved-changes state are what a coordinator needs to see
             from question twelve. -->
        <div
          v-if="isDraft"
          class="evp-toolbar"
          role="group"
          :aria-label="t('forms.page.toolbar.label')"
        >
          <span class="evp-toolbar-status">
            {{ t('forms.page.toolbar.status', { version: version.version }) }}
            <strong v-if="dirty" class="evp-unsaved">{{
              t('forms.page.toolbar.unsaved')
            }}</strong>
            <span v-else class="evp-muted">{{
              t('forms.page.toolbar.allSaved')
            }}</span>
          </span>
          <span class="evp-toolbar-actions">
            <button
              type="button"
              class="evp-button evp-button--primary"
              :disabled="!dirty || save.isPending.value"
              @click="saveDraft"
            >
              {{
                save.isPending.value
                  ? t('common.status.saving')
                  : t('common.actions.save')
              }}
            </button>
            <button
              type="button"
              class="evp-button"
              :disabled="!dirty || save.isPending.value"
              @click="discard"
            >
              {{ t('forms.page.toolbar.discard') }}
            </button>
            <button
              type="button"
              class="evp-button"
              :disabled="
                dirty || blocking.length > 0 || publish.isPending.value
              "
              :aria-describedby="dirty ? 'evp-publish-why' : undefined"
              aria-haspopup="dialog"
              @click="askToPublish"
            >
              {{ t('forms.page.toolbar.publish') }}
            </button>
          </span>
          <span
            v-if="dirty"
            id="evp-publish-why"
            class="evp-muted evp-toolbar-hint"
          >
            {{ t('forms.page.toolbar.publishHint') }}
          </span>
        </div>

        <div v-else class="evp-panel evp-frozen">
          <p>
            <strong>{{
              t('forms.page.frozen.title', {
                version: version.version,
                date: publishedOn(version.published_at ?? ''),
              })
            }}</strong>
            <template v-if="version.id === form.live_version_id">
              {{ t('forms.page.frozen.live') }}
            </template>
            {{ t('forms.page.frozen.explanation') }}
          </p>
          <button
            v-if="draftSummary === null"
            type="button"
            class="evp-button evp-button--primary"
            :disabled="createVersion.isPending.value"
            @click="startNewVersion"
          >
            {{
              createVersion.isPending.value
                ? t('forms.status.creating')
                : t('forms.page.frozen.createVersion')
            }}
          </button>
          <button
            v-else
            type="button"
            class="evp-button"
            @click="selectVersion(draftSummary.version)"
          >
            {{
              t('forms.page.frozen.openDraft', {
                version: draftSummary.version,
              })
            }}
          </button>
        </div>

        <!-- What is wrong, in one place, each line a way to reach the card
             it names. Focusable so a refused save can put the coordinator
             here rather than leave them looking at an unchanged page. -->
        <section
          v-if="isDraft && allProblems.length > 0"
          :id="summaryId"
          class="evp-problems"
          tabindex="-1"
          aria-labelledby="evp-problems-heading"
        >
          <h3 id="evp-problems-heading">
            {{ t('forms.page.summary.heading', { count: allProblems.length }) }}
            <span v-if="blocking.length > 0" class="evp-muted">
              {{ t('forms.page.summary.blocking', { count: blocking.length }) }}
            </span>
          </h3>
          <ul>
            <li
              v-for="(p, i) in allProblems"
              :key="`${p.questionKey}-${p.code}-${i}`"
            >
              <button
                v-if="positionOf(p.questionKey) !== null"
                type="button"
                class="evp-link-button"
                @click="openProblem(p.questionKey)"
              >
                {{
                  t('forms.page.summary.question', {
                    position: positionOf(p.questionKey) ?? 0,
                  })
                }}</button
              ><template v-else>{{ t('forms.page.summary.form') }}</template
              >{{ t('forms.page.summary.separator') }} {{ p.message }}
            </li>
          </ul>
        </section>

        <div
          role="tablist"
          :aria-label="t('forms.page.tabs.label')"
          class="evp-tabs"
        >
          <button
            :id="`${tabsId}-questions`"
            type="button"
            role="tab"
            class="evp-tab"
            :aria-selected="tab === 'questions'"
            :aria-controls="`${tabsId}-questions-panel`"
            :tabindex="tab === 'questions' ? 0 : -1"
            @click="tab = 'questions'"
            @keydown="onTabKey"
          >
            {{ t('forms.page.tabs.questions') }}
          </button>
          <button
            :id="`${tabsId}-preview`"
            type="button"
            role="tab"
            class="evp-tab"
            :aria-selected="tab === 'preview'"
            :aria-controls="`${tabsId}-preview-panel`"
            :tabindex="tab === 'preview' ? 0 : -1"
            @click="tab = 'preview'"
            @keydown="onTabKey"
          >
            {{ t('forms.page.tabs.preview') }}
          </button>
        </div>

        <div
          v-if="tab === 'questions'"
          :id="`${tabsId}-questions-panel`"
          role="tabpanel"
          :aria-labelledby="`${tabsId}-questions`"
        >
          <template v-if="isDraft">
            <p class="evp-field evp-notice">
              <label for="evp-privacy-notice">
                <span>{{ t('forms.page.notice.label') }}</span>
                <input
                  id="evp-privacy-notice"
                  :value="draft.privacyNoticeVersion"
                  type="text"
                  aria-describedby="evp-privacy-notice-hint"
                  @input="setNotice"
                />
              </label>
              <span id="evp-privacy-notice-hint" class="evp-muted evp-small">
                {{ t('forms.page.notice.hint') }}
              </span>
            </p>

            <ol class="evp-questions">
              <li
                v-for="(question, index) in draft.questions"
                :key="question.key"
              >
                <FormQuestionCard
                  :question="question"
                  :index="index"
                  :total="draft.questions.length"
                  :problems="problemsFor(question.key)"
                  :expanded="expanded.has(question.key)"
                  :scope-missions="scopeMissions"
                  :event-names="eventNames"
                  :next-key="nextKey"
                  @update="update(question.key, $event)"
                  @move="(delta) => move(question.key, delta)"
                  @remove="remove(question.key)"
                  @toggle="
                    setExpanded(question.key, !expanded.has(question.key))
                  "
                />
              </li>
            </ol>

            <section
              class="evp-panel evp-palette"
              :aria-labelledby="paletteHeadingId"
            >
              <h3 :id="paletteHeadingId" tabindex="-1">
                {{ t('forms.page.palette.heading') }}
              </h3>
              <div
                role="group"
                aria-labelledby="evp-palette-builtin"
                class="evp-palette-group"
              >
                <h4 id="evp-palette-builtin">
                  {{ t('forms.page.palette.builtin') }}
                </h4>
                <p v-if="palette.length === 0" class="evp-muted evp-small">
                  {{ t('forms.page.palette.allAdded') }}
                </p>
                <button
                  v-for="id in palette"
                  :key="id"
                  type="button"
                  class="evp-button evp-palette-button"
                  @click="addBuiltin(id)"
                >
                  + {{ builtinLabel(id) }}
                </button>
              </div>
              <div
                role="group"
                aria-labelledby="evp-palette-custom"
                class="evp-palette-group"
              >
                <h4 id="evp-palette-custom">
                  {{ t('forms.page.palette.custom') }}
                </h4>
                <button
                  v-for="kind in CUSTOM_KINDS"
                  :key="kind"
                  type="button"
                  class="evp-button evp-palette-button"
                  @click="addCustom(kind)"
                >
                  + {{ kindLabel(kind) }}
                </button>
                <button
                  type="button"
                  class="evp-button evp-palette-button"
                  @click="addCustom('section')"
                >
                  + {{ t('forms.page.palette.section') }}
                </button>
              </div>
            </section>
          </template>

          <!-- Read-only: a published version is what volunteers answered,
               and it is shown as that rather than as a form that refuses to
               save. -->
          <ol v-else class="evp-questions evp-frozen-list">
            <li
              v-for="(question, index) in draft.questions"
              :key="question.key"
              class="evp-panel"
            >
              <p class="evp-frozen-head">
                <span class="evp-muted">{{ index + 1 }}.</span>
                <strong>{{ question.labelFr }}</strong>
                <span class="evp-tag evp-tag--kind">{{
                  kindLabel(question.kind)
                }}</span>
                <span v-if="question.isRequired" class="evp-tag">{{
                  t('forms.tags.required')
                }}</span>
                <span v-if="question.isSensitive" class="evp-tag">{{
                  t('forms.tags.sensitive')
                }}</span>
              </p>
              <p
                v-if="question.labelEn !== ''"
                class="evp-muted evp-small"
                lang="en"
              >
                {{ question.labelEn }}
              </p>
              <p v-if="question.helpFr !== ''" class="evp-small">
                {{ question.helpFr }}
              </p>
              <p v-if="(question.options ?? []).length > 0" class="evp-small">
                {{ (question.options ?? []).map((o) => o.labelFr).join(' · ') }}
              </p>
            </li>
          </ol>
        </div>

        <div
          v-else
          :id="`${tabsId}-preview-panel`"
          role="tabpanel"
          :aria-labelledby="`${tabsId}-preview`"
        >
          <FormPreview
            :questions="draft.questions"
            :events="events"
            :default-locale="form.default_locale"
          />
        </div>
      </template>

      <p v-else>{{ t('common.status.loading') }}</p>
    </template>

    <ConfirmDialog
      :open="confirmingPublish"
      :title="
        t('forms.page.publishDialog.title', {
          version: version?.version ?? '',
        })
      "
      :confirm-label="t('forms.page.publishDialog.confirm')"
      :busy-label="t('forms.page.publishDialog.busy')"
      :cancel-label="t('common.actions.cancel')"
      :busy="publish.isPending.value"
      :error="publishError"
      @confirm="confirmPublish"
      @cancel="confirmingPublish = false"
    >
      <p>
        {{ t('forms.page.publishDialog.body') }}
        <strong>{{ t('forms.page.publishDialog.frozen') }}</strong>
      </p>
      <p>{{ t('forms.page.publishDialog.why') }}</p>
      <template v-if="beforePublish.length > 0">
        <p>{{ t('forms.page.publishDialog.risk') }}</p>
        <ul>
          <li v-for="(p, i) in beforePublish" :key="`${p.code}-${i}`">
            {{ p.message }}
          </li>
        </ul>
      </template>
    </ConfirmDialog>

    <ConfirmDialog
      :open="confirmingLeave"
      :title="t('forms.page.leaveDialog.title')"
      :confirm-label="t('forms.page.leaveDialog.confirm')"
      :busy-label="t('forms.page.leaveDialog.busy')"
      :cancel-label="t('forms.page.leaveDialog.stay')"
      :busy="false"
      @confirm="answer(true)"
      @cancel="answer(false)"
    >
      <p>{{ t('forms.page.leaveDialog.body') }}</p>
    </ConfirmDialog>
  </template>

  <!-- Outside every branch, so an announcement survives the branch that
       caused it being swapped out. -->
  <p class="evp-visually-hidden" aria-live="polite">{{ announcement }}</p>

  <ToastStack>
    <ToastMessage
      v-if="toast !== null"
      :tone="toast.tone"
      dismissible
      :dismiss-label="t('common.actions.close')"
      @dismiss="toast = null"
    >
      <p>{{ toast.text }}</p>
      <p v-if="toast.offerReload">
        <button type="button" class="evp-link-button" @click="reload">
          {{ t('forms.page.toast.reload') }}
        </button>
      </p>
    </ToastMessage>
  </ToastStack>
</template>

<style scoped>
.evp-form-title {
  font-size: 1.25rem;
  margin: 0 0 1rem;
}

.evp-muted {
  color: var(--evp-text-muted);
}

.evp-small {
  font-size: 0.875rem;
}

.evp-covered,
.evp-frozen {
  margin-bottom: 1.5rem;
  max-width: 48rem;
}

.evp-covered p,
.evp-frozen p {
  margin: 0 0 0.75rem;
}

.evp-error-panel {
  background: var(--evp-surface);
  border: 1px solid var(--evp-danger);
  border-left-width: 4px;
  border-radius: 0.375rem;
  color: var(--evp-danger);
  margin: 0 0 1rem;
  max-width: 60ch;
  padding: 0.75rem;
}

.evp-form-picker select,
.evp-notice input {
  max-width: 24rem;
}

.evp-form-picker select {
  background: var(--evp-surface);
  border: 1px solid var(--evp-border);
  border-radius: 0.375rem;
  color: var(--evp-text);
  display: block;
  font: inherit;
  min-height: 2.75rem;
  padding: 0.5rem 0.75rem;
  width: 100%;
}

.evp-versions {
  margin-bottom: 1.5rem;
}

.evp-versions h3 {
  font-size: 1rem;
  margin: 0 0 0.5rem;
}

.evp-versions ol {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  list-style: none;
  margin: 0;
  padding: 0;
}

.evp-version {
  align-items: center;
  background: var(--evp-surface);
  border: 1px solid var(--evp-border);
  border-radius: 0.375rem;
  color: var(--evp-text);
  cursor: pointer;
  display: inline-flex;
  flex-wrap: wrap;
  font: inherit;
  font-size: 0.9375rem;
  gap: 0.375rem;
  min-height: 2.5rem;
  padding: 0.375rem 0.75rem;
}

.evp-version:hover {
  border-color: var(--evp-accent);
}

/* The version on screen: fill, border and weight, never colour alone
   (docs/14 §2). */
.evp-version[aria-current='true'] {
  background: color-mix(in srgb, var(--evp-accent) 10%, var(--evp-surface));
  border-color: var(--evp-accent);
  border-width: 2px;
  font-weight: 600;
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

.evp-tag--live {
  border-color: var(--evp-success);
  color: var(--evp-text);
  font-weight: 600;
}

.evp-toolbar {
  align-items: center;
  background: var(--evp-surface);
  border-bottom: 1px solid var(--evp-border);
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
  justify-content: space-between;
  margin: 0 0 1rem;
  max-width: 48rem;
  padding: 0.5rem 0;
  position: sticky;
  top: 0;
  z-index: 4;
}

.evp-toolbar-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.evp-toolbar-hint {
  flex: 1 0 100%;
  font-size: 0.875rem;
}

.evp-unsaved {
  color: var(--evp-text);
  text-decoration: underline;
  text-decoration-color: var(--evp-warning);
  text-decoration-thickness: 2px;
  text-underline-offset: 0.2em;
}

.evp-problems {
  border: 1px solid var(--evp-danger);
  border-left-width: 4px;
  border-radius: 0.375rem;
  margin: 0 0 1rem;
  max-width: 48rem;
  padding: 0.75rem 1rem;
}

.evp-problems h3 {
  font-size: 1rem;
  margin: 0 0 0.5rem;
}

.evp-problems ul {
  margin: 0;
  padding-left: 1.25rem;
}

.evp-link-button {
  background: none;
  border: 0;
  color: var(--evp-accent);
  cursor: pointer;
  font: inherit;
  padding: 0;
  text-decoration: underline;
  text-underline-offset: 0.2em;
}

.evp-tabs {
  border-bottom: 1px solid var(--evp-border);
  display: flex;
  gap: 0.25rem;
  margin: 0 0 1rem;
  max-width: 48rem;
}

.evp-tab {
  background: none;
  border: 0;
  border-bottom: 3px solid transparent;
  color: var(--evp-text);
  cursor: pointer;
  font: inherit;
  margin-bottom: -1px;
  min-height: 2.75rem;
  padding: 0.5rem 1rem;
}

.evp-tab[aria-selected='true'] {
  border-bottom-color: var(--evp-accent);
  color: var(--evp-accent);
  font-weight: 600;
}

.evp-notice {
  max-width: 48rem;
}

.evp-questions {
  list-style: none;
  margin: 0 0 1rem;
  padding: 0;
}

.evp-frozen-list li {
  margin-bottom: 0.5rem;
  max-width: 48rem;
}

.evp-frozen-list p {
  margin: 0 0 0.25rem;
}

.evp-frozen-head {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.evp-palette {
  max-width: 48rem;
}

.evp-palette h3 {
  font-size: 1rem;
  margin: 0 0 0.75rem;
}

.evp-palette-group {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.evp-palette-group h4 {
  flex: 1 0 100%;
  font-size: 0.9375rem;
  font-weight: 500;
  margin: 0;
}

.evp-palette-button {
  min-height: 2.25rem;
  padding: 0.375rem 0.875rem;
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
