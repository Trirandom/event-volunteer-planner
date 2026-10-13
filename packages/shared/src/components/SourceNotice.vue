<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * The AGPL §13 notice. The admin application puts it in its About panel; the
 * public form puts it in its footer (docs/01 §4 S0a). It is a shared primitive
 * because a deployment missing it is out of compliance, and two copies is two
 * places to forget.
 *
 * Removing this component from a fork is a deliberate act, which is the point.
 */
import { computed } from 'vue';

import { useSharedT } from '../i18n/useSharedT.js';
import { useMeta } from '../useMeta.js';

const props = defineProps<{
  productName?: string;
  sourceLabel?: string;
  loadingLabel?: string;
  unavailableLabel?: string;
}>();

// The product name is a name and is not translated.
const productName = computed(
  () => props.productName ?? 'Event Volunteer Planner',
);

const t = useSharedT();
const sourceLabel = computed(
  () => props.sourceLabel ?? t('sourceNotice.source'),
);
const loadingLabel = computed(
  () => props.loadingLabel ?? t('sourceNotice.loading'),
);
const unavailableLabel = computed(
  () => props.unavailableLabel ?? t('sourceNotice.unavailable'),
);

const state = useMeta();
</script>

<template>
  <p class="evp-source-notice">
    <template v-if="state.status === 'ready'">
      <span>
        {{
          t('sourceNotice.version', {
            product: productName,
            version: state.meta.version,
            commit: state.meta.commit,
          })
        }}
      </span>
      —
      <a :href="state.meta.source_url" rel="noopener noreferrer">
        {{ sourceLabel }}
      </a>
    </template>
    <template v-else-if="state.status === 'loading'">
      <span>{{ loadingLabel }}</span>
    </template>
    <template v-else>
      <!-- A failed fetch says so rather than rendering nothing: silence here
           looks identical to an operator who stripped the link. -->
      <span role="status">{{ unavailableLabel }}</span>
    </template>
  </p>
</template>

<style scoped>
.evp-source-notice {
  color: var(--evp-text-muted);
  font-size: 0.8125rem;
  margin: 0;
}

.evp-source-notice a {
  color: var(--evp-accent);
  /* --evp-accent and --evp-text-muted have almost the same luminance (their
     contrast ratio is ~1.15:1), so color alone does not distinguish the link
     from the surrounding text — an underline is what axe's
     link-in-text-block and WCAG 1.4.1 (Use of Color) actually require. */
  text-decoration: underline;
}
</style>
