<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * The logo, as an `<img>`.
 *
 * Deliberately not inlined as SVG markup, which is the usual advice. The mark
 * draws its "EP" with an embedded woff2 in a `data:` URI, and the production
 * CSP is `font-src 'self'` with no `data:` (docker/caddy/Caddyfile) — inlined
 * into the document the letters would be blocked and the mark would ship as
 * two blank half-circles. Referenced as an image the SVG is its own document,
 * the face loads, and the bytes are cached once instead of re-sent inside
 * every HTML response.
 *
 * The file is served from the shared `publicDir` both applications point at,
 * so `BASE_URL` is what makes one component work from `/` in the coordinator
 * bundle and `/f/` in the volunteer form.
 *
 * `label` defaults to empty because the common case is decorative: the mark
 * sits next to the product name, and a screen reader announcing both reads the
 * name twice (docs/14 §2). Pass a label only where the mark stands alone.
 */
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    /** Rendered width in CSS pixels. Height follows the mark's 200×199. */
    size?: number;
    /** Alternative text. Empty — the default — marks it decorative. */
    label?: string;
  }>(),
  { size: 32, label: '' },
);

const source = `${import.meta.env.BASE_URL}logo.svg`;

// Both attributes are set so the browser reserves the right box before the
// file arrives: docs/14 §6 asks for no layout shift, and a logo in a header is
// exactly the element whose late arrival nudges a nav link out from under a
// pointer already moving towards it.
const height = computed(() => Math.round((props.size * 199) / 200));
</script>

<template>
  <img
    class="evp-brand-mark"
    :src="source"
    :alt="label"
    :width="size"
    :height="height"
    decoding="async"
  />
</template>

<style scoped>
.evp-brand-mark {
  display: block;
  /* The mark has a dark half that stays dark in both themes, which is how it
     was drawn. Nothing here recolours it. */
  flex: none;
}
</style>
