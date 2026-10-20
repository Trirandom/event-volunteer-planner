<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * The schedule email's template, written as rich text (ADR-0046).
 *
 * What it may contain is decided by `plan/emailEditor.ts`; this is the
 * toolbar and the wiring. The value in and out is the stored HTML, so the
 * page's preview, table and draft storage are unchanged by it.
 *
 * The toolbar is a labelled group of ordinary buttons, not an ARIA
 * `toolbar`: that role promises arrow-key navigation between the buttons,
 * and a promise half-kept is worse for a screen-reader user than a plain
 * tab order. Every button has the editor's own shortcut too.
 *
 * The buttons cancel `mousedown`, so a click leaves focus and the caret in
 * the text. Without that, focus goes to the button and comes back a frame
 * later, and whatever is typed in between lands outside the editor.
 */
import { EditorContent, useEditor } from '@tiptap/vue-3';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

import { t } from '../i18n';
import {
  emailExtensions,
  emailHtml,
  insertVariable,
  templateForEditor,
} from '../plan/emailEditor';

const props = defineProps<{
  modelValue: string;
  id: string;
  labelledby: string;
  describedby: string;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

/** What this editor last wrote. A value coming back equal to it is our own
 * echo, and reloading it would throw the caret to the start. */
let written = props.modelValue;

function attributes(): Record<string, string> {
  return {
    id: props.id,
    role: 'textbox',
    'aria-multiline': 'true',
    'aria-labelledby': props.labelledby,
    'aria-describedby': props.describedby,
    class: 'evp-editor',
  };
}

const editor = useEditor({
  extensions: emailExtensions(),
  content: templateForEditor(props.modelValue),
  editorProps: { attributes: attributes() },
  onUpdate: ({ editor: current }) => {
    written = emailHtml(current);
    emit('update:modelValue', written);
  },
});

watch(
  () => props.modelValue,
  (value) => {
    if (value !== written && editor.value !== undefined) {
      written = value;
      editor.value.commands.setContent(templateForEditor(value), {
        emitUpdate: false,
      });
    }
  },
);

watch(
  () => [props.id, props.labelledby, props.describedby],
  () => {
    editor.value?.setOptions({ editorProps: { attributes: attributes() } });
  },
);

onBeforeUnmount(() => {
  editor.value?.destroy();
});

type Mark = 'bold' | 'italic' | 'underline';
type List = 'bulletList' | 'orderedList';

function isActive(name: Mark | List | 'link'): boolean {
  return editor.value?.isActive(name) ?? false;
}

function toggleMark(name: Mark): void {
  const chain = editor.value?.chain().focus();
  if (name === 'bold') {
    chain?.toggleBold().run();
  } else if (name === 'italic') {
    chain?.toggleItalic().run();
  } else {
    chain?.toggleUnderline().run();
  }
}

function toggleList(name: List): void {
  const chain = editor.value?.chain().focus();
  if (name === 'bulletList') {
    chain?.toggleBulletList().run();
  } else {
    chain?.toggleOrderedList().run();
  }
}

const canUndo = computed(() => editor.value?.can().undo() ?? false);
const canRedo = computed(() => editor.value?.can().redo() ?? false);

function undo(): void {
  editor.value?.chain().focus().undo().run();
}

function redo(): void {
  editor.value?.chain().focus().redo().run();
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

const linkOpen = ref(false);
const linkUrl = ref('');
const linkInvalid = ref(false);
const linkInput = ref<HTMLInputElement | null>(null);

async function openLink(): Promise<void> {
  const href: unknown = editor.value?.getAttributes('link')['href'];
  linkUrl.value = typeof href === 'string' ? href : '';
  linkInvalid.value = false;
  linkOpen.value = true;
  await nextTick();
  linkInput.value?.focus();
}

function closeLink(): void {
  linkOpen.value = false;
  editor.value?.commands.focus();
}

function applyLink(): void {
  const href = linkUrl.value.trim();
  const chain = editor.value?.chain().focus().extendMarkRange('link');
  if (href === '') {
    chain?.unsetLink().run();
    linkOpen.value = false;
    return;
  }
  // `setLink` refuses a URL the schema does not allow; saying so beats a
  // button that silently does nothing.
  if (chain?.setLink({ href }).run() === true) {
    linkOpen.value = false;
  } else {
    linkInvalid.value = true;
  }
}

function removeLink(): void {
  editor.value?.chain().focus().extendMarkRange('link').unsetLink().run();
  linkOpen.value = false;
}

function onLinkKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeLink();
  }
}

// ---------------------------------------------------------------------------
// Placeholders, inserted from the page's own buttons
// ---------------------------------------------------------------------------

function insert(inner: string): void {
  const current = editor.value;
  if (current === undefined) {
    return;
  }
  current.commands.focus();
  insertVariable(current, inner);
}

defineExpose({ insert });
</script>

<template>
  <div class="evp-rich">
    <div
      class="evp-format"
      role="group"
      :aria-label="t('emails.editor.toolbar')"
    >
      <button
        type="button"
        class="evp-tool"
        :aria-pressed="isActive('bold')"
        :aria-label="t('emails.editor.bold')"
        :title="t('emails.editor.bold')"
        aria-keyshortcuts="Control+B Meta+B"
        @mousedown.prevent
        @click="toggleMark('bold')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            d="M7 5h6a3.5 3.5 0 0 1 0 7H7zm0 7h7a3.5 3.5 0 0 1 0 7H7z"
            fill="none"
            stroke="currentColor"
            stroke-width="2.25"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <button
        type="button"
        class="evp-tool"
        :aria-pressed="isActive('italic')"
        :aria-label="t('emails.editor.italic')"
        :title="t('emails.editor.italic')"
        aria-keyshortcuts="Control+I Meta+I"
        @mousedown.prevent
        @click="toggleMark('italic')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            d="M10 5h8M6 19h8M14 5l-4 14"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          />
        </svg>
      </button>
      <button
        type="button"
        class="evp-tool"
        :aria-pressed="isActive('underline')"
        :aria-label="t('emails.editor.underline')"
        :title="t('emails.editor.underline')"
        aria-keyshortcuts="Control+U Meta+U"
        @mousedown.prevent
        @click="toggleMark('underline')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            d="M7 4v7a5 5 0 0 0 10 0V4M5 20h14"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          />
        </svg>
      </button>

      <span class="evp-tool-gap" aria-hidden="true"></span>

      <button
        type="button"
        class="evp-tool"
        :aria-pressed="isActive('bulletList')"
        :aria-label="t('emails.editor.bulletList')"
        :title="t('emails.editor.bulletList')"
        aria-keyshortcuts="Control+Shift+8 Meta+Shift+8"
        @mousedown.prevent
        @click="toggleList('bulletList')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            d="M10 6h10M10 12h10M10 18h10"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          />
          <circle cx="5" cy="6" r="1.5" fill="currentColor" />
          <circle cx="5" cy="12" r="1.5" fill="currentColor" />
          <circle cx="5" cy="18" r="1.5" fill="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        class="evp-tool"
        :aria-pressed="isActive('orderedList')"
        :aria-label="t('emails.editor.orderedList')"
        :title="t('emails.editor.orderedList')"
        aria-keyshortcuts="Control+Shift+7 Meta+Shift+7"
        @mousedown.prevent
        @click="toggleList('orderedList')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            d="M10 6h10M10 12h10M10 18h10M4 5l1.5-1v4M3.5 14.5a1.5 1.5 0 1 1 2.6 1L3.5 19h3"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>

      <span class="evp-tool-gap" aria-hidden="true"></span>

      <button
        type="button"
        class="evp-tool"
        :aria-pressed="isActive('link')"
        :aria-expanded="linkOpen"
        aria-controls="emails-link-form"
        :aria-label="t('emails.editor.link')"
        :title="t('emails.editor.link')"
        @mousedown.prevent
        @click="openLink"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          />
        </svg>
      </button>

      <span class="evp-tool-gap" aria-hidden="true"></span>

      <button
        type="button"
        class="evp-tool"
        :disabled="!canUndo"
        :aria-label="t('emails.editor.undo')"
        :title="t('emails.editor.undo')"
        aria-keyshortcuts="Control+Z Meta+Z"
        @mousedown.prevent
        @click="undo"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <button
        type="button"
        class="evp-tool"
        :disabled="!canRedo"
        :aria-label="t('emails.editor.redo')"
        :title="t('emails.editor.redo')"
        aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z"
        @mousedown.prevent
        @click="redo"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            d="m15 14 5-5-5-5M20 9H10a6 6 0 0 0 0 12h3"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    </div>

    <form
      v-if="linkOpen"
      id="emails-link-form"
      class="evp-link-form"
      @submit.prevent="applyLink"
    >
      <label class="evp-link-field" for="emails-link-url">
        <span class="evp-muted">{{ t('emails.editor.linkUrl') }}</span>
        <input
          id="emails-link-url"
          ref="linkInput"
          v-model="linkUrl"
          type="url"
          class="evp-link-input"
          inputmode="url"
          :placeholder="t('emails.editor.linkPlaceholder')"
          :aria-invalid="linkInvalid"
          :aria-describedby="linkInvalid ? 'emails-link-invalid' : undefined"
          @input="linkInvalid = false"
          @keydown="onLinkKeydown"
        />
      </label>
      <button type="submit" class="evp-button evp-button--small">
        {{ t('emails.editor.linkApply') }}
      </button>
      <button
        v-if="isActive('link')"
        type="button"
        class="evp-button evp-button--small"
        @click="removeLink"
      >
        {{ t('emails.editor.linkRemove') }}
      </button>
      <button
        type="button"
        class="evp-button evp-button--small"
        @click="closeLink"
      >
        {{ t('emails.editor.linkCancel') }}
      </button>
      <p
        v-if="linkInvalid"
        id="emails-link-invalid"
        class="evp-link-invalid"
        role="alert"
      >
        {{ t('emails.editor.linkInvalid') }}
      </p>
    </form>

    <EditorContent v-if="editor !== undefined" :editor="editor" />
  </div>
</template>

<style scoped>
.evp-rich {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.evp-format {
  align-items: center;
  background: var(--evp-surface-raised);
  border: 1px solid var(--evp-border);
  border-radius: 0.375rem;
  display: flex;
  flex-wrap: wrap;
  gap: 0.125rem;
  padding: 0.25rem;
}

.evp-tool {
  align-items: center;
  background: none;
  border: 1px solid transparent;
  border-radius: 0.25rem;
  color: var(--evp-text);
  cursor: pointer;
  display: inline-flex;
  height: 2rem;
  justify-content: center;
  width: 2rem;
}

.evp-tool svg {
  height: 1.125rem;
  width: 1.125rem;
}

.evp-tool:hover:not(:disabled) {
  border-color: var(--evp-accent);
}

/* Pressed is told by the border and the fill, not by colour alone
   (docs/14 §2). */
.evp-tool[aria-pressed='true'] {
  background: var(--evp-surface);
  border-color: var(--evp-text);
}

/* Forced colours repaint every border, the transparent ones included, so a
   border cannot say "pressed" there; the system highlight can. */
@media (forced-colors: active) {
  .evp-tool[aria-pressed='true'] {
    background: Highlight;
    color: HighlightText;
    forced-color-adjust: none;
  }
}

.evp-tool:disabled {
  cursor: default;
  opacity: 0.4;
}

.evp-tool-gap {
  background: var(--evp-border);
  height: 1.25rem;
  margin: 0 0.25rem;
  width: 1px;
}

.evp-link-form {
  align-items: flex-end;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.evp-link-field {
  display: flex;
  flex: 1 1 16rem;
  flex-direction: column;
  font-size: 0.875rem;
  gap: 0.25rem;
}

.evp-link-input {
  background: var(--evp-surface);
  border: 1px solid var(--evp-border);
  border-radius: 0.375rem;
  color: var(--evp-text);
  font: inherit;
  min-height: 2.25rem;
  padding: 0.25rem 0.5rem;
}

.evp-link-input[aria-invalid='true'] {
  border-color: var(--evp-danger);
}

.evp-link-invalid {
  color: var(--evp-danger);
  flex-basis: 100%;
  font-size: 0.875rem;
  margin: 0;
}

.evp-muted {
  color: var(--evp-text-muted);
}

.evp-button--small {
  font-size: 0.875rem;
  min-height: 2.25rem;
  padding: 0.375rem 0.875rem;
}

/* The editable area, rendered by ProseMirror outside this component's
   scope. It reads like the message, not like code: the preview beside it is
   the faithful rendering, this only has to be close. */
.evp-rich :deep(.evp-editor) {
  background: var(--evp-surface);
  border: 1px solid var(--evp-border);
  border-radius: 0.375rem;
  color: var(--evp-text);
  line-height: 1.5;
  min-height: 24rem;
  overflow-wrap: anywhere;
  padding: 0.75rem;
  white-space: pre-wrap;
}

.evp-rich :deep(.evp-editor:focus-visible) {
  outline: 2px solid var(--evp-accent);
  outline-offset: 2px;
}

.evp-rich :deep(.evp-editor p) {
  margin: 0 0 0.75rem;
}

/* Tailwind's preflight removes list markers; a list in the message has
   them, so the editor shows them too. */
.evp-rich :deep(.evp-editor ul),
.evp-rich :deep(.evp-editor ol) {
  margin: 0 0 0.75rem;
  padding-left: 1.5rem;
}

.evp-rich :deep(.evp-editor ul) {
  list-style: disc;
}

.evp-rich :deep(.evp-editor ol) {
  list-style: decimal;
}

.evp-rich :deep(.evp-editor li p) {
  margin: 0;
}

.evp-rich :deep(.evp-editor a) {
  color: var(--evp-accent);
  text-decoration: underline;
}

/* A placeholder reads as one thing, because it is one: it is deleted and
   moved whole. */
.evp-rich :deep([data-evp-variable]) {
  background: var(--evp-surface-raised);
  border: 1px solid var(--evp-border);
  border-radius: 999px;
  font-family: ui-monospace, monospace;
  font-size: 0.8125em;
  padding: 0 0.375rem;
  white-space: nowrap;
}

.evp-rich :deep(div[data-evp-variable]) {
  border-radius: 0.375rem;
  border-style: dashed;
  display: block;
  margin: 0 0 0.75rem;
  padding: 0.5rem 0.75rem;
}

.evp-rich :deep(.ProseMirror-selectednode) {
  outline: 2px solid var(--evp-accent);
}
</style>
