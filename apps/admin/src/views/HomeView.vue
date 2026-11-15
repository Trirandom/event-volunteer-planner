<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * The landing page: the only public page of the coordinator application.
 *
 * It says what the deployment is and offers the one action an anonymous
 * visitor can take. The About panel is not decoration — the version and source
 * link are an AGPL §13 product requirement (docs/01 §4 S0a), and fetching them
 * exercises the whole path from this bundle through Caddy to
 * `GET /api/v1/meta`.
 *
 * Volunteers do not arrive here. They reach `apps/form` at `/f/…` through a
 * capability link and never see this bundle at all (docs/02 §7).
 */
import { BrandMark, SourceNotice } from '@evp/shared';
import { RouterLink } from 'vue-router';

import { useSession } from '../api/useSession';
import LandingIllustration from '../components/LandingIllustration.vue';
import { t } from '../i18n';

const { data: session } = useSession();
</script>

<template>
  <div class="evp-landing">
    <section class="evp-hero">
      <div class="evp-hero-copy">
        <span class="evp-hero-mark">
          <BrandMark :size="56" />
        </span>

        <h1>{{ t('common.productName') }}</h1>
        <p class="evp-lead">{{ t('home.hero.lead') }}</p>
        <p class="evp-hero-body">{{ t('home.hero.body') }}</p>

        <p class="evp-actions">
          <!-- The call to action follows the session rather than assuming a
               visitor is signed out: a coordinator who lands here mid-shift
               should not be asked to sign in again. Until the first answer
               arrives, neither button is rendered, because guessing and
               swapping it a moment later moves the target under the pointer. -->
          <RouterLink
            v-if="session?.status === 'authenticated'"
            class="evp-button evp-button--slab evp-cta"
            to="/admin"
          >
            {{ t('home.hero.openAdmin') }}
            <svg class="evp-cta-arrow" viewBox="0 0 20 20" aria-hidden="true">
              <path d="M4 10h11M11 5l5 5-5 5" />
            </svg>
          </RouterLink>
          <RouterLink
            v-else-if="session !== undefined"
            class="evp-button evp-button--slab evp-cta"
            to="/login"
          >
            {{ t('home.hero.signIn') }}
            <svg class="evp-cta-arrow" viewBox="0 0 20 20" aria-hidden="true">
              <path d="M4 10h11M11 5l5 5-5 5" />
            </svg>
          </RouterLink>
        </p>
      </div>

      <div class="evp-hero-art">
        <LandingIllustration />
      </div>
    </section>

    <section aria-labelledby="what-heading">
      <h2 id="what-heading">{{ t('home.features.heading') }}</h2>

      <!-- A list, still: three cards are three items, and a coordinator using a
           screen reader should be told how many there are before the first one.
           The icons are decorative — each says the same thing as the heading
           beside it — so they are hidden rather than labelled (docs/14 §2). -->
      <ul class="evp-features">
        <li class="evp-feature evp-feature--availability">
          <span class="evp-feature-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <rect x="3" y="5" width="18" height="16" rx="2" />
              <path d="M3 10h18M8 3v4M16 3v4" />
              <path d="M12 13v3.5l2.5 1.5" />
            </svg>
          </span>
          <h3>{{ t('home.features.availability.title') }}</h3>
          <p>{{ t('home.features.availability.body') }}</p>
        </li>

        <li class="evp-feature evp-feature--refusal">
          <span class="evp-feature-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path
                d="M12 3l8 3.5v5c0 4.6-3.2 8.6-8 9.5-4.8-.9-8-4.9-8-9.5v-5z"
              />
              <path d="M9 12h6" />
            </svg>
          </span>
          <h3>{{ t('home.features.refusal.title') }}</h3>
          <p>{{ t('home.features.refusal.body') }}</p>
        </li>

        <li class="evp-feature evp-feature--notify">
          <span class="evp-feature-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <path d="M3.5 7l8.5 6 8.5-6" />
            </svg>
          </span>
          <h3>{{ t('home.features.notify.title') }}</h3>
          <p>{{ t('home.features.notify.body') }}</p>
        </li>
      </ul>

      <p class="evp-status-note">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5M12 7.5v.01" />
        </svg>
        <span>{{ t('home.statusNote') }}</span>
      </p>
    </section>

    <section aria-labelledby="about-heading" class="evp-about">
      <h2 id="about-heading">{{ t('home.about.heading') }}</h2>
      <SourceNotice />
    </section>
  </div>
</template>

<style scoped>
/* Flat: every surface is one matte colour, nothing is a gradient, and depth
   is a solid offset slab with no blur. Each colour is a semantic token or a
   `color-mix` of two, so one declaration covers both themes and nothing here
   needs a value under prefers-color-scheme. Text only ever sits on a pair the
   contrast test proved (packages/shared/src/tokens.ts); the mixes are fills
   and slabs, never a text background. */
.evp-landing {
  display: flex;
  flex-direction: column;
  gap: 3.5rem;
}

/* The one branded surface in the application: a solid block of the accent
   with the copy in `onAccent`, the pair proved for the primary button, so the
   hero inherits that proof instead of needing its own. */
.evp-hero {
  align-items: center;
  background: var(--evp-accent);
  /* Invisible normally. Under forced-colors the background is dropped and
     this border is what is left of the block's edge. */
  border: 2px solid transparent;
  border-radius: 1rem;
  color: var(--evp-on-accent);
  display: grid;
  gap: 2rem 2.5rem;
  /* auto-fit, not a breakpoint (docs/14 §2): copy and drawing sit side by
     side when both fit and stack otherwise, which is also what 400% zoom
     does. */
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr));
  isolation: isolate;
  overflow: hidden;
  padding: 2.5rem 1.5rem;
  position: relative;
}

/* Two flat discs behind the copy, the usual flat-design motif. Backgrounds
   rather than elements, so assistive technology never meets them. */
.evp-hero::before,
.evp-hero::after {
  background: color-mix(in srgb, var(--evp-on-accent) 9%, var(--evp-accent));
  border-radius: 50%;
  content: '';
  position: absolute;
  z-index: -1;
}

.evp-hero::before {
  height: 22rem;
  right: -6rem;
  top: -8rem;
  width: 22rem;
}

.evp-hero::after {
  bottom: -5rem;
  height: 11rem;
  left: 30%;
  width: 11rem;
}

/* The mark has a dark half drawn to stay dark (BrandMark.vue), so it needs a
   light plate whatever the accent is. */
.evp-hero-mark {
  background: var(--evp-surface);
  border-radius: 1rem;
  box-shadow: 0 4px 0 var(--evp-slab);
  display: inline-flex;
  padding: 0.625rem;
}

.evp-hero h1 {
  font-size: clamp(2rem, 6vw, 3rem);
  font-weight: 800;
  letter-spacing: -0.03em;
  line-height: 1.05;
  margin: 1.5rem 0 0.75rem;
}

.evp-lead {
  font-size: 1.25rem;
  font-weight: 600;
  line-height: 1.35;
  margin: 0 0 0.75rem;
  max-width: 34ch;
}

/* Not muted: `textMuted` is proved on the surfaces, not on the accent, and an
   opacity would be an unproved colour by another name. */
.evp-hero-body {
  margin: 0;
  max-width: 56ch;
}

.evp-actions {
  margin: 2rem 0 0;
  /* Room for the slab, which the hero's overflow would otherwise clip. */
  padding-bottom: 6px;
}

/* The call to action, inverted against the hero: a surface-coloured block
   with accent text (proved on `surface`, and on `surfaceRaised`, the hover
   ground). `.evp-button--primary` here would be the accent on the accent,
   which is no button at all. The slab and the press come from
   `.evp-button--slab` (styles.css). */
.evp-cta {
  align-items: center;
  background: var(--evp-surface);
  border: 2px solid transparent;
  color: var(--evp-accent);
  display: inline-flex;
  font-size: 1.0625rem;
  gap: 0.625rem;
  min-height: 3.25rem;
  padding: 0.75rem 1.75rem;
}

.evp-cta:hover {
  background: var(--evp-surface-raised);
  border-color: transparent;
}

.evp-cta-arrow {
  fill: none;
  height: 1.125rem;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 2.25;
  width: 1.125rem;
}

/* The drawing rests on its own slab, offset down and right, so it reads as a
   card laid on the block rather than a hole cut in it. */
.evp-hero-art {
  border-radius: 20px;
  box-shadow: 14px 14px 0 var(--evp-slab);
  margin: 0 14px 14px 0;
}

h2 {
  font-size: 1.5rem;
  font-weight: 800;
  letter-spacing: -0.02em;
  margin: 0 0 1.25rem;
}

/* auto-fit rather than a breakpoint: the cards become one column when one
   column is what fits, which is also what happens at 400% zoom. */
.evp-features {
  display: grid;
  gap: 1.25rem;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr));
  list-style: none;
  margin: 0;
  padding: 0;
}

/* No hover state: a card is not a control, and one that answers the pointer
   promises a click it does not have. */
.evp-feature {
  background: var(--evp-surface-raised);
  border: 2px solid transparent;
  border-radius: 0.75rem;
  box-shadow: 5px 5px 0
    color-mix(in srgb, var(--card-hue) 35%, var(--evp-surface));
  padding: 1.5rem;
}

.evp-feature h3 {
  font-size: 1.0625rem;
  font-weight: 700;
  margin: 1rem 0 0.375rem;
}

.evp-feature p {
  color: var(--evp-text-muted);
  margin: 0;
}

/* The three hues are decorative — the heading carries the meaning, and nothing
   is distinguished by colour alone (docs/14 §2). A solid plate of the hue with
   the glyph knocked out in the page colour. */
.evp-feature-icon {
  align-items: center;
  background: var(--card-hue);
  border-radius: 0.75rem;
  color: var(--evp-surface);
  display: flex;
  height: 3rem;
  justify-content: center;
  width: 3rem;
}

.evp-feature-icon svg {
  height: 1.5rem;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 2;
  width: 1.5rem;
}

.evp-feature--availability {
  --card-hue: var(--evp-accent);
}

.evp-feature--refusal {
  --card-hue: var(--evp-danger);
}

.evp-feature--notify {
  --card-hue: var(--evp-warning);
}

/* A notice, not an alert: nothing is wrong, the build is just early. The tint
   stays near enough to the surface that body text keeps its contrast, and the
   bar plus the icon say "note" without leaning on the hue. */
.evp-status-note {
  align-items: flex-start;
  background: color-mix(in srgb, var(--evp-warning) 10%, var(--evp-surface));
  border-left: 4px solid var(--evp-warning);
  border-radius: 0.5rem;
  display: flex;
  gap: 0.75rem;
  margin: 2rem 0 0;
  max-width: 70ch;
  padding: 0.875rem 1rem;
}

.evp-status-note svg {
  color: var(--evp-warning);
  fill: none;
  flex: none;
  height: 1.375rem;
  margin-top: 0.0625rem;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-width: 2;
  width: 1.375rem;
}

.evp-about {
  background: var(--evp-surface-raised);
  border: 2px solid transparent;
  border-radius: 0.75rem;
  padding: 1.25rem 1.5rem;
}

.evp-about h2 {
  font-size: 1.125rem;
  margin-bottom: 0.5rem;
}
</style>
