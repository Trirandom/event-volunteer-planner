<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
import { t } from '../i18n';
</script>

<template>
  <!-- docs/09 §5 — one generic page for an unknown slug and a revoked token
       alike. Distinguishing them would let anyone enumerate the campaigns an
       organisation is running. -->
  <div class="evp-unavailable">
    <h1>{{ t('unavailable.title') }}</h1>
    <p>{{ t('unavailable.body') }}</p>
  </div>
</template>

<style scoped>
/* A warning rather than an error: nothing has gone wrong that the volunteer
   could have avoided, and colouring this coral would tell them they had made a
   mistake. The left border carries it alongside the wording, so the meaning
   does not rest on the colour (docs/14 §2). */
.evp-unavailable {
  background: var(--evp-surface-raised);
  border: 1px solid var(--evp-border);
  border-left: 4px solid var(--evp-warning);
  border-radius: 0.5rem;
  padding: 1.25rem;
}

h1 {
  font-size: 1.25rem;
  margin: 0 0 0.5rem;
}

p {
  color: var(--evp-text-muted);
  margin: 0;
  max-width: 60ch;
}
</style>
