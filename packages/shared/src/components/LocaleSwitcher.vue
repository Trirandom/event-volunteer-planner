<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * The language choice, shared by both applications.
 *
 * Two toggle buttons rather than a `<select>`: with two languages a menu
 * hides the only other option behind a click, and a button is a 24×24 target
 * a phone can hit (docs/14 §2). Each is named in its own language and carries
 * its own `lang` (WCAG 3.1.2), because the person looking for it is, by
 * definition, reading a language they would rather not.
 *
 * It only reports the choice. Where the choice is kept differs — the form
 * keeps it in `?lang=` so a shared link carries it (docs/09 §7), the
 * coordinator application keeps it on the device — so that is the caller's.
 */
import { LOCALE_NAMES, LOCALES, type Locale } from '../i18n/index.js';
import { useSharedT } from '../i18n/useSharedT.js';

defineProps<{ current: Locale }>();
const emit = defineEmits<{ select: [locale: Locale] }>();

const t = useSharedT();
</script>

<template>
  <div
    class="evp-locale-switcher"
    role="group"
    :aria-label="t('localeSwitcher.label')"
  >
    <button
      v-for="locale in LOCALES"
      :key="locale"
      type="button"
      class="evp-locale-option"
      :lang="locale"
      :aria-pressed="locale === current"
      @click="emit('select', locale)"
    >
      {{ LOCALE_NAMES[locale] }}
    </button>
  </div>
</template>

<style scoped>
.evp-locale-switcher {
  display: inline-flex;
  gap: 0.25rem;
}

.evp-locale-option {
  background: none;
  border: 1px solid transparent;
  border-radius: 0.375rem;
  color: var(--evp-accent);
  cursor: pointer;
  font: inherit;
  font-size: 0.875rem;
  min-height: 1.5rem;
  padding: 0.25rem 0.5rem;
  text-decoration: underline;
  text-underline-offset: 0.2em;
}

.evp-locale-option:hover {
  background: var(--evp-surface-raised);
}

/* The current language is marked by more than colour (WCAG 1.4.1): a border
   and no underline, since it is no longer an action. */
.evp-locale-option[aria-pressed='true'] {
  border-color: var(--evp-border);
  color: var(--evp-text);
  cursor: default;
  font-weight: 600;
  text-decoration: none;
}
</style>
