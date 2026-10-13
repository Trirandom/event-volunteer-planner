<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * "Are you sure?", asked in a dialog rather than on the card that asked.
 *
 * The first version of the missions page swapped the trash button for an
 * inline "Yes, remove it / Keep it" strip at the bottom of the card. On a post
 * that was one line tall that strip doubled the card, pushed every card under
 * it down the page, and — on a zone whose field form was open — appeared a
 * screen away from the button that summoned it. A confirmation somebody has
 * to scroll to find is one they confirm without reading.
 *
 * A modal puts the sentence where the eye already is and holds everything
 * else still. `<dialog>` + `showModal()` for the same reasons `HelpModal.vue`
 * gives (focus trap, inert background, `Escape`, focus restored to the
 * trigger on close), plus two that are specific to a destructive question:
 *
 * - **Focus lands on the safe answer.** The cancel button is focused as the
 *   dialog opens, so an `Enter` pressed out of habit keeps the thing rather
 *   than deleting it. Done by hand rather than with `autofocus`, which the
 *   accessibility linter refuses outright and which only fires on the first
 *   `showModal()` in some engines.
 * - **It cannot be dismissed while the write is in flight.** `Escape` and a
 *   backdrop click are ignored while `busy`, since closing the dialog would
 *   not stop the requests and would hide the one place their outcome is
 *   reported.
 *
 * The caller owns `open`, and closes it itself once the write succeeds. On a
 * refusal it passes `error` and leaves the dialog up, so the days that were
 * not removed are named right under the question that tried to remove them.
 */
import { computed, onBeforeUnmount, useId, watch, useTemplateRef } from 'vue';

import { t } from '../i18n';

const props = withDefaults(
  defineProps<{
    readonly open: boolean;
    readonly title: string;
    /** The destructive button's label, e.g. "Remove Bar". A verb and its object
     * rather than "OK", so the button still says what it does when read alone. */
    readonly confirmLabel: string;
    /** What the confirm button says while the write is in flight. */
    readonly busyLabel: string;
    readonly busy: boolean;
    /** Why the last attempt did not (entirely) happen, or `null`. */
    readonly error?: string | null;
    /** The safe answer's label, for a caller whose question wants a more
     * specific one than "Cancel". Unset, it follows the interface language —
     * a literal default here would be frozen in whichever language it was
     * written in. */
    readonly cancelLabel?: string | undefined;
  }>(),
  { error: null, cancelLabel: undefined },
);

const cancelLabel = computed(
  () => props.cancelLabel ?? t('common.actions.cancel'),
);

const emit = defineEmits<{ confirm: []; cancel: [] }>();

const dialog = useTemplateRef<HTMLDialogElement>('dialog');
const cancelButton = useTemplateRef<HTMLButtonElement>('cancelButton');
const titleId = useId();
const bodyId = useId();

watch(
  [() => props.open, dialog],
  ([open, element]) => {
    if (element === null) {
      return;
    }
    if (open && !element.open) {
      element.showModal();
      cancelButton.value?.focus();
    } else if (!open && element.open) {
      element.close();
    }
  },
  { immediate: true },
);

function cancel(): void {
  if (!props.busy) {
    emit('cancel');
  }
}

/** `Escape` fires `cancel` on the dialog and then closes it natively. The
 * native close is always prevented: whether it closes is `open`'s decision,
 * and letting the platform close it behind the prop's back would leave the
 * two disagreeing. */
function onNativeCancel(event: Event): void {
  event.preventDefault();
  cancel();
}

/** A click on the backdrop lands on the dialog itself — see
 * `HelpModal.vue`'s `onDialogClick` for why that is the test for "outside". */
function onDialogClick(event: MouseEvent): void {
  if (event.target === dialog.value) {
    cancel();
  }
}

watch(dialog, (element, previous) => {
  previous?.removeEventListener('cancel', onNativeCancel);
  previous?.removeEventListener('click', onDialogClick);
  element?.addEventListener('cancel', onNativeCancel);
  element?.addEventListener('click', onDialogClick);
});

onBeforeUnmount(() => {
  dialog.value?.removeEventListener('cancel', onNativeCancel);
  dialog.value?.removeEventListener('click', onDialogClick);
});
</script>

<template>
  <dialog
    ref="dialog"
    class="evp-confirm-dialog"
    role="alertdialog"
    :aria-labelledby="titleId"
    :aria-describedby="bodyId"
  >
    <div class="evp-confirm-panel">
      <h2 :id="titleId" class="evp-confirm-title">{{ title }}</h2>
      <div :id="bodyId" class="evp-confirm-body">
        <slot />
      </div>

      <p
        v-if="error !== null && error !== undefined"
        class="evp-confirm-error"
        role="alert"
      >
        {{ error }}
      </p>

      <div class="evp-confirm-actions">
        <button
          ref="cancelButton"
          type="button"
          class="evp-button"
          :disabled="busy"
          @click="cancel"
        >
          {{ cancelLabel }}
        </button>
        <button
          type="button"
          class="evp-button evp-confirm-destroy"
          :disabled="busy"
          @click="emit('confirm')"
        >
          {{ busy ? busyLabel : confirmLabel }}
        </button>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
.evp-confirm-dialog {
  background: transparent;
  border: 0;
  color: var(--evp-text);
  max-height: 100dvh;
  max-width: 100vw;
  padding: 0;
}

.evp-confirm-dialog::backdrop {
  background: rgb(0 0 0 / 55%);
}

.evp-confirm-panel {
  background: var(--evp-surface);
  border: 1px solid var(--evp-border);
  /* The one visual cue that this dialog is not the help text: a danger rule
     across the top, alongside the wording and the button's own colour. */
  border-top: 4px solid var(--evp-danger);
  border-radius: 0.5rem;
  max-height: calc(100dvh - 4rem);
  overflow: auto;
  padding: 1.25rem;
  width: min(32rem, calc(100vw - 2rem));
}

.evp-confirm-title {
  font-size: 1.0625rem;
  margin: 0 0 0.75rem;
}

.evp-confirm-body {
  font-size: 0.9375rem;
  line-height: 1.55;
}

.evp-confirm-body :deep(p) {
  margin: 0 0 0.75rem;
}

.evp-confirm-body :deep(ul) {
  margin: 0 0 0.75rem;
  padding-left: 1.25rem;
}

.evp-confirm-error {
  color: var(--evp-danger);
  margin: 0 0 0.75rem;
}

/* Cancel first in the DOM (and so first in tab order, as well as holding the
   initial focus), destroy last and rightmost — where a dialog's primary action
   is looked for, but never the one `Enter` reaches by default. */
.evp-confirm-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  justify-content: flex-end;
  margin-top: 1rem;
}

.evp-confirm-destroy {
  border-color: var(--evp-danger);
  color: var(--evp-danger);
}

.evp-confirm-destroy:hover {
  border-color: var(--evp-danger);
}

.evp-confirm-destroy[disabled]:hover {
  border-color: var(--evp-danger);
}
</style>
