<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * The page's instructions, behind a question mark rather than printed above
 * the thing they describe.
 *
 * Every board page used to open with a paragraph explaining every gesture it
 * supports — twelve lines a coordinator reads once and then scrolls past a
 * hundred times, pushing the board itself below the fold on exactly the pages
 * where vertical room is what the board is short of. The words are worth
 * keeping (nothing else says that a drag snaps to the hour), so they move
 * rather than go: the trigger parks in the corner where help is looked for,
 * and the text is a dialog when it is wanted.
 *
 * `<dialog>` and `showModal()` rather than a hand-rolled overlay: the platform
 * already gives the focus trap, the inert background, `Escape`, and the
 * restoration of focus to the trigger on close — every one of which is a bug
 * we would otherwise write ourselves (docs/14 §3).
 */
import { onBeforeUnmount, ref, watch } from 'vue';

import { t } from '../i18n';

defineProps<{
  /** Names what the instructions are about, e.g. the section's own title. */
  readonly title: string;
}>();

const dialog = ref<HTMLDialogElement | null>(null);

function open(): void {
  dialog.value?.showModal();
}

function close(): void {
  dialog.value?.close();
}

/**
 * A click on the backdrop closes it. The backdrop is not an element of its
 * own, so the event lands on the dialog itself, and anything that hit real
 * content lands on the panel inside instead — so the dialog being the target
 * *is* the test for "outside".
 *
 * Bound here rather than in the template because a `@click` on a `<dialog>`
 * reads to the accessibility linter as a click handler on a plain box; the
 * behaviour is the platform's, not a hand-rolled one, and `Escape` and the
 * close button are the keyboard paths it would otherwise ask for.
 */
function onDialogClick(event: MouseEvent): void {
  if (event.target === dialog.value) {
    close();
  }
}

watch(dialog, (element, previous) => {
  previous?.removeEventListener('click', onDialogClick);
  element?.addEventListener('click', onDialogClick);
});

onBeforeUnmount(() => {
  dialog.value?.removeEventListener('click', onDialogClick);
});
</script>

<template>
  <div class="evp-help">
    <button
      type="button"
      class="evp-help-trigger"
      :aria-label="t('ui.help.trigger', { title })"
      @click="open"
    >
      ?
    </button>

    <dialog ref="dialog" class="evp-help-dialog">
      <div class="evp-help-panel">
        <div class="evp-help-head">
          <h2 class="evp-help-title">{{ title }}</h2>
          <button
            type="button"
            class="evp-help-close"
            :aria-label="t('common.actions.close')"
            @click="close"
          >
            ×
          </button>
        </div>
        <div class="evp-help-body">
          <slot />
        </div>
      </div>
    </dialog>
  </div>
</template>

<style scoped>
/* The trigger is pinned to the top-right of whatever positioned box holds the
   page's content, so it is in the same place on every section — help that
   moves with the layout is help nobody learns where to find. */
.evp-help {
  position: absolute;
  right: 0;
  top: 0;
  z-index: 5;
}

.evp-help-trigger {
  align-items: center;
  background: var(--evp-surface);
  border: 1px solid var(--evp-border);
  border-radius: 999px;
  color: var(--evp-text-muted);
  cursor: pointer;
  display: inline-flex;
  font-size: 0.9375rem;
  font-weight: 600;
  height: 1.75rem;
  justify-content: center;
  line-height: 1;
  padding: 0;
  width: 1.75rem;
}

.evp-help-trigger:hover,
.evp-help-trigger:focus-visible {
  border-color: var(--evp-accent);
  color: var(--evp-accent);
}

.evp-help-dialog {
  background: transparent;
  border: 0;
  color: var(--evp-text);
  max-height: 100dvh;
  max-width: 100vw;
  padding: 0;
}

.evp-help-dialog::backdrop {
  background: rgb(0 0 0 / 55%);
}

.evp-help-panel {
  background: var(--evp-surface);
  border: 1px solid var(--evp-border);
  border-radius: 0.5rem;
  /* Wide enough for a paragraph, capped at a readable measure, and allowed to
     be the whole width of a phone minus its gutter. */
  max-height: calc(100dvh - 4rem);
  overflow: auto;
  padding: 1rem 1.25rem 1.25rem;
  width: min(42rem, calc(100vw - 2rem));
}

.evp-help-head {
  align-items: baseline;
  display: flex;
  gap: 1rem;
  justify-content: space-between;
}

.evp-help-title {
  font-size: 1.0625rem;
  margin: 0 0 0.75rem;
}

.evp-help-close {
  background: none;
  border: 0;
  color: var(--evp-text-muted);
  cursor: pointer;
  font-size: 1.375rem;
  line-height: 1;
  padding: 0 0.25rem;
}

.evp-help-close:hover,
.evp-help-close:focus-visible {
  color: var(--evp-accent);
}

.evp-help-body {
  color: var(--evp-text);
  font-size: 0.9375rem;
  line-height: 1.55;
}

.evp-help-body :deep(p) {
  margin: 0 0 0.75rem;
}

.evp-help-body :deep(p:last-child) {
  margin-bottom: 0;
}

.evp-help-body :deep(kbd) {
  background: var(--evp-surface-raised);
  border: 1px solid var(--evp-border);
  border-radius: 0.25rem;
  font-family: inherit;
  font-size: 0.8125rem;
  padding: 0.0625rem 0.3125rem;
}

.evp-help-body :deep(a) {
  color: var(--evp-accent);
}
</style>
