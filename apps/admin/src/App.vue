<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
import { BrandMark, LocaleSwitcher } from '@evp/shared';
import type { Locale } from '@evp/shared/i18n';
import { computed, watch } from 'vue';
import { RouterLink, RouterView, useRoute } from 'vue-router';

import { useSession } from './api/useSession';
import { locale, setLocale, t } from './i18n';
import { accountLocale, storeLocale } from './i18n/preference';
import { useRouteParam } from './router/params';

/**
 * Read at the shell rather than per-view, and on the same query key the router
 * guard uses — so the header and the guard cannot disagree about whether
 * somebody is signed in, which is the bug a second copy in a store produces
 * the first time a session expires in a background tab.
 */
const { data: session } = useSession();

/**
 * The account's language applies once the session is known, unless this
 * device already has a choice (`i18n/preference.ts`). Here rather than in the
 * router guard because the guard only runs on navigation, and a session that
 * resolves after the first one would otherwise leave the wrong language up.
 */
watch(
  () =>
    session.value?.status === 'authenticated'
      ? session.value.user.locale
      : null,
  (userLocale) => {
    const wanted = userLocale === null ? null : accountLocale(userLocale);
    if (wanted !== null) {
      void setLocale(wanted);
    }
  },
  { immediate: true },
);

function chooseLocale(next: Locale): void {
  storeLocale(next);
  void setLocale(next);
}

const route = useRoute();
const routeOrgId = useRouteParam('orgId');

/**
 * Whether this route wants the window or the reading column.
 *
 * Prose belongs in ~70 rem; a timeline does not, and the planner board is
 * measured in hours visible at once. The route declares which it is
 * (`router/index.ts`), so the shell never has to recognise a URL.
 */
const isWide = computed(() => route.meta.layout === 'wide');

/**
 * Which organisation the header's Events link points at.
 *
 * Every org-scoped route carries `orgId` (docs/04 §1 — the org is never
 * inferred), so a header link has to name one. The org already on screen wins,
 * which keeps the link a no-op rather than a silent org switch while a
 * coordinator is working inside one. Away from an org route there is nothing
 * on screen to follow, so the first membership is the only honest guess; the
 * admin panel remains the place to pick between them, and someone in two orgs
 * needs it either way.
 *
 * `null` for a user with no memberships — identity is global and membership is
 * per-organisation (docs/03), so that user exists and must not be given a link
 * to `/undefined/events`.
 */
const eventsOrgId = computed((): string | null => {
  if (routeOrgId.value !== '') {
    return routeOrgId.value;
  }
  if (session.value?.status !== 'authenticated') {
    return null;
  }
  return session.value.user.memberships[0]?.org_id ?? null;
});
</script>

<template>
  <a class="evp-skip-link" href="#main">{{ t('shell.skipToContent') }}</a>

  <header class="evp-header">
    <div class="evp-header-inner">
      <!-- The mark is the home link, so "Planner" is no longer also a nav
           item. Two links to the same page in one header is two tab stops
           and, for a screen reader listing links, two identical entries. -->
      <RouterLink class="evp-brand" to="/">
        <BrandMark :size="32" />
        <span class="evp-brand-name">{{ t('common.productName') }}</span>
      </RouterLink>

      <nav :aria-label="t('shell.nav.label')">
        <!-- Nothing is rendered until the first answer arrives. A "Sign in"
             link that becomes "Admin panel" a moment later moves the target
             under a pointer already on its way to it (docs/14 §2). -->
        <template v-if="session?.status === 'authenticated'">
          <RouterLink
            v-if="eventsOrgId !== null"
            class="evp-nav-link"
            :to="{ name: 'org-events', params: { orgId: eventsOrgId } }"
          >
            {{ t('shell.nav.events') }}
          </RouterLink>
          <RouterLink class="evp-nav-link" to="/admin">
            {{ t('shell.nav.admin') }}
          </RouterLink>
        </template>
        <template v-else-if="session !== undefined">
          <RouterLink class="evp-nav-link" to="/login">
            {{ t('shell.nav.signIn') }}
          </RouterLink>
        </template>
        <!-- Outside the session branches: a signed-out visitor needs it
             most, since the login page is where they first meet the UI. -->
        <LocaleSwitcher :current="locale" @select="chooseLocale" />
      </nav>
    </div>
  </header>

  <main id="main" class="evp-main" :class="{ 'evp-main--wide': isWide }">
    <RouterView />
  </main>
</template>

<style scoped>
/* Off-screen until focused, then a real, visible, branded target — a skip link
   that cannot be seen is a skip link nobody uses. `left`, not `display: none`:
   a hidden element is not focusable at all. */
.evp-skip-link {
  position: absolute;
  left: -9999px;
}

.evp-skip-link:focus-visible {
  background: var(--evp-accent);
  border-radius: 0 0 0.375rem 0;
  color: var(--evp-on-accent);
  display: inline-block;
  left: 0;
  padding: 0.75rem 1rem;
  position: absolute;
  top: 0;
  z-index: 10;
}

.evp-header {
  background: var(--evp-surface);
  border-bottom: 1px solid var(--evp-border);
}

.evp-header-inner {
  align-items: center;
  display: flex;
  /* Wraps rather than shrinking the brand away: at 320 px the nav drops to its
     own line instead of the product name truncating (docs/14 §2). */
  flex-wrap: wrap;
  gap: 0.75rem 1rem;
  justify-content: space-between;
  margin: 0 auto;
  max-width: 70rem;
  padding: 0.75rem 1rem;
}

.evp-brand {
  align-items: center;
  color: var(--evp-text);
  display: flex;
  gap: 0.625rem;
  text-decoration: none;
}

.evp-brand-name {
  font-size: 0.9375rem;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.evp-header nav {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
}

.evp-nav-link {
  border-radius: 0.375rem;
  color: var(--evp-accent);
  /* A nav link is a link, so it is underlined: `accent` and `text` are both
     dark greens and colour alone does not distinguish them (WCAG 1.4.1). */
  text-decoration: underline;
  text-underline-offset: 0.2em;
  /* 24×24 floor from docs/14 §2, reached with padding rather than a min-height
     that would fight the flex row's baseline. */
  padding: 0.375rem 0.5rem;
}

.evp-nav-link:hover {
  background: var(--evp-surface-raised);
}

.evp-main {
  margin: 0 auto;
  max-width: 70rem;
  padding: 2rem 1rem 3rem;
  /* A grid item with auto inline margins shrinks to its content; this keeps
     the centred column as wide as it was in block layout. */
  width: 100%;
}

/* No max-width and no horizontal padding: a wide route puts its own rail
   against the window edge and takes the rest for the board. The vertical
   padding goes too, because the rail is full-height and would otherwise float
   in a gap. A flex column so the page inside can grow into the row `#app`
   gives `main` (styles.css) and run its rail to the bottom of the window. */
.evp-main--wide {
  display: flex;
  flex-direction: column;
  max-width: none;
  padding: 0;
}
</style>
