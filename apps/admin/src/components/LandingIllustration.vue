<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * A flat drawing of the shift board, standing in on the landing page until
 * real screenshots exist.
 *
 * Drawn rather than captured because a screenshot of a dev database is either
 * empty or shows names, and the page must never show real volunteer data
 * (CLAUDE.md, "Never commit real volunteer data"). When screenshots of the
 * worked example land, this becomes an `<img>` whose alt text lives in the
 * home catalogue, since a screenshot carries information this drawing does not.
 *
 * Inline SVG rather than a file under `public/`, so each fill can be a theme
 * token and the drawing follows the theme with no second copy.
 * There is no `<text>`: labels would be bare UI strings, and the bars are a
 * picture of a board, not a board.
 */
</script>

<template>
  <!-- Decorative: the heading and the feature list say everything it shows. -->
  <svg
    class="evp-board-art"
    viewBox="0 0 360 248"
    aria-hidden="true"
    focusable="false"
  >
    <rect class="card" width="360" height="248" rx="14" />
    <rect class="chrome" width="360" height="38" rx="14" />
    <rect class="chrome" y="24" width="360" height="14" />
    <circle class="dot dot--a" cx="22" cy="19" r="5" />
    <circle class="dot dot--b" cx="38" cy="19" r="5" />
    <circle class="dot dot--c" cx="54" cy="19" r="5" />

    <!-- The time axis: one tick per two hours. -->
    <g class="tick">
      <rect x="92" y="52" width="2" height="8" />
      <rect x="152" y="52" width="2" height="8" />
      <rect x="212" y="52" width="2" height="8" />
      <rect x="272" y="52" width="2" height="8" />
      <rect x="332" y="52" width="2" height="8" />
    </g>

    <!-- Four posts, each a lane with a name stub and its shifts. -->
    <g class="lane">
      <rect x="16" y="70" width="328" height="34" rx="8" />
      <rect x="16" y="112" width="328" height="34" rx="8" />
      <rect x="16" y="154" width="328" height="34" rx="8" />
      <rect x="16" y="196" width="328" height="34" rx="8" />
    </g>
    <g class="stub">
      <rect x="26" y="83" width="46" height="8" rx="4" />
      <rect x="26" y="125" width="38" height="8" rx="4" />
      <rect x="26" y="167" width="50" height="8" rx="4" />
      <rect x="26" y="209" width="42" height="8" rx="4" />
    </g>

    <rect
      class="shift shift--mark"
      x="92"
      y="76"
      width="118"
      height="22"
      rx="6"
    />
    <rect
      class="shift shift--gold"
      x="216"
      y="76"
      width="96"
      height="22"
      rx="6"
    />
    <rect
      class="shift shift--accent"
      x="122"
      y="118"
      width="150"
      height="22"
      rx="6"
    />
    <rect
      class="shift shift--clay"
      x="92"
      y="160"
      width="58"
      height="22"
      rx="6"
    />
    <rect
      class="shift shift--mark"
      x="156"
      y="160"
      width="86"
      height="22"
      rx="6"
    />
    <rect
      class="shift shift--coral"
      x="248"
      y="160"
      width="88"
      height="22"
      rx="6"
    />
    <rect
      class="shift shift--gold"
      x="92"
      y="202"
      width="134"
      height="22"
      rx="6"
    />
    <rect
      class="shift shift--accent"
      x="232"
      y="202"
      width="72"
      height="22"
      rx="6"
    />

    <!-- "Now", drawn in the focus gold so it reads as neither a shift nor the brand. -->
    <rect class="now" x="244" y="46" width="3" height="190" rx="1.5" />
    <circle class="now" cx="245.5" cy="46" r="5" />
  </svg>
</template>

<style scoped>
.evp-board-art {
  display: block;
  height: auto;
  width: 100%;
}

.card {
  fill: var(--evp-surface);
}

.chrome,
.lane {
  fill: var(--evp-surface-raised);
}

.tick,
.stub {
  fill: color-mix(in srgb, var(--evp-text-muted) 45%, var(--evp-surface));
}

.dot--a {
  fill: var(--evp-danger);
}

.dot--b {
  fill: var(--evp-focus);
}

.dot--c {
  fill: var(--evp-mark);
}

.shift--mark {
  fill: var(--evp-mark);
}

.shift--accent {
  fill: var(--evp-accent);
}

.shift--gold {
  fill: color-mix(in srgb, var(--evp-focus) 70%, var(--evp-surface));
}

.shift--clay {
  fill: color-mix(in srgb, var(--evp-warning) 70%, var(--evp-surface));
}

.shift--coral {
  fill: color-mix(in srgb, var(--evp-danger) 65%, var(--evp-surface));
}

.now {
  fill: var(--evp-focus);
}
</style>
