<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * The schedule email: a template on the left, what it becomes on the right,
 * and underneath, every volunteer with the message they would get.
 *
 * The table is the point of the page. A preview of one message answers "does
 * the template look right"; it does not answer "did Chloé's Sunday end up in
 * her email", and that second question is the one the spreadsheet's mail
 * merge got wrong (docs/01 §"Identity is a lowercased name"). So every
 * recipient is rendered, not a sample.
 *
 * **Nothing is sent from here yet.** Sending is publishing (docs/04
 * §Publishing): it snapshots a roster version, needs an `Idempotency-Key` and
 * goes out through the outbox, none of which the API serves today. A send
 * button calling an endpoint that does not exist would be a button that
 * cannot work, so the page says so instead and does the part that can be done
 * now — the dry run.
 *
 * The template is written as rich text (`EmailTemplateEditor`, ADR-0046) and
 * stored as the HTML it produces, so nobody types a tag to make a word bold.
 *
 * **The preview is a sandboxed `iframe`, never `v-html`.** The editor keeps
 * what it writes to a few tags, but the draft it is rendered from is browser
 * storage, which the schema never sees, and the values poured into it are
 * volunteer data from a public form; `sandbox=""` gives the frame an opaque origin with
 * no scripts, forms or navigation, so neither can reach this page or its
 * session cookie. Values are escaped on the way in (`plan/emails.ts`) all the
 * same — the sandbox protects this page, escaping protects the inbox.
 *
 * The greeting uses the stored name: participations carry `display_name`
 * only, and docs/04 greets with `coalesce(first_name, display_name)`, so
 * `{{firstName}}` falls back exactly as the server will once it knows more.
 */
import { computed, onUnmounted, ref, watch } from 'vue';

import { useMissionBoard, usePlanScope } from '../api/usePlan';
import { useRoster } from '../api/useRoster';
import { useSession } from '../api/useSession';
import EmailTemplateEditor from '../components/EmailTemplateEditor.vue';
import { missionRows, type EventWindow } from '../board/runs';
import { locale, t } from '../i18n';
import { variableHtml } from '../plan/emailEditor';
import {
  assignationsHtml,
  escapeHtml,
  formatLine,
  htmlToText,
  recipientsOf,
  renderTemplate,
  TEMPLATE_VARIABLES,
  unknownPlaceholders,
  type Recipient,
  type TemplateValues,
} from '../plan/emails';
import { narrowToEvent } from '../plan/missions';
import { rosterRows } from '../plan/roster';
import { focusedEventId } from '../plan/scope';
import { foldForSearch } from '../plan/submissionTable';
import { useRouteParam } from '../router/params';
import { Temporal } from '@evp/shared/time';

const orgId = useRouteParam('orgId');
const festivalId = useRouteParam('festivalId');
const eventId = useRouteParam('eventId');

const { scope, isPending: scopePending } = usePlanScope(
  orgId,
  festivalId,
  eventId,
);

function instantOf(iso: string): number {
  return Temporal.Instant.from(iso).epochMilliseconds;
}

const days = computed(() => scope.value?.days ?? []);
const focus = computed(() =>
  scope.value === null ? null : focusedEventId(scope.value),
);

/** Narrowed to one day, only that day's volunteers are written to — the same
 * reading the assignation board gives the day strip. */
const visibleEvents = computed(() => {
  const only = focus.value;
  return only === null
    ? days.value
    : days.value.filter((day) => day.id === only);
});

const {
  board: missionBoard,
  bounds,
  isPending: boardPending,
  locationsFailed,
  shiftsFailed,
} = useMissionBoard(orgId, days);

const {
  participants,
  assignments,
  isPending: rosterPending,
  participantsFailed,
  assignmentsFailed,
} = useRoster(orgId, visibleEvents);

const windows = computed<readonly EventWindow[]>(() =>
  visibleEvents.value.map((day) => ({
    id: day.id,
    name: day.name,
    timezone: day.timezone,
    startMs: instantOf(day.period.start),
    endMs: instantOf(day.period.end),
    version: day.version,
    color: day.color,
    publicStartMs:
      day.public_period === undefined
        ? null
        : instantOf(day.public_period.start),
    publicEndMs:
      day.public_period === undefined ? null : instantOf(day.public_period.end),
  })),
);

const recipients = computed(() => {
  const only = focus.value;
  const board =
    only === null
      ? missionBoard.value
      : narrowToEvent(missionBoard.value, only);
  return recipientsOf(
    rosterRows(
      missionRows(board, windows.value),
      assignments.value,
      participants.value,
      bounds.value,
    ),
    participants.value,
    locale.value,
  );
});

const isPending = computed(
  () => scopePending.value || boardPending.value || rosterPending.value,
);

/** A day that did not load looks exactly like a day with nobody on it, and
 * here that would be an email saying "no shifts" to people who have some. */
const partlyFailed = computed(
  () =>
    locationsFailed.value ||
    shiftsFailed.value ||
    participantsFailed.value ||
    assignmentsFailed.value,
);

const { data: session } = useSession();

const organizationName = computed(() => {
  const value = session.value;
  if (value?.status !== 'authenticated') {
    return '';
  }
  return (
    value.user.memberships.find((m) => m.org_id === orgId.value)?.name ?? ''
  );
});

// ---------------------------------------------------------------------------
// The template
// ---------------------------------------------------------------------------

function token(name: string): string {
  return `{{${name}}}`;
}

/** Follows the language switch until the coordinator edits it — a default
 * nobody chose should not stay French after they asked for English. */
const defaultTemplate = computed(() =>
  t('emails.template.default', {
    firstName: variableHtml('firstName'),
    eventOrFestival: variableHtml('eventName|festivalName'),
    assignations: variableHtml('assignations'),
    organizationName: variableHtml('organizationName'),
  }),
);

/**
 * The draft is kept on this device, per festival or day, and nowhere else.
 *
 * There is no server-side template yet, and losing an hour's wording to a
 * click on the rail is the one failure this page can cheaply prevent. It is a
 * convenience in the same sense as the language preference
 * (`i18n/preference.ts`), and fails as quietly.
 */
const storageKey = computed(
  () =>
    `evp.emails.template.${orgId.value}.${eventId.value === '' ? festivalId.value : eventId.value}`,
);

function readDraft(key: string): string | null {
  try {
    return globalThis.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeDraft(key: string, value: string | null): void {
  try {
    if (value === null) {
      globalThis.localStorage.removeItem(key);
    } else {
      globalThis.localStorage.setItem(key, value);
    }
  } catch {
    // Not remembered on this device; the edit itself still applies.
  }
}

const draft = ref<string | null>(readDraft(storageKey.value));
watch(storageKey, (key) => {
  draft.value = readDraft(key);
});

const template = computed({
  get: () => draft.value ?? defaultTemplate.value,
  set: (value: string) => {
    draft.value = value;
    writeDraft(storageKey.value, value);
  },
});

function resetTemplate(): void {
  draft.value = null;
  writeDraft(storageKey.value, null);
}

const unknown = computed(() => unknownPlaceholders(template.value));

/** What the editor exposes. Written out because a `.vue` file's instance
 * type does not reach the linter's type checker, which reads it as `any`. */
interface TemplateEditor {
  insert: (inner: string) => void;
}

const editor = ref<TemplateEditor | null>(null);

/** The fallback gets a button of its own: typed by hand it is only text
 * until the next load, and the point of the editor is that nobody types
 * braces. */
const INSERTABLE = [...TEMPLATE_VARIABLES, 'eventName|festivalName'] as const;

/** Inserts at the caret rather than at the end: a placeholder belongs in the
 * sentence the coordinator is writing, not after the signature. */
function insertVariable(name: string): void {
  editor.value?.insert(name);
}

/**
 * What the table renders from, a moment behind the editor.
 *
 * Five hundred messages parsed into text on every keystroke is a textarea
 * that stutters; the preview beside it stays live, and the table catches up
 * once typing pauses.
 */
const settledTemplate = ref(template.value);
let settle: ReturnType<typeof setTimeout> | undefined;
watch(template, (value) => {
  clearTimeout(settle);
  settle = setTimeout(() => {
    settledTemplate.value = value;
  }, 250);
});
onUnmounted(() => {
  clearTimeout(settle);
});

// ---------------------------------------------------------------------------
// One recipient's message
// ---------------------------------------------------------------------------

function valuesFor(recipient: Recipient): TemplateValues {
  const current = scope.value;
  return {
    firstName: escapeHtml(recipient.name),
    displayName: escapeHtml(recipient.name),
    eventName: escapeHtml(current?.selected?.name ?? ''),
    festivalName: escapeHtml(current?.festival?.name ?? ''),
    organizationName: escapeHtml(organizationName.value),
    assignations: assignationsHtml(
      recipient.lines,
      formatLine,
      t('emails.message.none'),
    ),
  };
}

const selectedId = ref<string | null>(null);

const selected = computed(
  () =>
    recipients.value.find((r) => r.volunteerId === selectedId.value) ??
    recipients.value[0] ??
    null,
);

/**
 * The frame's whole document. A white page whatever the admin theme, because
 * that is what the message will be read on; the stylesheet stands in for the
 * mail client's defaults, not for the template's own.
 */
function frameDocument(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{background:#fff;color:#1a1a1a;font:15px/1.5 system-ui,sans-serif;margin:1rem;}</style></head><body>${body}</body></html>`;
}

const previewDocument = computed(() =>
  selected.value === null
    ? ''
    : frameDocument(renderTemplate(template.value, valuesFor(selected.value))),
);

const preview = ref<HTMLElement | null>(null);

function onRecipientChange(event: Event): void {
  if (event.target instanceof HTMLSelectElement) {
    selectedId.value = event.target.value;
  }
}

function show(recipient: Recipient): void {
  selectedId.value = recipient.volunteerId;
  preview.value?.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

interface MessageRow {
  readonly recipient: Recipient;
  readonly lines: readonly string[];
  readonly text: string;
}

const rows = computed<readonly MessageRow[]>(() =>
  recipients.value.map((recipient) => ({
    recipient,
    lines: recipient.lines.map(formatLine),
    text: htmlToText(
      renderTemplate(settledTemplate.value, valuesFor(recipient)),
    ),
  })),
);

const nameFilter = ref('');
const onlyEmpty = ref(false);

const visibleRows = computed(() => {
  const wanted = foldForSearch(nameFilter.value);
  return rows.value.filter(
    (row) =>
      (!onlyEmpty.value || row.recipient.lines.length === 0) &&
      (wanted === '' || foldForSearch(row.recipient.name).includes(wanted)),
  );
});
</script>

<template>
  <p v-if="isPending">{{ t('common.status.loading') }}</p>

  <template v-else-if="scope === null">
    <!-- The parent renders the "could not be loaded" alert for this. -->
  </template>

  <template v-else>
    <p class="evp-lede">{{ t('emails.lede') }}</p>
    <p class="evp-notice">{{ t('emails.notSent') }}</p>
    <p v-if="partlyFailed" role="alert" class="evp-error">
      {{ t('emails.loadFailed') }}
    </p>

    <div class="evp-compose">
      <section aria-labelledby="emails-template" class="evp-compose-pane">
        <div class="evp-pane-head">
          <h2 id="emails-template">{{ t('emails.template.heading') }}</h2>
          <button
            type="button"
            class="evp-button evp-button--small"
            :disabled="draft === null"
            @click="resetTemplate"
          >
            {{ t('emails.template.reset') }}
          </button>
        </div>

        <div
          class="evp-variables"
          role="group"
          :aria-label="t('emails.template.variables')"
        >
          <span class="evp-muted">{{ t('emails.template.variables') }}</span>
          <button
            v-for="name in INSERTABLE"
            :key="name"
            type="button"
            class="evp-chip"
            :aria-label="t('emails.template.insert', { name: token(name) })"
            @mousedown.prevent
            @click="insertVariable(name)"
          >
            {{ token(name) }}
          </button>
        </div>

        <div class="evp-editor-field">
          <span id="emails-editor-label" class="evp-editor-label">
            {{ t('emails.template.label') }}
          </span>
          <EmailTemplateEditor
            id="emails-editor"
            ref="editor"
            v-model="template"
            labelledby="emails-editor-label"
            :describedby="
              unknown.length > 0 ? 'emails-hint emails-unknown' : 'emails-hint'
            "
          />
        </div>
        <p id="emails-hint" class="evp-muted evp-hint">
          {{
            t('emails.template.hint', {
              example: token('eventName|festivalName'),
            })
          }}
        </p>
        <p
          v-if="unknown.length > 0"
          id="emails-unknown"
          class="evp-warning-text evp-hint"
          role="status"
        >
          {{
            t('emails.template.unknown', {
              count: unknown.length,
              names: unknown.map(token).join(', '),
            })
          }}
        </p>
      </section>

      <section
        ref="preview"
        aria-labelledby="emails-preview"
        class="evp-compose-pane"
      >
        <div class="evp-pane-head">
          <h2 id="emails-preview">{{ t('emails.preview.heading') }}</h2>
          <label
            v-if="recipients.length > 0"
            class="evp-recipient"
            for="emails-recipient"
          >
            <span class="evp-muted">{{ t('emails.preview.recipient') }}</span>
            <select
              id="emails-recipient"
              class="evp-filter"
              :value="selected?.volunteerId ?? ''"
              @change="onRecipientChange"
            >
              <option
                v-for="recipient in recipients"
                :key="recipient.volunteerId"
                :value="recipient.volunteerId"
              >
                {{ recipient.name }}
              </option>
            </select>
          </label>
        </div>

        <p v-if="selected === null" class="evp-muted">
          {{ t('emails.preview.empty') }}
        </p>
        <iframe
          v-else
          class="evp-frame"
          sandbox=""
          :srcdoc="previewDocument"
          :title="t('emails.preview.frame', { name: selected.name })"
        ></iframe>
      </section>
    </div>

    <section
      v-if="recipients.length > 0"
      aria-labelledby="emails-table"
      class="evp-messages"
    >
      <h2 id="emails-table">{{ t('emails.table.heading') }}</h2>

      <div class="evp-table-toolbar">
        <input
          v-model="nameFilter"
          type="search"
          class="evp-filter evp-filter--name"
          :placeholder="t('emails.table.filter')"
          :aria-label="t('emails.table.filter')"
        />
        <label class="evp-check" for="emails-only-empty">
          <input id="emails-only-empty" v-model="onlyEmpty" type="checkbox" />
          {{ t('emails.table.onlyEmpty') }}
        </label>
        <p class="evp-table-count" role="status" aria-live="polite">
          {{
            t('emails.table.count', {
              shown: visibleRows.length,
              total: rows.length,
            })
          }}
        </p>
      </div>

      <div
        class="evp-table-scroll"
        role="region"
        tabindex="0"
        :aria-label="t('emails.table.region')"
      >
        <table class="evp-table">
          <caption class="evp-visually-hidden">
            {{
              t('emails.table.caption')
            }}
          </caption>
          <thead>
            <tr>
              <th scope="col" class="evp-col-name">
                {{ t('emails.table.columns.name') }}
              </th>
              <th scope="col">{{ t('emails.table.columns.shifts') }}</th>
              <th scope="col">{{ t('emails.table.columns.message') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="visibleRows.length === 0">
              <td colspan="3" class="evp-no-match">
                {{ t('emails.table.noMatch') }}
              </td>
            </tr>
            <tr
              v-for="row in visibleRows"
              :key="row.recipient.volunteerId"
              :class="{
                'evp-row--selected':
                  row.recipient.volunteerId === selected?.volunteerId,
              }"
            >
              <th scope="row" class="evp-col-name evp-name">
                {{ row.recipient.name }}
              </th>
              <td class="evp-shifts">
                <span
                  class="evp-shift-count"
                  :class="{ 'evp-warning-text': row.lines.length === 0 }"
                >
                  {{
                    t('emails.table.shiftCount', { count: row.lines.length })
                  }}
                </span>
                <ul v-if="row.lines.length > 0" class="evp-lines">
                  <li v-for="(text, index) in row.lines" :key="index">
                    {{ text }}
                  </li>
                </ul>
              </td>
              <td class="evp-message">
                <p class="evp-message-text">{{ row.text }}</p>
                <button
                  type="button"
                  class="evp-disclosure"
                  :aria-label="
                    t('emails.table.showLabel', { name: row.recipient.name })
                  "
                  @click="show(row.recipient)"
                >
                  {{ t('emails.table.show') }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </template>
</template>

<style scoped>
.evp-lede {
  color: var(--evp-text-muted);
  margin: 0 0 0.5rem;
  max-width: 60ch;
}

.evp-notice {
  border-left: 4px solid var(--evp-accent);
  margin: 0 0 1rem;
  max-width: 60ch;
  padding: 0.25rem 0 0.25rem 0.75rem;
}

.evp-muted {
  color: var(--evp-text-muted);
}

.evp-error {
  background: var(--evp-surface);
  border: 1px solid var(--evp-danger);
  border-left-width: 4px;
  border-radius: 0.375rem;
  color: var(--evp-danger);
  margin: 0 0 1rem;
  padding: 0.75rem;
}

.evp-warning-text {
  color: var(--evp-warning);
  font-weight: 500;
}

.evp-visually-hidden {
  clip-path: inset(50%);
  height: 1px;
  overflow: hidden;
  position: absolute;
  white-space: nowrap;
  width: 1px;
}

h2 {
  font-size: 1.125rem;
  margin: 0;
}

.evp-button--small {
  font-size: 0.875rem;
  min-height: 2.25rem;
  padding: 0.375rem 0.875rem;
}

/* ── Template and preview ────────────────────────────────────────────────── */

/* Side by side where there is room for both at a readable width, stacked
   otherwise: an editor squeezed to 20 rem beside its preview is two panes
   nobody can use. */
.evp-compose {
  display: grid;
  gap: 1.5rem;
  grid-template-columns: minmax(0, 1fr);
  margin: 0 0 2rem;
}

@media (min-width: 64rem) {
  .evp-compose {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
}

.evp-compose-pane {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  min-width: 0;
}

.evp-pane-head {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
  justify-content: space-between;
  min-height: 2.25rem;
}

.evp-variables {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  font-size: 0.875rem;
  gap: 0.375rem;
}

.evp-chip {
  background: var(--evp-surface-raised);
  border: 1px solid var(--evp-border);
  border-radius: 999px;
  color: var(--evp-text);
  cursor: pointer;
  font-family: ui-monospace, monospace;
  font-size: 0.8125rem;
  min-height: 1.75rem;
  padding: 0.125rem 0.625rem;
}

.evp-chip:hover {
  border-color: var(--evp-accent);
}

.evp-editor-field {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.evp-editor-label {
  font-weight: 600;
}

.evp-hint {
  font-size: 0.875rem;
  margin: 0;
}

.evp-recipient {
  align-items: center;
  display: flex;
  font-size: 0.875rem;
  gap: 0.5rem;
}

.evp-frame {
  background: #fff;
  border: 1px solid var(--evp-border);
  border-radius: 0.375rem;
  flex: 1;
  min-height: 30rem;
  width: 100%;
}

/* ── Table ───────────────────────────────────────────────────────────────── */

.evp-messages {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.evp-table-toolbar {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
}

.evp-table-count {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  margin: 0 0 0 auto;
}

.evp-filter {
  background: var(--evp-surface);
  border: 1px solid var(--evp-border);
  border-radius: 0.375rem;
  color: var(--evp-text);
  font: inherit;
  min-height: 2rem;
  padding: 0.25rem 0.5rem;
}

.evp-filter--name {
  min-width: 14rem;
}

.evp-check {
  align-items: center;
  display: flex;
  font-size: 0.875rem;
  gap: 0.375rem;
}

.evp-table-scroll {
  border: 1px solid var(--evp-border);
  border-radius: 0.5rem;
  max-width: 100%;
  overflow-x: auto;
}

.evp-table {
  border-collapse: separate;
  border-spacing: 0;
  font-size: 0.875rem;
  min-width: 100%;
}

.evp-table th,
.evp-table td {
  border-bottom: 1px solid var(--evp-border);
  padding: 0.5rem 0.75rem;
  text-align: left;
  vertical-align: top;
}

.evp-table thead th {
  background: var(--evp-surface-raised);
  font-weight: 600;
  white-space: nowrap;
}

.evp-col-name {
  background: var(--evp-surface);
  left: 0;
  position: sticky;
  z-index: 1;
}

.evp-table thead .evp-col-name {
  background: var(--evp-surface-raised);
  z-index: 2;
}

.evp-name {
  font-weight: 600;
  min-width: 10rem;
  overflow-wrap: anywhere;
}

/* The row in the preview, marked by a bar as well as the fill so it is not
   told by colour alone (docs/14 §2). */
.evp-row--selected > th,
.evp-row--selected > td {
  background: var(--evp-surface-raised);
}

.evp-row--selected > th {
  box-shadow: inset 4px 0 0 var(--evp-accent);
}

.evp-shifts {
  min-width: 16rem;
}

.evp-shift-count {
  display: block;
  font-weight: 600;
}

.evp-lines {
  font-variant-numeric: tabular-nums;
  margin: 0.25rem 0 0;
  padding-left: 1rem;
}

.evp-message {
  min-width: 20rem;
}

/* Clamped to the part that differs between rows: past eight lines it is the
   template again, which is in the preview above. Visual only — a screen
   reader still reads all of it. */
.evp-message-text {
  -webkit-box-orient: vertical;
  display: -webkit-box;
  -webkit-line-clamp: 8;
  line-clamp: 8;
  margin: 0 0 0.25rem;
  max-width: 60ch;
  overflow: hidden;
  white-space: pre-line;
}

.evp-disclosure {
  background: none;
  border: 0;
  color: var(--evp-accent);
  cursor: pointer;
  font: inherit;
  min-height: 1.5rem;
  padding: 0;
  text-decoration: underline;
  text-underline-offset: 0.15em;
}

.evp-no-match {
  color: var(--evp-text-muted);
  padding: 1.5rem 0.75rem;
  text-align: center;
}
</style>
