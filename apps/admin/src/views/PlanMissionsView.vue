<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * Missions: what the work *is*, as opposed to when it happens.
 *
 * The shift board next door answers "where is the hole?" and it answers it as
 * a shape on a timeline. It has no room for the two things a volunteer needs
 * before they can work a post — what the job is and where to stand — and a
 * gutter label is not a briefing. Those lived in the free-text column of the
 * Google Sheet this replaces and were the first thing lost in the move; this
 * is where they come back.
 *
 * **Scope-following, like the details section.** A coordinator setting up
 * Soundclash 26 declares its missions once for the whole production, so at
 * festival scope this page is the fold across every day (`missionCatalog.ts`)
 * and each write fans out over the rows behind it (`useMissionWrites.ts`).
 * Narrowed to Saturday it is Saturday's rows, which is the same page with one
 * day in it — and the way to correct a single day after the festival-wide edit
 * that created it.
 *
 * The fold is by name, which is honest about what it can get wrong: two
 * unrelated posts sharing a word become one card, a typo splits one in two.
 * Both are visible, because every card lists the days it covers — a reading no
 * card can give without also giving away a fold nobody intended.
 */
import { computed } from 'vue';

import { useMissionCatalog, usePlanScope } from '../api/usePlan';
import HelpModal from '../components/HelpModal.vue';
import MissionCard from '../components/MissionCard.vue';
import NewMissionForm from '../components/NewMissionForm.vue';
import NewPostForm from '../components/NewPostForm.vue';
import { groupByZone } from '../plan/missionCatalog';
import { t } from '../i18n';
import { useRouteParam } from '../router/params';

const orgId = useRouteParam('orgId');
const festivalId = useRouteParam('festivalId');
const eventId = useRouteParam('eventId');

const { scope, isPending: scopePending } = usePlanScope(
  orgId,
  festivalId,
  eventId,
);

/** At event scope this is the one day; at festival scope it is every day of
 * the production, in the order the day strip shows them — the same narrowing
 * `PlanDetailsView.vue` makes, and for the same reason. */
const events = computed(() => {
  const value = scope.value;
  if (value === null) {
    return [];
  }
  return value.selected === null ? value.days : [value.selected];
});

const {
  catalog,
  isPending: catalogPending,
  locationsFailed,
} = useMissionCatalog(orgId, events);

const isPending = computed(() => scopePending.value || catalogPending.value);

/** Every name in use, so a card and the add form can both refuse a duplicate
 * before the fan-out turns one collision into six identical refusals. */
const takenKeys = computed(() =>
  catalog.value.missions.map((mission) => mission.key),
);

const dayCount = computed(() => catalog.value.days.length);

/**
 * The fold, reassembled into the tree it actually is — a zone's card and the
 * posts nested under it, rather than one undifferentiated list where a zone
 * that holds a dozen posts looks exactly like a post that holds none. This is
 * also where deletion's blast radius becomes visible: `group.posts` is
 * passed to the zone's card so its confirmation can name every post the
 * cascade would take with it.
 */
const grouped = computed(() => groupByZone(catalog.value.missions));
</script>

<template>
  <p v-if="isPending">{{ t('common.status.loading') }}</p>

  <template v-else>
    <HelpModal :title="t('missions.view.help.title')">
      <p>{{ t('missions.view.help.intro') }}</p>
      <p v-if="dayCount > 1">
        {{ t('missions.view.help.festival', { count: dayCount }) }}
      </p>
    </HelpModal>

    <!-- Louder than the board's version of this warning, because a day whose
         tree did not load is indistinguishable from a day that simply does not
         run the mission — and the difference decides whether "add to the
         missing days" would create a duplicate. -->
    <p v-if="locationsFailed" role="alert" class="evp-error">
      {{ t('missions.view.locationsFailed') }}
    </p>

    <NewMissionForm
      v-if="catalog.days.length > 0"
      :org-id="orgId"
      :days="catalog.days"
      :taken-keys="takenKeys"
    />

    <p v-if="catalog.days.length === 0" class="evp-muted">
      {{ t('missions.view.noDays') }}
    </p>
    <p v-else-if="catalog.missions.length === 0" class="evp-empty">
      {{ t('missions.view.empty') }}
    </p>

    <!-- Below `evp-mission-group-wide`'s breakpoint, a zone and its posts are
         two things stacked with a rail between them (`.evp-posts`) — a
         narrow column has no room to show them side by side and reads them
         fine in sequence. Past it, they are laid out as one card because a
         wide-screen coordinator is looking at both at once and two panels
         touching read as unrelated. -->
    <template v-for="group in grouped.zones" :key="group.zone.key">
      <div class="evp-mission-group">
        <div class="evp-mission-group-zone">
          <MissionCard
            :org-id="orgId"
            :mission="group.zone"
            :taken-keys="takenKeys"
            :day-count="dayCount"
            :nested-posts="group.posts"
          />
        </div>

        <!-- Indented under the zone that holds them at narrow widths, so the
             hierarchy is a shape on screen rather than a fact only the
             "Zone"/"Post" tags state. -->
        <div
          class="evp-posts"
          role="group"
          :aria-label="
            t('missions.view.postsInZone', { zone: group.zone.name })
          "
        >
          <MissionCard
            v-for="post in group.posts"
            :key="post.key"
            :org-id="orgId"
            :mission="post"
            :taken-keys="takenKeys"
            :day-count="dayCount"
          />

          <NewPostForm
            :org-id="orgId"
            :zone="group.zone"
            :taken-keys="takenKeys"
          />
        </div>
      </div>
    </template>

    <!-- A post whose zone this catalog cannot identify — its own zone row is
         gone, or the days disagree about which zone it is in. Shown flat
         rather than dropped, with the same "Post" tag, so it stays reachable
         even when it cannot be nested with confidence. -->
    <MissionCard
      v-for="orphan in grouped.orphans"
      :key="orphan.key"
      :org-id="orgId"
      :mission="orphan"
      :taken-keys="takenKeys"
      :day-count="dayCount"
    />
  </template>
</template>

<style scoped>
h2 {
  font-size: 1.125rem;
  margin: 0 0 1rem;
}

.evp-muted {
  color: var(--evp-text-muted);
}

.evp-empty {
  color: var(--evp-text-muted);
  max-width: 60ch;
}

.evp-error {
  background: var(--evp-surface);
  border: 1px solid var(--evp-danger);
  border-left-width: 4px;
  border-radius: 0.375rem;
  color: var(--evp-danger);
  margin: 0 0 1rem;
  max-width: 60ch;
  padding: 0.75rem;
}

.evp-mission-group {
  margin-bottom: 1rem;
}

/* The visual half of "a zone contains its posts" — indentation plus a rail,
   so the grouping survives even for somebody skimming past the text tags. */
.evp-posts {
  border-left: 2px solid var(--evp-border);
  margin: -0.5rem 0 1.5rem 1.25rem;
  padding-left: 1rem;
}

/* Past this width there is room to show a zone and its posts side by side,
   so the pair is folded into one outer card instead of two touching panels —
   `MissionCard.vue`'s own border/background is switched off for both and the
   outer card draws the one border around them. */
@media (min-width: 60rem) {
  .evp-mission-group {
    align-items: flex-start;
    background: var(--evp-surface-raised);
    border: 1px solid var(--evp-border);
    border-radius: 0.5rem;
    display: flex;
    max-width: 72rem;
  }

  .evp-mission-group-zone {
    flex: 1 1 45%;
    min-width: 0;
  }

  .evp-mission-group .evp-posts {
    border-left: 1px solid var(--evp-border);
    flex: 1 1 55%;
    margin: 0;
    min-width: 0;
    padding: 1rem 1rem 1rem 1.25rem;
  }

  .evp-mission-group :deep(.evp-mission) {
    background: transparent;
    border: none;
    border-radius: 0;
    margin-bottom: 0;
    max-width: none;
  }

  /* A rule between posts (and before the "add a post" control below them)
     rather than a gap, since a gap alone would not say where one post's
     fields end and the next one's name begins once the outer card's own
     border is the only one left. */
  .evp-mission-group .evp-posts :deep(.evp-mission) {
    border-bottom: 1px solid var(--evp-border);
    margin-bottom: 0.75rem;
    padding-bottom: 0.75rem;
  }
}
</style>
