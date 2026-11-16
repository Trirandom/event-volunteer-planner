<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * The form builder: the questions volunteers answer, drafted here (docs/09).
 * Publishing them is the next tab's job (`PlanFormPublicationView.vue`), and
 * which form this scope has is `useScopeForm`'s, shared by both.
 *
 * **Draft, then publish.** Every edit goes into the draft version, which is
 * saved whole (`PUT …/versions/{v}`, an atomic replacement) and can be saved
 * any number of times. Publishing freezes it: a submission is interpreted
 * against the version it answered, forever (docs/09 §2), so a live version is
 * shown read-only and changing it means starting a new draft from it. That is
 * the mechanism, not a restriction, and the page words it that way.
 *
 * **The toolbox sits beside the questions**, not under them: with a dozen
 * cards open the old palette was a scroll away from the place a question was
 * meant to go. An entry is clicked to append, or dragged into the gap it
 * belongs in (`plan/useListDrag.ts`); a card is dragged by its grip, or moved
 * with its buttons and shortcuts.
 *
 * **One draft, held here, saved by itself** (ADR-0048). The cards emit
 * patches; this view owns the `FormDraft` as a history (`plan/draftHistory.ts`,
 * which is what Ctrl/Cmd+Z steps through), decides what is dirty by comparing
 * it with the stored version (`plan/formDraft.ts`), and sends it once edits
 * pause (`plan/useAutosave.ts`). Leaving saves what is pending first, and asks
 * only when it cannot be saved — the route guard for in-app navigation,
 * `beforeunload` for the tab.
 */
import { eventTimeZone, formatDate } from '@evp/shared/intl';
import { Temporal } from '@evp/shared/time';
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  useId,
  useTemplateRef,
  watch,
} from 'vue';
import {
  RouterLink,
  onBeforeRouteLeave,
  onBeforeRouteUpdate,
  type RouteLocationRaw,
} from 'vue-router';

import type { Form, FormWriteRejection } from '../api/forms';
import {
  useCreateFormVersion,
  useFormVersion,
  useMissionOptions,
  useSaveFormVersion,
} from '../api/useForms';
import { useScopeForm } from '../api/useScopeForm';
import { useSession } from '../api/useSession';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import FormPicker from '../components/FormPicker.vue';
import FormQuestionCard from '../components/FormQuestionCard.vue';
import HelpModal from '../components/HelpModal.vue';
import NewFormPanel from '../components/NewFormPanel.vue';
import ToastMessage from '../components/ToastMessage.vue';
import ToastStack from '../components/ToastStack.vue';
import {
  appendQuestion,
  availableBuiltins,
  availablePresets,
  builtinQuestion,
  CUSTOM_KINDS,
  customQuestion,
  draftOf,
  insertQuestion,
  isDirty,
  locateServerProblems,
  moveQuestion,
  patchQuestion,
  placeQuestion,
  positionBase,
  presetQuestion,
  privacyNoticeOf,
  publishProblems,
  removeQuestion,
  saveProblems,
  toInput,
  type BuiltinId,
  type CustomKind,
  type DraftProblem,
  type FormDraft,
  type PresetId,
  type QuestionPatch,
} from '../plan/formDraft';
import { t, locale } from '../i18n';
import {
  adopt,
  canRedo,
  canUndo,
  record,
  redo,
  startHistory,
  undo,
  type DraftHistory,
} from '../plan/draftHistory';
import { builtinLabel, kindLabel, presetLabel } from '../plan/formLabels';
import { useAutosave } from '../plan/useAutosave';
import { useListDrag } from '../plan/useListDrag';
import { useRouteParam } from '../router/params';

const orgId = useRouteParam('orgId');
const festivalId = useRouteParam('festivalId');
const eventId = useRouteParam('eventId');

const {
  page,
  formScope,
  forms,
  formsFailed,
  formId,
  form,
  draftSummary,
  liveSummary,
  isPending,
  chooseForm,
} = useScopeForm(orgId, festivalId, eventId);

const events = computed(() =>
  page.value?.kind === 'own' ? page.value.events : [],
);
const eventNames = computed(
  () => new Map(events.value.map((event) => [event.id, event.name])),
);

// ── The version on screen ───────────────────────────────────────────────────

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

watch([formScope, formId], () => {
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

/** The draft and its undo history. `draft` is the present state; every edit
 * goes through `commit`, so nothing can change the draft without it being a
 * step Ctrl/Cmd+Z can take back. */
const history = shallowRef<DraftHistory<FormDraft> | null>(null);
const draft = computed(() => history.value?.present ?? null);

/** `group` names what was edited, so typing in one field is one undo step
 * (`plan/draftHistory.ts`); a move, an add or a removal passes none. */
function commit(next: FormDraft, group: string | null = null): void {
  history.value =
    history.value === null
      ? startHistory(next)
      : record(history.value, next, group);
}
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
    const current = history.value;
    if (current === null || previous?.id !== next.id) {
      // Another version: its history is not this one's.
      history.value = startHistory(draftOf(next));
      serverProblems.value = [];
      return;
    }
    if (!isDirty(previous, current.present)) {
      history.value = adopt(current, draftOf(next));
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
    commit(
      patchQuestion(draft.value, key, patch),
      `${key}:${Object.keys(patch).sort().join(',')}`,
    );
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
  commit(moved.draft);
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
  commit(next);
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

/** An entry of the toolbox: a built-in the form does not have yet, or one of
 * the kinds a coordinator writes their own question in. */
type ToolboxItem =
  | { readonly kind: 'builtin'; readonly id: BuiltinId }
  | { readonly kind: 'preset'; readonly id: PresetId }
  | { readonly kind: 'custom'; readonly custom: CustomKind | 'section' };

function itemLabel(item: ToolboxItem): string {
  if (item.kind === 'builtin') {
    return builtinLabel(item.id);
  }
  if (item.kind === 'preset') {
    return presetLabel(item.id);
  }
  return item.custom === 'section'
    ? t('forms.page.palette.section')
    : kindLabel(item.custom);
}

/**
 * Adds a toolbox entry, at the end or into a gap. Built-ins are built here
 * rather than when the toolbox renders: the missions question is seeded from
 * the scope's missions as they are at the moment it is added.
 */
function add(item: ToolboxItem, gap: number | null): void {
  const current = draft.value;
  if (current === null) {
    return;
  }
  const key = nextKey();
  const question =
    item.kind === 'builtin'
      ? builtinQuestion(
          item.id,
          key,
          scopeMissions.value ?? [],
          nextKey,
          organizationName.value,
        )
      : item.kind === 'preset'
        ? presetQuestion(item.id, key, nextKey)
        : customQuestion(item.custom, key);
  const next =
    gap === null
      ? appendQuestion(current, question)
      : insertQuestion(current, question, gap);
  commit(next);
  setExpanded(key, true);
  announcement.value =
    gap === null
      ? t('forms.page.announce.added', labelOf(key))
      : t('forms.page.announce.inserted', {
          ...labelOf(key),
          position: next.questions.findIndex((q) => q.key === key) + 1,
          total: next.questions.length,
        });
  void nextTick(() => {
    document.getElementById(`evp-q-${key}-label-fr`)?.focus();
  });
}

function clickItem(item: ToolboxItem): void {
  if (!drag.isDragClick()) {
    add(item, null);
  }
}

// ── Dragging ────────────────────────────────────────────────────────────────

type DragPayload =
  | { readonly kind: 'question'; readonly key: string }
  | { readonly kind: 'new'; readonly item: ToolboxItem };

const list = useTemplateRef<HTMLOListElement>('list');

function dropped(payload: DragPayload, gap: number): void {
  if (payload.kind === 'new') {
    add(payload.item, gap);
    return;
  }
  const current = draft.value;
  const placed =
    current === null ? null : placeQuestion(current, payload.key, gap);
  if (placed === null) {
    return;
  }
  commit(placed.draft);
  announcement.value = t('forms.page.announce.moved', {
    ...labelOf(payload.key),
    position: placed.index + 1,
    total: placed.draft.questions.length,
  });
  void nextTick(() => {
    document.getElementById(`evp-q-${payload.key}-toggle`)?.focus();
  });
}

const drag = useListDrag<DragPayload>({
  list,
  needsColumn: (payload) => payload.kind === 'new',
  drop: dropped,
});

/** Where the drop line is drawn: the gap under the pointer, unless letting go
 * there would leave the card where it is — a line beside the card itself
 * promises a move that will not happen. */
const dropMarker = computed((): number | null => {
  const active = drag.active.value;
  if (active?.gap == null) {
    return null;
  }
  if (active.payload.kind === 'new') {
    return active.gap;
  }
  const { key } = active.payload;
  const from = draft.value?.questions.findIndex((q) => q.key === key) ?? -1;
  return active.gap === from || active.gap === from + 1 ? null : active.gap;
});

const liftedKey = computed(() => {
  const payload = drag.active.value?.payload;
  return payload?.kind === 'question' ? payload.key : null;
});

const ghostLabel = computed(() => {
  const payload = drag.active.value?.payload;
  if (payload === undefined) {
    return '';
  }
  if (payload.kind === 'new') {
    return itemLabel(payload.item);
  }
  const { named, label } = labelOf(payload.key);
  return named === 'yes' ? label : t('forms.card.untitled');
});

function grab(event: PointerEvent, key: string): void {
  drag.press(event, { kind: 'question', key }, { immediate: true });
}

function pressItem(event: PointerEvent, item: ToolboxItem): void {
  drag.press(event, { kind: 'new', item }, { immediate: false });
}

function setNotice(event: globalThis.Event): void {
  if (draft.value !== null && event.target instanceof HTMLInputElement) {
    commit(
      { ...draft.value, privacyNoticeVersion: event.target.value },
      'privacy-notice',
    );
  }
}

// ── Undo ────────────────────────────────────────────────────────────────────

const undoable = computed(
  () => isDraft.value && history.value !== null && canUndo(history.value),
);
const redoable = computed(
  () => isDraft.value && history.value !== null && canRedo(history.value),
);

function undoEdit(): void {
  if (history.value !== null && undoable.value) {
    history.value = undo(history.value);
    announcement.value = t('forms.page.announce.undone');
  }
}

function redoEdit(): void {
  if (history.value !== null && redoable.value) {
    history.value = redo(history.value);
    announcement.value = t('forms.page.announce.redone');
  }
}

/** A field whose own text undo must win: Ctrl+Z while typing a label takes
 * back the last letters, as it does everywhere else (docs/14 §4). */
function isTextEntry(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) {
    return true;
  }
  if (target instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(
      target.type,
    );
  }
  return target instanceof HTMLElement && target.isContentEditable;
}

function onUndoKey(event: KeyboardEvent): void {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) {
    return;
  }
  const key = event.key.toLowerCase();
  const isUndo = key === 'z' && !event.shiftKey;
  const isRedo =
    (key === 'z' && event.shiftKey) || (key === 'y' && !event.shiftKey);
  if (
    (!isUndo && !isRedo) ||
    !isDraft.value ||
    confirmingLeave.value ||
    isTextEntry(event.target)
  ) {
    return;
  }
  event.preventDefault();
  if (isUndo) {
    undoEdit();
  } else {
    redoEdit();
  }
}

/** The built-ins the form lacks, then the pre-written questions: listed
 * together because a coordinator looks for "the licence question" in one
 * place, not by whether it fills a profile field. The card says which it is. */
const builtinItems = computed((): readonly ToolboxItem[] =>
  draft.value === null
    ? []
    : [
        ...availableBuiltins(draft.value, true).map((id): ToolboxItem => ({
          kind: 'builtin',
          id,
        })),
        ...availablePresets(draft.value).map((id): ToolboxItem => ({
          kind: 'preset',
          id,
        })),
      ],
);

const customItems: readonly ToolboxItem[] = [
  ...CUSTOM_KINDS.map((custom) => ({ kind: 'custom' as const, custom })),
  { kind: 'custom', custom: 'section' },
];

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
const createVersion = useCreateFormVersion(orgId);

/** A conflict stopped autosave until the coordinator reloads. */
const halted = ref(false);
/** The last save was refused or did not arrive; the next edit tries again. */
const saveFailed = ref(false);

/** The one sentence for a refusal nothing more specific handles. */
function rejectionText(rejection: FormWriteRejection): string {
  return rejection.reason === 'unavailable'
    ? t('forms.errors.unavailable')
    : rejection.detail;
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
  if (
    saved === null ||
    current === null ||
    value === null ||
    !dirty.value ||
    blocking.value.length > 0
  ) {
    return;
  }

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
    saveFailed.value = false;
    // Only when nothing was typed while the request was in flight; if it
    // was, those edits stay, and they are dirty against what was just saved.
    // The server's copy carries the ids it gave new questions; adopting it is
    // not an undo step.
    if (history.value !== null && history.value.present === current) {
      history.value = adopt(history.value, draftOf(result.value));
    }
    return;
  }

  saveFailed.value = true;
  const { rejection } = result;
  if (rejection.reason === 'conflict') {
    // Autosave stops here: the next save would carry the newer etag and
    // silently overwrite whatever the other tab saved. Reloading is the
    // coordinator's choice to make.
    halted.value = true;
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
          : t('forms.page.toast.saveRefused', {
              count: rejection.problems.length,
            }),
    };
    return;
  }
  toast.value = {
    tone: 'danger',
    text: rejectionText(rejection),
  };
}

const autosave = useAutosave({
  trigger: () => draft.value,
  canSave: () => dirty.value && blocking.value.length === 0 && !halted.value,
  save: saveDraft,
});

/** What the toolbar says about saving, most urgent first. */
const saveStatus = computed(
  (): { readonly text: string; readonly tone: 'ok' | 'busy' | 'problem' } => {
    if (halted.value) {
      return { text: t('forms.page.toolbar.conflict'), tone: 'problem' };
    }
    if (save.isPending.value) {
      return { text: t('common.status.saving'), tone: 'busy' };
    }
    if (!dirty.value) {
      return { text: t('forms.page.toolbar.allSaved'), tone: 'ok' };
    }
    if (blocking.value.length > 0) {
      return {
        text: t('forms.page.toolbar.blocked', { count: blocking.value.length }),
        tone: 'problem',
      };
    }
    if (saveFailed.value && !autosave.waiting.value) {
      return { text: t('forms.page.toolbar.failed'), tone: 'problem' };
    }
    return { text: t('forms.page.toolbar.pending'), tone: 'busy' };
  },
);

async function reload(): Promise<void> {
  toast.value = null;
  const fresh = await refetchVersion();
  if (fresh.data?.ok === true) {
    history.value = startHistory(draftOf(fresh.data.value));
    serverProblems.value = [];
    halted.value = false;
    saveFailed.value = false;
  }
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

/** Saves what is pending, and asks only when that leaves something unsaved —
 * a draft with problems that block saving, or a save that failed. Resolves
 * once the coordinator has answered. */
async function confirmDiscard(): Promise<boolean> {
  if (dirty.value) {
    await autosave.flush();
  }
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
  window.addEventListener('keydown', onUndoKey);
});
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onBeforeUnload);
  window.removeEventListener('keydown', onUndoKey);
});

async function selectVersion(number: number): Promise<void> {
  if (number === versionNumber.value || !(await confirmDiscard())) {
    return;
  }
  chosenVersion.value = number;
  serverProblems.value = [];
}

function created(value: Form): void {
  void chooseForm(value.id);
  chosenVersion.value = null;
  toast.value = {
    tone: 'info',
    text: t('forms.page.toast.formCreated'),
  };
}

// ── Presentation ────────────────────────────────────────────────────────────

function publishedOn(instant: string): string {
  const subject = page.value?.kind === 'own' ? page.value.subject : null;
  return formatDate(Temporal.Instant.from(instant).epochMilliseconds, {
    locale: locale.value,
    timeZone: eventTimeZone(subject?.timezone ?? 'UTC'),
  });
}

/** Newest first: the version a coordinator came for — the draft, or what is
 * live — is the first one read, and v1 drifts right as the history grows. */
const versions = computed(() =>
  [...(form.value?.versions ?? [])].sort((a, b) => b.version - a.version),
);

/** The publication tab at this scope, keeping the chosen form. */
const publication = computed((): RouteLocationRaw => {
  const params =
    eventId.value === ''
      ? { orgId: orgId.value, festivalId: festivalId.value }
      : { orgId: orgId.value, eventId: eventId.value };
  return {
    name:
      eventId.value === ''
        ? 'org-festival-publication'
        : 'org-event-publication',
    params,
    query: forms.value.length > 1 ? { form: formId.value } : {},
  };
});
</script>

<template>
  <p v-if="isPending">{{ t('common.status.loading') }}</p>

  <template v-else-if="page !== null">
    <HelpModal :title="t('forms.page.title')">
      <p>{{ t('forms.page.help.intro') }}</p>
      <p>{{ t('forms.page.help.draft') }}</p>
      <p>{{ t('forms.page.help.undo') }}</p>
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
      <FormPicker
        v-if="forms.length > 1"
        :forms="forms"
        :form-id="formId"
        :choose="chooseForm"
      />

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
        <!-- The draft's own controls, kept in view down a long list: whether
             it is saved, and undo, are what a coordinator needs from question
             twelve. The status is a live region so a screen reader hears a
             save that failed, not only one that was asked for. -->
        <div
          v-if="isDraft"
          class="evp-toolbar"
          role="group"
          :aria-label="t('forms.page.toolbar.label')"
        >
          <span class="evp-toolbar-status" role="status">
            {{ t('forms.page.toolbar.status', { version: version.version }) }}
            <strong v-if="saveStatus.tone === 'problem'" class="evp-unsaved">{{
              saveStatus.text
            }}</strong>
            <span v-else class="evp-muted">{{ saveStatus.text }}</span>
          </span>
          <span class="evp-toolbar-actions">
            <button
              type="button"
              class="evp-icon-button"
              :disabled="!undoable"
              :aria-label="t('forms.page.toolbar.undo')"
              :title="t('forms.page.toolbar.undoHint')"
              aria-keyshortcuts="Control+Z Meta+Z"
              @click="undoEdit"
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
              :aria-label="t('forms.page.toolbar.redo')"
              :title="t('forms.page.toolbar.redoHint')"
              aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y"
              @click="redoEdit"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="m15 14 5-5-5-5" />
                <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
              </svg>
            </button>
            <!-- A link to the tab that publishes, not a publish button: what
                 is published is the saved draft, and leaving saves what is
                 pending on the way there. -->
            <RouterLink class="evp-button" :to="publication">
              {{ t('forms.page.toolbar.toPublication') }}
            </RouterLink>
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

        <div>
          <div
            v-if="isDraft"
            class="evp-builder"
            :class="{ 'evp-builder--dragging': drag.active.value !== null }"
          >
            <div class="evp-builder-main">
              <p class="evp-field evp-privacy">
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
                <span
                  id="evp-privacy-notice-hint"
                  class="evp-muted evp-small evp-privacy-hint"
                >
                  {{ t('forms.page.notice.hint') }}
                </span>
              </p>

              <!-- The drop line is drawn by the gap's own neighbours (the
                   card below it, or the list's end), so it never shifts the
                   cards it falls between. -->
              <ol
                ref="list"
                class="evp-questions"
                :class="{
                  'evp-drop-end':
                    dropMarker !== null &&
                    dropMarker === draft.questions.length,
                }"
              >
                <li
                  v-for="(question, index) in draft.questions"
                  :key="question.key"
                  :class="{
                    'evp-drop-before': dropMarker === index,
                    'evp-lifted': liftedKey === question.key,
                  }"
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
                    @grab="(event) => grab(event, question.key)"
                  />
                </li>
              </ol>
            </div>

            <aside
              class="evp-card evp-toolbox"
              :aria-labelledby="paletteHeadingId"
            >
              <h3 :id="paletteHeadingId" tabindex="-1">
                {{ t('forms.page.palette.heading') }}
              </h3>
              <p class="evp-muted evp-small">
                {{ t('forms.page.palette.hint') }}
              </p>
              <div
                role="group"
                aria-labelledby="evp-palette-builtin"
                class="evp-palette-group"
              >
                <h4 id="evp-palette-builtin">
                  {{ t('forms.page.palette.builtin') }}
                </h4>
                <p v-if="builtinItems.length === 0" class="evp-muted evp-small">
                  {{ t('forms.page.palette.allAdded') }}
                </p>
                <button
                  v-for="item in builtinItems"
                  :key="itemLabel(item)"
                  type="button"
                  class="evp-button evp-palette-button"
                  @pointerdown="pressItem($event, item)"
                  @click="clickItem(item)"
                >
                  <span aria-hidden="true">+</span> {{ itemLabel(item) }}
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
                  v-for="item in customItems"
                  :key="itemLabel(item)"
                  type="button"
                  class="evp-button evp-palette-button"
                  @pointerdown="pressItem($event, item)"
                  @click="clickItem(item)"
                >
                  <span aria-hidden="true">+</span> {{ itemLabel(item) }}
                </button>
              </div>
            </aside>
          </div>

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
      </template>

      <p v-else>{{ t('common.status.loading') }}</p>
    </template>

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

  <!-- What is being carried, under the pointer. Hidden from assistive
       technology: the drag is the pointer path only, and the announcement
       above says where the question landed. -->
  <div
    v-if="drag.active.value !== null"
    class="evp-ghost"
    :class="{ 'evp-ghost--nowhere': drag.active.value.gap === null }"
    :style="{
      left: `${drag.active.value.x}px`,
      top: `${drag.active.value.y}px`,
    }"
    aria-hidden="true"
  >
    {{ ghostLabel }}
  </div>

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

.evp-privacy input {
  max-width: 24rem;
}

/* A block under the input: left inline, its first line sat beside the input
   and the rest wrapped under it. */
.evp-privacy-hint {
  display: block;
  margin-top: 0.25rem;
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
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.evp-icon-button {
  align-items: center;
  background: transparent;
  border: var(--evp-edge) solid var(--evp-border);
  border-radius: var(--evp-radius-md);
  color: var(--evp-text);
  cursor: pointer;
  display: inline-flex;
  height: 2.75rem;
  justify-content: center;
  padding: 0;
  width: 2.75rem;
}

.evp-icon-button:hover:not(:disabled) {
  border-color: var(--evp-accent);
}

.evp-icon-button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.evp-icon-button svg {
  fill: none;
  height: 1.25rem;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 2;
  width: 1.25rem;
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

.evp-builder {
  align-items: flex-start;
  display: flex;
  flex-wrap: wrap;
  gap: 1.5rem;
}

.evp-builder--dragging {
  cursor: grabbing;
  user-select: none;
}

/* The questions keep the reading measure they had; the toolbox takes what is
   left beside them, and drops below them once there is not 14 rem left. */
.evp-builder-main {
  flex: 1 1 32rem;
  max-width: 48rem;
  min-width: 0;
}

/* Sticky under the draft toolbar, so it is beside whichever card a
   coordinator has scrolled to — which is the point of it being aside. */
.evp-toolbox {
  flex: 1 1 14rem;
  max-height: calc(100vh - 6rem);
  max-width: 22rem;
  overflow-y: auto;
  padding: 1rem;
  position: sticky;
  top: 4.5rem;
}

.evp-toolbox h3 {
  font-size: 1rem;
  margin: 0 0 0.25rem;
}

.evp-toolbox > p {
  margin: 0 0 1rem;
}

.evp-palette-group {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  margin-bottom: 1rem;
}

.evp-palette-group h4 {
  font-size: 0.9375rem;
  font-weight: 500;
  margin: 0 0 0.125rem;
}

.evp-palette-button {
  cursor: grab;
  justify-content: flex-start;
  min-height: 2.25rem;
  padding: 0.375rem 0.875rem;
  text-align: left;
}

.evp-builder--dragging .evp-palette-button {
  cursor: grabbing;
}

/* The drop line: a bar in the gap, drawn by the card under it so the list
   does not reflow under the pointer while it is being aimed. */
.evp-questions > li {
  position: relative;
}

.evp-drop-before::before,
.evp-drop-end::after {
  background: var(--evp-accent);
  border-radius: var(--evp-radius-sm);
  content: '';
  height: 4px;
  left: 0;
  max-width: 48rem;
  pointer-events: none;
  position: absolute;
  right: 0;
}

.evp-drop-before::before {
  top: calc(-0.375rem - 2px);
}

.evp-questions.evp-drop-end {
  position: relative;
}

.evp-drop-end::after {
  bottom: calc(0.375rem - 2px);
}

/* The card being carried stays where it was, faded and outlined, so the gap
   it left is visible and letting go anywhere else reads as a move. */
.evp-lifted {
  opacity: 0.45;
}

.evp-ghost {
  background: var(--evp-surface-raised);
  border: var(--evp-edge) solid var(--evp-accent);
  border-radius: var(--evp-radius-md);
  color: var(--evp-text);
  font-weight: 600;
  max-width: 18rem;
  overflow: hidden;
  padding: 0.375rem 0.75rem;
  pointer-events: none;
  position: fixed;
  text-overflow: ellipsis;
  transform: translate(0.75rem, 0.75rem);
  white-space: nowrap;
  z-index: 20;
}

/* Over nothing, letting go drops nothing — said by the dashed edge as well
   as the dimmer fill, not by colour alone. */
.evp-ghost--nowhere {
  border-style: dashed;
  opacity: 0.7;
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
