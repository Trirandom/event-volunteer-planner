<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * Event details: the settings behind the board, one card per event in scope.
 *
 * Scope-following rather than day-only, for the same reason the missions
 * section is (`PlanDetailView.vue`). A coordinator setting up Soundclash 26
 * fixes six days' hours, doors and colours in one sitting, and a page that
 * only ever showed the selected day would make that six navigations with no
 * way to see that Saturday and Sunday had ended up the same colour. Narrowed
 * to one day it is that day's card, which is the other half of the same idea.
 *
 * The section is coordinator-visible and its delete button is not: `DELETE
 * /events/{event}` is owner-only (docs/04 §4), so the membership is consulted
 * for the *org this page is under*, never "is this person an owner anywhere".
 */
import { computed } from 'vue';
import { useRouter } from 'vue-router';

import { usePlanScope } from '../api/usePlan';
import { useSession } from '../api/useSession';
import HelpModal from '../components/HelpModal.vue';
import EventDetailsForm from '../components/EventDetailsForm.vue';
import NewEventForm from '../components/NewEventForm.vue';
import { locale, t } from '../i18n';
import { useRouteParam } from '../router/params';

const router = useRouter();
const orgId = useRouteParam('orgId');
const festivalId = useRouteParam('festivalId');
const eventId = useRouteParam('eventId');

const { data: session } = useSession();

const isOwner = computed(() => {
  const value = session.value;
  if (value?.status !== 'authenticated') {
    return false;
  }
  return value.user.memberships.some(
    (membership) =>
      membership.org_id === orgId.value && membership.role === 'owner',
  );
});

const { scope, isPending } = usePlanScope(orgId, festivalId, eventId);

/** At event scope this is the one day; at festival scope it is every day of
 * the production, in the order the day strip shows them. */
const events = computed(() => {
  const value = scope.value;
  if (value === null) {
    return [];
  }
  return value.selected === null ? value.days : [value.selected];
});

/**
 * What a new day would be added to, or `null` when the page is a standalone
 * event and there is no production to add to.
 *
 * Narrowed to one day this still answers with that day's festival rather than
 * with the day: adding a day while reading Saturday adds it to Soundclash 26,
 * which is the only reading that makes sense — a day cannot contain a day.
 */
const production = computed(() => {
  const value = scope.value;
  if (value === null) {
    return null;
  }
  const festival = value.festival;
  return festival === null
    ? {
        festivalId: null,
        name: value.selected?.name ?? '',
        timezone: value.selected?.timezone ?? '',
      }
    : {
        festivalId: festival.id,
        name: festival.name,
        timezone: festival.timezone,
      };
});

/**
 * The slugs already spoken for, for the form's own duplicate check.
 *
 * Every day this page covers, which at day scope is still the whole festival
 * (`scope.days`) rather than the one card below — the clash the server would
 * report is against the org, and the days are the part of it this page knows.
 */
const takenSlugs = computed(() =>
  (scope.value?.days ?? []).map((day) => day.slug),
);

/**
 * Where to go once an event is gone.
 *
 * Back to the festival if it had one — its other days are still there and the
 * coordinator is mid-setup — and to the events list otherwise, because a
 * standalone event that has been deleted leaves no page behind. Either way
 * the current URL must not survive: it names a row the server will now answer
 * `404` for.
 *
 * The festival comes from the event that was deleted rather than from `scope`,
 * which is exactly the state the delete has just invalidated: reading it here
 * gave `null` and sent every deletion to the events list, by way of one frame
 * of "this page could not be loaded".
 */
async function afterDelete(deleted: {
  readonly id: string;
  readonly festivalId: string | null;
}): Promise<void> {
  await (deleted.festivalId === null
    ? router.push({ name: 'org-events', params: { orgId: orgId.value } })
    : router.push({
        name: 'org-festival-details',
        params: { orgId: orgId.value, festivalId: deleted.festivalId },
      }));
}
</script>

<template>
  <p v-if="isPending">{{ t('common.status.loading') }}</p>

  <template v-else>
    <HelpModal :title="t('events.detailsPage.helpTitle')">
      <p v-if="events.length > 1">
        {{ t('events.detailsPage.allDays') }}
      </p>
      <p>
        <strong>{{ t('events.detailsPage.help.workingHoursTerm') }}</strong> —
        {{ t('events.detailsPage.help.workingHours') }}
      </p>
      <p>
        <strong>{{ t('events.detailsPage.help.doorsTerm') }}</strong> —
        {{ t('events.detailsPage.help.doors') }}
      </p>
      <p>
        <strong>{{ t('events.detailsPage.help.colourTerm') }}</strong> —
        {{ t('events.detailsPage.help.colour') }}
      </p>
    </HelpModal>

    <EventDetailsForm
      v-for="day in events"
      :key="day.id"
      :org-id="orgId"
      :event="day"
      :locale="locale"
      :can-delete="isOwner"
      @deleted="afterDelete"
    />

    <p v-if="events.length === 0" class="evp-muted">
      {{ t('events.detailsPage.noDays') }}
    </p>

    <!-- Below the cards rather than above them: the section is read far more
         often than it is added to, and a form that pushed six days' hours off
         the first screen would be in the way every time except the first. It
         is the last thing on the page for the same reason it is the last
         thing a coordinator does here. -->
    <NewEventForm
      v-if="production !== null"
      :org-id="orgId"
      :festival-id="production.festivalId"
      :production-name="production.name"
      :timezone="production.timezone"
      :taken-slugs="takenSlugs"
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
</style>
