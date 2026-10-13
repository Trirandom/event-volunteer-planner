<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * The admin panel — a placeholder, and honest about it.
 *
 * What it does show is not filler: the user and their memberships come from
 * `GET /api/v1/auth/me`, so this page proves the cookie survives a navigation
 * and that row-level security returned the organisations this user may act in
 * and no others. The planner board, the volunteer list and the rest arrive
 * with their milestones (docs/07).
 *
 * Rendered defensively rather than assuming the router guard's answer still
 * holds: the session query refetches on window focus, so a session that
 * expired while this tab was in the background changes `status` underneath a
 * mounted view.
 */
import { useQueryClient } from '@tanstack/vue-query';
import { RouterLink, useRouter } from 'vue-router';

import { logout, sessionQueryKey, type Session } from '../api/session';
import { useSession } from '../api/useSession';
import { t, type AdminMessageKey } from '../i18n';

const router = useRouter();
const queryClient = useQueryClient();
const { data: session } = useSession();

async function signOut(): Promise<void> {
  await logout();

  // Set rather than invalidate: an invalidation would refetch `me`, and the
  // point of having just signed out is that we already know the answer.
  const anonymous: Session = { status: 'anonymous' };
  queryClient.setQueryData<Session>(sessionQueryKey, anonymous);

  await router.push({ name: 'home' });
}

/** Roles are `member_role` values; this is the only place they are rendered. */
const roleLabels: Readonly<Record<string, AdminMessageKey>> = {
  owner: 'admin.roles.owner',
  coordinator: 'admin.roles.coordinator',
  zone_lead: 'admin.roles.zoneLead',
};

/**
 * An unknown role is shown as it came from the server, not hidden and not
 * turned into "Unknown": a role added to the database enum before this table
 * is updated should read oddly, not read wrongly.
 */
function roleLabel(role: string): string {
  const key = roleLabels[role];
  return key === undefined ? role : t(key);
}
</script>

<template>
  <h1>{{ t('admin.title') }}</h1>

  <template v-if="session?.status === 'authenticated'">
    <p class="evp-identity">
      {{ t('admin.identity.signedInAs') }}
      <strong>{{ session.user.display_name }}</strong>
      <span class="evp-muted">({{ session.user.email }})</span>
    </p>

    <section aria-labelledby="orgs-heading">
      <h2 id="orgs-heading">{{ t('admin.orgs.heading') }}</h2>

      <ul v-if="session.user.memberships.length > 0" class="evp-orgs">
        <li
          v-for="membership in session.user.memberships"
          :key="membership.org_id"
        >
          <span class="evp-org-name">{{ membership.name }}</span>
          <span class="evp-role">{{ roleLabel(membership.role) }}</span>
          <span class="evp-muted evp-slug">/{{ membership.slug }}</span>
          <!-- One link per organisation, not two: festivals and events are
               one list now (`EventsView.vue`), and this is the only place a
               coordinator in more than one org picks between them. -->
          <span class="evp-org-links">
            <RouterLink
              :to="{ name: 'org-events', params: { orgId: membership.org_id } }"
            >
              {{ t('admin.orgs.events') }}
            </RouterLink>
            <RouterLink
              :to="{
                name: 'org-sms-settings',
                params: { orgId: membership.org_id },
              }"
            >
              {{ t('admin.orgs.sms') }}
            </RouterLink>
          </span>
        </li>
      </ul>

      <!-- Reachable: identity is global and membership is per-organisation
           (docs/03), so a user whose last membership was revoked still has an
           account and still signs in. Saying so beats an empty list. -->
      <p v-else>{{ t('admin.orgs.empty') }}</p>
    </section>

    <section aria-labelledby="next-heading" class="evp-panel evp-placeholder">
      <h2 id="next-heading">{{ t('admin.placeholder.heading') }}</h2>
      <p>{{ t('admin.placeholder.body') }}</p>
    </section>

    <p>
      <button class="evp-button" type="button" @click="signOut">
        {{ t('admin.signOut') }}
      </button>
    </p>
  </template>

  <!-- The guard admits nobody without a session, so reaching either branch
       below means the session ended after this view mounted. -->
  <p v-else-if="session?.status === 'unavailable'" role="alert">
    {{ t('admin.unavailable') }}
  </p>
  <p v-else-if="session?.status === 'anonymous'" role="alert">
    {{ t('admin.sessionEnded') }}
    <RouterLink to="/login">{{ t('admin.signInAgain') }}</RouterLink
    >.
  </p>
  <p v-else>{{ t('common.status.loading') }}</p>
</template>

<style scoped>
h1 {
  font-size: 1.75rem;
  letter-spacing: -0.02em;
  margin: 0 0 0.75rem;
}

.evp-identity {
  color: var(--evp-text-muted);
  margin: 0 0 2rem;
}

.evp-identity strong {
  color: var(--evp-text);
}

.evp-muted {
  color: var(--evp-text-muted);
}

h2 {
  font-size: 1.125rem;
  margin: 0 0 0.75rem;
}

.evp-orgs {
  border: 1px solid var(--evp-border);
  border-radius: 0.5rem;
  list-style: none;
  margin: 0;
  overflow: hidden;
  padding: 0;
}

.evp-orgs li {
  /* Wraps rather than truncates: an organisation name the coordinator cannot
     read is not a row, and docs/14 §2 forbids horizontal scrolling at 320 px. */
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.25rem 0.75rem;
  padding: 0.75rem 1rem;
}

/* Hovering a row raises it to the card ground. No new token: `surfaceRaised`
   is proved against every foreground that can appear in a row. */
.evp-orgs li:hover {
  background: var(--evp-surface-raised);
}

.evp-orgs li + li {
  border-top: 1px solid var(--evp-border);
}

.evp-org-name {
  font-weight: 600;
}

/* The role is a border and a word, never a colour alone (docs/14 §2). The tint
   is a hint on top of a label that already says everything. */
.evp-role {
  background: color-mix(in srgb, var(--evp-accent) 12%, var(--evp-surface));
  border: 1px solid var(--evp-border);
  border-radius: 999px;
  color: var(--evp-accent);
  font-size: 0.8125rem;
  font-weight: 500;
  padding: 0.0625rem 0.5rem;
}

.evp-slug {
  font-size: 0.8125rem;
}

.evp-org-links {
  display: flex;
  flex-basis: 100%;
  gap: 1rem;
}

.evp-org-links a {
  color: var(--evp-accent);
  text-decoration: underline;
  text-underline-offset: 0.2em;
}

.evp-placeholder {
  margin: 2rem 0;
}

.evp-placeholder p {
  color: var(--evp-text-muted);
  margin: 0;
  max-width: 60ch;
}
</style>
