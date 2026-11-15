<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * The language choice, shared by both applications.
 *
 * A native `<select>`: one compact control in the header however many
 * languages there are, where a row of toggle buttons grows with each one and
 * pushes the nav onto a second line on a phone. Native rather than a custom
 * menu because the platform already gives it a role, keyboard handling and a
 * touch-sized picker on mobile, which a hand-rolled listbox would have to
 * reproduce (docs/14 §2, semantics before ARIA). Each option is named in its
 * own language and carries its own `lang` (WCAG 3.1.2), because the person
 * looking for it is, by definition, reading a language they would rather not.
 *
 * It only reports the choice. Where the choice is kept differs — the form
 * keeps it in `?lang=` so a shared link carries it (docs/09 §7), the
 * coordinator application keeps it on the device — so that is the caller's.
 */
import { LOCALE_NAMES, LOCALES, type Locale } from '../i18n/index.js';
import { useSharedT } from '../i18n/useSharedT.js';

const props = defineProps<{ current: Locale }>();
const emit = defineEmits<{ select: [locale: Locale] }>();

const t = useSharedT();

/** Parsed against `LOCALES`, not cast: the DOM hands back any string. */
function onChange(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) {
    return;
  }
  const chosen = LOCALES.find((locale) => locale === target.value);
  if (chosen !== undefined && chosen !== props.current) {
    emit('select', chosen);
  }
}
</script>

<template>
  <span class="evp-locale-switcher">
    <!-- Decorative: the select carries the accessible name. -->
    <svg class="evp-locale-globe" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9" />
      <path d="M12 3c-2.5 2.6-3.8 5.6-3.8 9s1.3 6.4 3.8 9" />
    </svg>
    <select
      class="evp-locale-select"
      :aria-label="t('localeSwitcher.label')"
      @change="onChange"
    >
      <option
        v-for="locale in LOCALES"
        :key="locale"
        :value="locale"
        :lang="locale"
        :selected="locale === current"
      >
        {{ LOCALE_NAMES[locale] }}
      </option>
    </select>
    <svg class="evp-locale-chevron" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M5 8l5 5 5-5" />
    </svg>
  </span>
</template>

<style scoped>
/* The icons sit over the select rather than beside it, so the whole pill is
   the select's click target; they ignore the pointer so clicks reach it. */
.evp-locale-switcher {
  align-items: center;
  display: inline-flex;
  position: relative;
}

.evp-locale-select {
  appearance: none;
  background: var(--evp-surface-raised);
  /* Transparent rather than none: under forced-colors this is the only edge
     the control has left. */
  border: 2px solid transparent;
  border-radius: 0.625rem;
  color: var(--evp-text);
  cursor: pointer;
  font: inherit;
  font-size: 0.875rem;
  font-weight: 600;
  /* 24×24 floor from docs/14 §2, with room either side for the two icons. */
  min-height: 2.25rem;
  padding: 0.25rem 2rem 0.25rem 2.125rem;
  transition: border-color 120ms ease;
}

.evp-locale-select:hover {
  border-color: var(--evp-border);
}

.evp-locale-globe,
.evp-locale-chevron {
  color: var(--evp-text-muted);
  fill: none;
  pointer-events: none;
  position: absolute;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.evp-locale-globe {
  height: 1rem;
  left: 0.75rem;
  stroke-width: 1.75;
  width: 1rem;
}

.evp-locale-chevron {
  height: 1rem;
  right: 0.625rem;
  stroke-width: 2;
  width: 1rem;
}
</style>
