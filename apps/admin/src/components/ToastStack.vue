<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * Where a page's conditional messages are drawn: a refusal, a load failure,
 * "copied — now paste", "those two stretches merged".
 *
 * Fixed to the viewport rather than in flow. Each of those messages used to be
 * a paragraph above the board, so appearing or clearing pushed every row down
 * or up under a coordinator mid-click. docs/02 §7 still holds — nothing here
 * runs on a timer; a message stays until it is dismissed or its cause goes
 * away — it is only relocated off the board's own flow.
 *
 * Not teleported to `body`: the page's tests find these by role inside the
 * mounted view, and nothing on these pages sets a `transform` that would
 * trap a fixed child.
 */
</script>

<template>
  <div class="evp-toasts">
    <slot />
  </div>
</template>

<style scoped>
.evp-toasts {
  bottom: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  left: 50%;
  max-width: min(calc(100vw - 2rem), 40rem);
  pointer-events: none;
  position: fixed;
  transform: translateX(-50%);
  width: max-content;
  z-index: 20;
}

/* The stack itself is click-through so its empty width never swallows a
   click meant for the board beneath; only the messages catch the pointer. */
.evp-toasts > :deep(*) {
  pointer-events: auto;
}
</style>
