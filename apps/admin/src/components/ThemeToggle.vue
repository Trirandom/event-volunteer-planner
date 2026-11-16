<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * Light or dark, overriding the system preference on this device
 * (`theme/preference.ts` says why the device and not the account).
 *
 * One button that flips, not a system/light/dark picker: the language
 * switcher already takes the header's one select, and "follow the system"
 * is what everyone has until they press this, which is the case that matters.
 * Its name is the action ("Switch to dark theme") rather than a state with
 * `aria-pressed`, because "Dark theme, not pressed" makes a listener work out
 * what the page currently looks like from a negative.
 */
import type { ThemeName } from '@evp/shared';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { t } from '../i18n';
import {
  applyTheme,
  DARK_QUERY,
  opposite,
  storeTheme,
  storedTheme,
  systemTheme,
} from '../theme/preference';

const chosen = ref<ThemeName | null>(storedTheme());
const system = ref<ThemeName>(systemTheme());
const shown = computed(() => chosen.value ?? system.value);
const label = computed(() =>
  shown.value === 'dark' ? t('shell.theme.toLight') : t('shell.theme.toDark'),
);

// While nothing is chosen the page follows the OS through tokens.css on its
// own; this only keeps the button's icon and name in step with it.
const media =
  typeof globalThis.matchMedia === 'function'
    ? globalThis.matchMedia(DARK_QUERY)
    : null;

function onSystemChange(): void {
  system.value = systemTheme();
}

onMounted(() => {
  media?.addEventListener('change', onSystemChange);
});

onBeforeUnmount(() => {
  media?.removeEventListener('change', onSystemChange);
});

function toggle(): void {
  const next = opposite(shown.value);
  chosen.value = next;
  storeTheme(next);
  applyTheme(next);
}
</script>

<template>
  <button
    type="button"
    class="evp-theme-toggle"
    :aria-label="label"
    :title="label"
    @click="toggle"
  >
    <!-- The icon is where pressing takes you, matching the name. -->
    <svg v-if="shown === 'dark'" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path
        d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
      />
    </svg>
    <svg v-else viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z" />
    </svg>
  </button>
</template>

<style scoped>
/* The locale switcher's ground, edge and height, so the two controls at the
   header's end read as a pair; square because it holds only an icon. */
.evp-theme-toggle {
  align-items: center;
  background: var(--evp-surface-raised);
  /* Transparent rather than none: under forced-colors this is the only edge
     the control has left. */
  border: var(--evp-edge) solid transparent;
  border-radius: var(--evp-radius-md);
  color: var(--evp-text-muted);
  cursor: pointer;
  display: inline-flex;
  justify-content: center;
  /* Above the 24×24 floor (docs/14 §2), and as tall as the switcher. */
  min-height: 2.25rem;
  min-width: 2.25rem;
  padding: 0;
  transition:
    border-color var(--evp-duration) ease,
    color var(--evp-duration) ease;
}

.evp-theme-toggle:hover {
  border-color: var(--evp-border);
  color: var(--evp-text);
}

.evp-theme-toggle svg {
  fill: none;
  height: 1.125rem;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.75;
  width: 1.125rem;
}
</style>
