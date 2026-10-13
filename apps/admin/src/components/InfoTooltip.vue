<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * A question-mark (or custom) trigger that reveals one line of explanation
 * on hover or focus, instead of that explanation sitting under the field
 * permanently.
 *
 * The plain-text explanations these forms used to show under every label
 * were pushing the fields themselves below the fold on a page that already
 * shows a dozen cards at once — see `MissionCard.vue`. Hover/focus rather
 * than click, so it never steals a click that was meant for the field next
 * to it, and `role="tooltip"` plus `aria-describedby` keep it reachable from
 * the field for a screen reader, not just for a mouse.
 */
defineProps<{
  readonly text: string;
  /** Wired to the trigger's `aria-describedby`; must be unique on the page. */
  readonly tooltipId: string;
  /** Falls back to `text` — set this when the trigger's own content (e.g. a
   * day count) does not already say what the tooltip explains. */
  readonly label?: string;
}>();
</script>

<template>
  <span class="evp-tooltip">
    <button
      type="button"
      class="evp-tooltip-trigger"
      :aria-label="label ?? text"
      :aria-describedby="tooltipId"
    >
      <slot>?</slot>
    </button>
    <span :id="tooltipId" role="tooltip" class="evp-tooltip-bubble">{{
      text
    }}</span>
  </span>
</template>

<style scoped>
.evp-tooltip {
  display: inline-flex;
  align-items: center;
  position: relative;
}

/* `min-*` rather than a fixed `height`/`width`: the "?" mark is one glyph and
   stays a small circle, but the same trigger is also reused for a day count
   ("2 days") whose text a fixed box would clip instead of grow for. */
.evp-tooltip-trigger {
  background: var(--evp-surface);
  border: 1px solid var(--evp-border);
  border-radius: 999px;
  color: var(--evp-text-muted);
  cursor: help;
  font-size: 0.6875rem;
  font-weight: 600;
  line-height: 1;
  min-height: 1.125rem;
  min-width: 1.125rem;
  padding: 0.0625rem 0.375rem;
}

.evp-tooltip-trigger:hover,
.evp-tooltip-trigger:focus-visible {
  border-color: var(--evp-accent);
  color: var(--evp-accent);
}

.evp-tooltip-bubble {
  background: var(--evp-text);
  border-radius: 0.375rem;
  bottom: calc(100% + 0.375rem);
  color: var(--evp-surface);
  display: none;
  font-size: 0.8125rem;
  font-weight: 400;
  left: 50%;
  max-width: 22rem;
  padding: 0.5rem 0.625rem;
  position: absolute;
  text-align: left;
  transform: translateX(-50%);
  white-space: normal;
  width: max-content;
  z-index: 10;
}

.evp-tooltip-trigger:hover + .evp-tooltip-bubble,
.evp-tooltip-trigger:focus-visible + .evp-tooltip-bubble,
.evp-tooltip:hover .evp-tooltip-bubble,
.evp-tooltip:focus-within .evp-tooltip-bubble {
  display: block;
}
</style>
