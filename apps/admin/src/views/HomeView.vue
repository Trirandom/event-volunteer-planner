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
import { t } from '../i18n';

const { data: session } = useSession();
</script>

<template>
  <div class="evp-landing">
    <section class="evp-hero">
      <BrandMark :size="72" />

      <h1>{{ t('common.productName') }}</h1>
      <p class="evp-lead">{{ t('home.hero.lead') }}</p>
      <p class="evp-hero-body">{{ t('home.hero.body') }}</p>

      <p class="evp-actions">
        <!-- The call to action follows the session rather than assuming a
             visitor is signed out: a coordinator who lands here mid-shift
             should not be asked to sign in again. Until the first answer
             arrives, neither button is rendered, because guessing and swapping
             it a moment later moves the target under the pointer. -->
        <RouterLink
          v-if="session?.status === 'authenticated'"
          class="evp-button evp-button--primary"
          to="/admin"
        >
          {{ t('home.hero.openAdmin') }}
        </RouterLink>
        <RouterLink
          v-else-if="session !== undefined"
          class="evp-button evp-button--primary"
          to="/login"
        >
          {{ t('home.hero.signIn') }}
        </RouterLink>
      </p>
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

      <p class="evp-status-note">{{ t('home.statusNote') }}</p>
    </section>

    <section aria-labelledby="about-heading" class="evp-panel evp-about">
      <h2 id="about-heading">{{ t('home.about.heading') }}</h2>
      <SourceNotice />
    </section>
  </div>
</template>

<style scoped>
/* Everything is a single column that simply narrows. docs/14 §2 puts the
   conformance floor at 320 px and the design width at 400 px; a layout with no
   fixed widths clears both without a media query to maintain. */
.evp-landing {
  display: flex;
  flex-direction: column;
  gap: 3rem;
}

/* The one branded surface in the application. The wash is drawn from the
   semantic tokens rather than a ramp step, so it follows the theme instead of
   needing a second definition under prefers-color-scheme. */
.evp-hero {
  background: linear-gradient(
    160deg,
    var(--evp-surface-raised),
    var(--evp-surface) 70%
  );
  border: 1px solid var(--evp-border);
  border-radius: 0.75rem;
  padding: 2rem 1.5rem 2.25rem;
  position: relative;
  overflow: hidden;
}

/* A brand band along the top edge, running the mark's green into the gold. It
   carries no meaning and is hidden from assistive technology by being a
   background rather than an element. */
.evp-hero::before {
  background: linear-gradient(
    90deg,
    var(--evp-accent),
    var(--evp-accent-hover) 45%,
    var(--evp-warning)
  );
  content: '';
  height: 4px;
  inset: 0 0 auto;
  position: absolute;
}

.evp-hero h1 {
  font-size: clamp(1.75rem, 5vw, 2.5rem);
  letter-spacing: -0.02em;
  line-height: 1.15;
  margin: 1.25rem 0 0.5rem;
}

.evp-lead {
  color: var(--evp-text);
  font-size: 1.125rem;
  font-weight: 500;
  margin: 0 0 0.75rem;
  max-width: 40ch;
}

.evp-hero-body {
  color: var(--evp-text-muted);
  margin: 0;
  max-width: 60ch;
}

.evp-actions {
  margin: 1.75rem 0 0;
}

h2 {
  font-size: 1.125rem;
  margin: 0 0 1rem;
}

/* auto-fit rather than a breakpoint: the cards become one column when one
   column is what fits, which is also what happens at 400% zoom. */
.evp-features {
  display: grid;
  gap: 1rem;
  grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
  list-style: none;
  margin: 0;
  padding: 0;
}

.evp-feature {
  background: var(--evp-surface-raised);
  border: 1px solid var(--evp-border);
  border-radius: 0.5rem;
  padding: 1.25rem;
}

.evp-feature h3 {
  font-size: 1rem;
  margin: 0.875rem 0 0.375rem;
}

.evp-feature p {
  color: var(--evp-text-muted);
  margin: 0;
}

/* The three hues are decorative — the heading carries the meaning, and nothing
   is distinguished by colour alone (docs/14 §2). They are picked from the
   semantic tokens so both themes are covered by one declaration. */
.evp-feature-icon {
  align-items: center;
  /* color-mix is Baseline Widely Available, which is the support policy
     (docs/14 §6). The plate is a tint of the card's own hue, so it tracks the
     theme without a second set of values under prefers-color-scheme. */
  background: color-mix(in srgb, var(--card-hue) 14%, var(--evp-surface));
  border-radius: 0.5rem;
  color: var(--card-hue);
  display: flex;
  height: 2.5rem;
  justify-content: center;
  width: 2.5rem;
}

.evp-feature-icon svg {
  height: 1.375rem;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.75;
  width: 1.375rem;
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

.evp-status-note {
  color: var(--evp-text-muted);
  margin: 1.25rem 0 0;
  max-width: 60ch;
}

.evp-about h2 {
  margin-bottom: 0.5rem;
}
</style>
