<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * The choice between several forms of one scope, on the builder and on the
 * publication tab alike. The page owns what choosing means (`useScopeForm`
 * puts it in the URL, where the builder's unsaved-changes guard can refuse
 * it); this only puts the select back when it was refused, since the bound
 * value did not change and Vue would not repaint it.
 */
import type { Form } from '../api/forms';
import { t } from '../i18n';

const props = defineProps<{
  readonly forms: readonly Form[];
  readonly formId: string;
  readonly choose: (id: string) => Promise<boolean>;
}>();

async function onChange(event: globalThis.Event): Promise<void> {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) {
    return;
  }
  if (!(await props.choose(target.value))) {
    target.value = props.formId;
  }
}
</script>

<template>
  <p class="evp-field evp-form-picker">
    <label for="evp-form-picker">
      <span>{{ t('forms.page.picker') }}</span>
      <select id="evp-form-picker" :value="formId" @change="onChange">
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
</template>

<style scoped>
.evp-form-picker select {
  background: var(--evp-surface);
  border: 1px solid var(--evp-border);
  border-radius: var(--evp-radius-md);
  color: var(--evp-text);
  display: block;
  font: inherit;
  max-width: 24rem;
  min-height: 2.75rem;
  padding: 0.5rem 0.75rem;
  width: 100%;
}
</style>
