<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * The form's outline while it loads: a title and three questions, in the
 * places the real ones will take.
 *
 * `index.html` carries a copy of this markup inside `#app`, so the same
 * outline is on screen from the moment the HTML and its stylesheet arrive,
 * before any script has run, and stays put as Vue takes over (docs/01 §5).
 * `shell.test.ts` holds the two copies together. Its styles are in
 * `styles.css`, not scoped here, because the copy has to be styled before
 * this component exists.
 *
 * No words and hidden from assistive technology: what is loading is
 * announced by the caller's status message.
 */
</script>

<template>
  <div class="evp-skeleton" aria-hidden="true">
    <div class="evp-skeleton-title"></div>
    <div class="evp-skeleton-line"></div>
    <div class="evp-skeleton-field"></div>
    <div class="evp-skeleton-field"></div>
    <div class="evp-skeleton-field"></div>
  </div>
</template>
