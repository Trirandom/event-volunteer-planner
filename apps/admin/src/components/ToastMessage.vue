<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * One message in a `ToastStack`.
 *
 * `danger` is `role="alert"` — something went wrong and the coordinator should
 * hear it now. `info` is `role="status"` — the page reporting what it did with
 * a gesture, not interrupting over it. Colour is never the only difference:
 * the danger tone also carries a heavier left edge.
 */
import { computed } from 'vue';

import { t } from '../i18n';

const props = withDefaults(
  defineProps<{
    readonly tone?: 'danger' | 'info';
    /** Shows a × button; omit for a message only its cause can clear, such
     * as a load that is still failing. */
    readonly dismissible?: boolean;
    /** Unset, it follows the interface language rather than a literal
     * default frozen in one. */
    readonly dismissLabel?: string | undefined;
  }>(),
  { tone: 'info', dismissible: false, dismissLabel: undefined },
);

const dismissLabel = computed(
  () => props.dismissLabel ?? t('ui.toast.dismiss'),
);

defineEmits<{ dismiss: [] }>();
</script>

<template>
  <div
    :role="tone === 'danger' ? 'alert' : 'status'"
    class="evp-toast"
    :class="`evp-toast--${tone}`"
  >
    <div class="evp-toast-body"><slot /></div>
    <button
      v-if="dismissible"
      type="button"
      class="evp-toast-dismiss"
      @click="$emit('dismiss')"
    >
      <span aria-hidden="true">×</span>
      <span class="evp-visually-hidden">{{ dismissLabel }}</span>
    </button>
  </div>
</template>

<style scoped>
.evp-toast {
  align-items: flex-start;
  background: var(--evp-surface);
  border: 1px solid var(--evp-accent);
  border-left-width: 4px;
  border-radius: 0.375rem;
  box-shadow: 0 0.25rem 0.75rem rgb(0 0 0 / 20%);
  color: var(--evp-text);
  display: flex;
  font-size: 0.875rem;
  gap: 0.5rem;
  justify-content: space-between;
  padding: 0.625rem 0.75rem;
}

.evp-toast--danger {
  border-color: var(--evp-danger);
  border-left-width: 6px;
  color: var(--evp-danger);
}

.evp-toast-body :deep(p) {
  margin: 0;
}

.evp-toast-body :deep(p + p) {
  margin-top: 0.25rem;
}

.evp-toast-body :deep(kbd) {
  background: var(--evp-surface-raised);
  border: 1px solid var(--evp-border);
  border-radius: 0.25rem;
  font-size: 0.75rem;
  padding: 0 0.25rem;
}

.evp-toast-dismiss {
  background: transparent;
  border: 0;
  border-radius: 0.25rem;
  color: inherit;
  cursor: pointer;
  flex: 0 0 auto;
  font-size: 1rem;
  height: 1.5rem;
  line-height: 1;
  padding: 0;
  width: 1.5rem;
}

.evp-toast-dismiss:hover,
.evp-toast-dismiss:focus-visible {
  background: var(--evp-surface-raised);
}

.evp-visually-hidden {
  clip-path: inset(50%);
  height: 1px;
  overflow: hidden;
  position: absolute;
  white-space: nowrap;
  width: 1px;
}

@media (forced-colors: active) {
  .evp-toast {
    border-color: CanvasText;
  }
}
</style>
