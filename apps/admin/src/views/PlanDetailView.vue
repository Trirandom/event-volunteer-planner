<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * One page for a festival and for the days inside it.
 *
 * This replaces the separate festival page and event page. The two were never
 * two jobs: a coordinator staffs Soundclash 26, and Saturday is a filter on
 * it, not a different subject. Everything below the heading — missions,
 * shifts, form submissions, and availability once intake lands — is asked for
 * the whole production and then narrowed by the day strip, so the "whole
 * festival" answer and the "just Saturday" answer come off one page and one
 * set of queries instead of being assembled by hand out of six pages.
 *
 * Both URLs survive the merge. `/festivals/{id}` and `/events/{id}` are real,
 * distinct resources on the wire and both are in coordinators' bookmarks;
 * they are two entry points into this component, resolved by `usePlanScope`,
 * not two components.
 *
 * The section is carried on the route (`meta.section`) rather than re-derived
 * from the path here, which is what lets the day strip switch scope without
 * throwing away the section the coordinator is reading: clicking a day from
 * the festival's submissions lands on that day's submissions.
 */
import { eventColor } from '@evp/shared';
import { computed } from 'vue';
import {
  RouterLink,
  RouterView,
  useRoute,
  type RouteLocationRaw,
  type RouteMeta,
} from 'vue-router';

import { usePlanScope } from '../api/usePlan';
import { formatPeriod, periodText } from '../format/period';
import { locale, t } from '../i18n';
import { planSubject, statusLabel } from '../plan/scope';
import { useRouteParam } from '../router/params';

const route = useRoute();
const orgId = useRouteParam('orgId');
const festivalId = useRouteParam('festivalId');
const eventId = useRouteParam('eventId');

const { scope, isPending, subjectFailed, festivalFailed } = usePlanScope(
  orgId,
  festivalId,
  eventId,
);

const festival = computed(() => scope.value?.festival ?? null);
const selected = computed(() => scope.value?.selected ?? null);
const subject = computed(() =>
  scope.value === null ? null : planSubject(scope.value),
);

/** The heading names the production; the day, when one is picked, is named by
 * the strip below it and by its own summary line. A standalone event is its
 * own production and names itself. */
const title = computed(() => festival.value?.name ?? subject.value?.name ?? '');

const festivalPeriod = computed(() => {
  const value = festival.value;
  return value === null
    ? null
    : formatPeriod(value.period, value.timezone, locale.value);
});

const selectedPeriod = computed(() => {
  const day = selected.value;
  return day === null
    ? null
    : formatPeriod(day.period, day.timezone, locale.value);
});

const selectedMeta = computed(() => {
  const day = selected.value;
  return day === null
    ? null
    : t('plan.daySummaryMeta', {
        status: statusLabel(day.status),
        slug: day.slug,
      });
});

/** The line under the heading describes whatever the heading names: the
 * festival when there is one, the event itself when it stands alone. */
const headerPeriod = computed(
  () => festivalPeriod.value ?? selectedPeriod.value,
);

const days = computed(() => scope.value?.days ?? []);

/**
 * A day chip's colour, as a custom property the stylesheet reads.
 *
 * Bound as `--evp-day-color` rather than as `background` or `color` directly,
 * because the chip uses the same value three ways — dot, border, fill when
 * selected — and only the stylesheet knows which of them applies in which
 * state. Inline styles that knew that would be the selected-state rules
 * written twice, in two files.
 *
 * What the colour may *be* used for is fixed by the palette's guarantee
 * (`packages/shared/src/eventColors.ts`): every entry clears 4.5:1 against
 * black and white, so white text on a filled chip is safe everywhere, but the
 * same colour as *text* on `--evp-surface` is only ~4.0:1 in the dark theme.
 * Hence a filled chip rather than a coloured word.
 */
function dayStyle(day: { readonly color: number }): Record<string, string> {
  return { '--evp-day-color': eventColor(day.color) };
}

/** The sections, as one type, because `target` and `here` both key off it and
 * a route added to `planSections` without a link here is a route nobody can
 * reach. The rail lists them in the order the router declares them, which is
 * the order a festival is set up in. */
type PlanSection = NonNullable<RouteMeta['section']>;

/** The landing section, and therefore the fallback: a route with no `section`
 * is the parent before its redirect has resolved. */
const section = computed(() => route.meta.section ?? 'details');

/** Both scopes offer the same sections, so a link is "this section, at that
 * scope" — one function rather than four hand-written route names that could
 * drift apart. */
function target(
  scopeKind: 'festival' | 'event',
  id: string,
  named: PlanSection,
): RouteLocationRaw {
  return scopeKind === 'festival'
    ? {
        name: `org-festival-${named}`,
        params: { orgId: orgId.value, festivalId: id },
      }
    : {
        name: `org-event-${named}`,
        params: { orgId: orgId.value, eventId: id },
      };
}

/** The same section at the scope the page is already on — what the section
 * nav links to. */
function here(named: PlanSection): RouteLocationRaw {
  const day = selected.value;
  return day === null
    ? target('festival', festival.value?.id ?? '', named)
    : target('event', day.id, named);
}
</script>

<template>
  <p v-if="isPending">{{ t('common.status.loading') }}</p>

  <template v-else-if="scope !== null && subject !== null">
    <div class="evp-shell">
      <!-- The rail sits against the window's left edge rather than inside the
           page's own column, so the board beside it starts at the edge too.
           On a phone it stops being a rail and becomes a row of links above
           the content — a 12 rem column at 320 px is not a navigation, it is
           a wall. -->
      <div class="evp-rail">
        <!-- The production's name heads the rail rather than the content
             column, and it is the page's `h1` there rather than a second copy
             of one: the rail is the only thing on this page that does not
             change as a coordinator moves through it. Narrowing to Saturday
             swaps the board, the summary and the section; what they are
             staffing does not, and a title that scrolls away with a
             twelve-hour board is a title that is gone exactly when six
             similar days start looking alike. The day being read is named
             below, in the strip and in its own summary line.

             Outside the `nav`, not inside it: a heading within a navigation
             landmark labels the navigation, and this one labels the page. -->
        <h1 class="evp-rail-title">{{ title }}</h1>
        <nav :aria-label="t('plan.nav.label')" class="evp-rail-nav">
          <RouterLink class="evp-rail-link" :to="here('details')">
            {{ t('plan.nav.details') }}
          </RouterLink>
          <RouterLink class="evp-rail-link" :to="here('missions')">
            {{ t('plan.nav.missions') }}
          </RouterLink>
          <RouterLink class="evp-rail-link" :to="here('shifts')">
            {{ t('plan.nav.shifts') }}
          </RouterLink>
          <RouterLink class="evp-rail-link" :to="here('form')">
            {{ t('plan.nav.form') }}
          </RouterLink>
          <RouterLink
            class="evp-rail-link"
            :class="{ 'evp-rail-link--within': section === 'submissions' }"
            :to="here('submissions')"
          >
            {{ t('plan.nav.submissions') }}
          </RouterLink>
          <RouterLink class="evp-rail-link" :to="here('availability')">
            {{ t('plan.nav.availability') }}
          </RouterLink>
          <RouterLink class="evp-rail-link" :to="here('assignments')">
            {{ t('plan.nav.assignments') }}
          </RouterLink>
          <RouterLink class="evp-rail-link" :to="here('emails')">
            {{ t('plan.nav.emails') }}
          </RouterLink>
        </nav>
      </div>

      <div class="evp-content">
        <p v-if="headerPeriod" class="evp-muted">
          {{ periodText(headerPeriod) }}
        </p>

        <p v-if="festivalFailed" role="alert" class="evp-error">
          {{ t('plan.festivalFailed') }}
        </p>

        <!-- The scope switch. A festival's days and the festival itself are peers
         here on purpose: picking a day is narrowing the same page, not
         navigating to a different one, and "Whole festival" has to be as easy
         to get back to as any day is to reach. -->
        <nav
          v-if="festival !== null"
          :aria-label="t('plan.scope.label')"
          class="evp-days"
        >
          <RouterLink
            class="evp-day"
            :to="target('festival', festival.id, section)"
          >
            {{ t('plan.scope.wholeFestival') }}
          </RouterLink>
          <!-- Each day carries its own colour, which is the same colour its
               card, its board lane and its chip everywhere else are drawn in
               — the strip is where a coordinator learns which is which. The
               colour is never the only difference: the selected chip is also
               filled and bold, and every chip is named in words. -->
          <RouterLink
            v-for="day in days"
            :key="day.id"
            class="evp-day evp-day--coloured"
            :style="dayStyle(day)"
            :to="target('event', day.id, section)"
          >
            <span class="evp-day-dot" aria-hidden="true" />
            {{ day.name }}
          </RouterLink>
        </nav>

        <p
          v-if="festival !== null && selected !== null && selectedPeriod"
          class="evp-day-summary"
        >
          <strong class="evp-day-name" :style="dayStyle(selected)">
            <span class="evp-day-dot" aria-hidden="true" />
            {{ selected.name }}
          </strong>
          <span class="evp-muted">{{ periodText(selectedPeriod) }}</span>
          <span class="evp-muted">{{ selectedMeta }}</span>
        </p>

        <div class="evp-section">
          <RouterView />
        </div>
      </div>
    </div>
  </template>

  <p v-else-if="subjectFailed" role="alert">{{ t('plan.loadFailed') }}</p>
</template>

<style scoped>
.evp-breadcrumb a {
  color: var(--evp-accent);
  text-decoration: underline;
  text-underline-offset: 0.2em;
}

.evp-muted {
  color: var(--evp-text-muted);
}

.evp-error {
  background: var(--evp-surface);
  border: 1px solid var(--evp-danger);
  border-left-width: 4px;
  border-radius: 0.375rem;
  color: var(--evp-danger);
  margin: 1rem 0 0;
  padding: 0.75rem;
}

.evp-days {
  display: flex;
  /* Wraps rather than scrolls sideways: ten days at 320 px is four rows of
     chips, never a horizontal scrollbar (docs/14 §2). */
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 1.25rem;
}

.evp-day {
  align-items: center;
  border: 1px solid var(--evp-border);
  border-radius: 999px;
  color: var(--evp-text);
  display: inline-flex;
  font-size: 0.9375rem;
  gap: 0.4375rem;
  padding: 0.375rem 0.875rem;
  text-decoration: none;
}

.evp-day:hover {
  background: var(--evp-surface-raised);
}

/* The selected scope carries a filled background, a border colour and bold
   weight — never colour alone (docs/14 §2). `exact-active` rather than
   `active`, so "Whole festival" does not also light up on a day. */
.evp-day.router-link-exact-active {
  background: color-mix(in srgb, var(--evp-accent) 12%, var(--evp-surface));
  border-color: var(--evp-accent);
  color: var(--evp-accent);
  font-weight: 600;
}

/* The event's own colour, on the chips that have one. "Whole festival" does
   not: a festival has no colour of its own, and inventing one for it would
   make the strip read as seven peers when it is one production and its days.

   A dot rather than a coloured word, because a palette entry is proved
   against black and white only — as text on `--evp-surface` it lands around
   4.0:1 in the dark theme, under the body-text threshold. As a 0.625 rem mark
   it is a non-text object at 3:1 (WCAG 1.4.11), which it clears on every
   surface in both themes. */
.evp-day-dot {
  background: var(--evp-day-color);
  border-radius: 50%;
  flex: 0 0 auto;
  height: 0.625rem;
  width: 0.625rem;
}

/* Selected, the chip *is* the colour: white on any palette entry is 4.5:1 by
   construction, which is the one thing the palette guarantees outright. The
   dot goes white with the text so it stays visible on its own fill, and the
   chip keeps its bold weight — the fill is the second signal, not the only
   one. */
.evp-day--coloured.router-link-exact-active {
  background: var(--evp-day-color);
  border-color: var(--evp-day-color);
  color: #ffffff;
}

.evp-day--coloured.router-link-exact-active .evp-day-dot {
  background: #ffffff;
}

/* Hover must not repaint a chip the theme's surface colour and lose the
   day's identity; it lifts the unselected chip only. */
.evp-day--coloured:hover:not(.router-link-exact-active) {
  background: color-mix(in srgb, var(--evp-day-color) 12%, var(--evp-surface));
  border-color: var(--evp-day-color);
}

.evp-day-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 0.75rem;
  margin: 1rem 0 0;
}

/* The summary line names the same day the strip has filled in, so it carries
   the same dot — the two are one statement, read left to right. */
.evp-day-name {
  align-items: center;
  display: inline-flex;
  gap: 0.4375rem;
}

.evp-shell {
  display: flex;
  /* Wraps at narrow widths, which is what turns the rail into a row of links
     above the content instead of squeezing the board into nothing. */
  flex-wrap: wrap;
  min-height: calc(100vh - 4rem);
}

.evp-rail {
  background: var(--evp-surface);
  border-right: 1px solid var(--evp-border);
  display: flex;
  flex: 0 0 12rem;
  flex-direction: column;
  gap: 0.25rem;
  padding: 1.5rem 0.5rem;
  /* Follows the page down a long board rather than scrolling off the top of
     it; `top` clears the shell header. */
  align-self: flex-start;
  position: sticky;
  top: 0;
}

/* The page's `h1`, sized for a 12 rem column rather than for a banner: it is
   read once for orientation and then sat beside, so it does not need to be the
   largest thing on screen to be the most important. */
.evp-rail-title {
  font-size: 1.0625rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 1.25;
  margin: 0 0 1rem;
  /* Long festival names wrap rather than widen the rail or overflow it. */
  overflow-wrap: anywhere;
  padding: 0 0.75rem;
}

.evp-rail-nav {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.evp-rail-link {
  border-radius: 0 0.375rem 0.375rem 0;
  color: var(--evp-text);
  padding: 0.625rem 0.75rem;
  text-decoration: none;
}

.evp-rail-link:hover {
  background: var(--evp-surface-raised);
}

/* The selected section carries a fill, a border and bold weight — never
   colour alone (docs/14 §2). */
/* `--within` is a sub-page of the section (the submissions review): the
   section is still the one being read. */
.evp-rail-link.router-link-exact-active,
.evp-rail-link--within {
  background: color-mix(in srgb, var(--evp-accent) 10%, var(--evp-surface));
  border-left: 3px solid var(--evp-accent);
  color: var(--evp-accent);
  font-weight: 600;
  padding-left: calc(0.75rem - 3px);
}

.evp-content {
  flex: 1 1 24rem;
  min-width: 0;
  padding: 1.5rem 1rem 3rem;
}

/* Positioned so that a section's help button (`HelpModal`) lands in the same
   corner of the content column on every page, whatever that page renders
   first. */
.evp-section {
  margin-top: 1.5rem;
  min-width: 0;
  position: relative;
}

@media (max-width: 40rem) {
  .evp-rail {
    border-bottom: 1px solid var(--evp-border);
    border-right: none;
    flex: 1 0 100%;
    position: static;
  }

  /* The links go sideways; the title keeps its own line above them. Four
     navigation targets and a festival name do not share a 320 px row. */
  .evp-rail-nav {
    flex-direction: row;
    flex-wrap: wrap;
  }

  .evp-rail-title {
    margin-bottom: 0.5rem;
  }
}
</style>
