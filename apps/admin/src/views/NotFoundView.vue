<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<template>
  <div class="evp-not-found">
    <p class="evp-code">{{ t('notFound.code') }}</p>
    <h1>{{ t('notFound.title') }}</h1>
    <p>
      <RouterLink class="evp-link" to="/">{{
        t('notFound.backHome')
      }}</RouterLink>
    </p>
  </div>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router';

import { t } from '../i18n';
</script>

<style scoped>
.evp-not-found {
  max-width: 40ch;
}

/* Decorative: the heading below already says what happened, and a screen
   reader reading "404" before it would only be repeating the heading in
   digits. Kept visible because a coordinator who mistyped a URL recognises it
   faster than a sentence. */
.evp-code {
  color: var(--evp-text-muted);
  font-size: 0.875rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  margin: 0;
}

h1 {
  font-size: 1.5rem;
  letter-spacing: -0.02em;
  margin: 0.25rem 0 1rem;
}

.evp-link {
  color: var(--evp-accent);
  text-decoration: underline;
  text-underline-offset: 0.2em;
}
</style>
