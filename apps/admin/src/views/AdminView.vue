<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * The admin panel: who is signed in, the organisations they may act in, and
 * the way out.
 *
 * The user and their memberships come from `GET /api/v1/auth/me`, so the list
 * is exactly the organisations row-level security returned for this user and
 * no others. This is where a coordinator in more than one organisation picks
 * between them; the header's organisation name links back here.
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
          class="evp-card evp-org"
        >
          <div class="evp-org-head">
            <span class="evp-org-name">{{ membership.name }}</span>
            <span class="evp-role">{{ roleLabel(membership.role) }}</span>
          </div>
          <span class="evp-muted evp-slug">/{{ membership.slug }}</span>
          <!-- The same two destinations as the header, per organisation: the
               header follows the org on screen, and this is the only place a
               coordinator in more than one org picks a different one. -->
          <span class="evp-org-links">
            <RouterLink
              class="evp-button evp-button--primary"
              :to="{ name: 'org-events', params: { orgId: membership.org_id } }"
            >
              {{ t('admin.orgs.events') }}
            </RouterLink>
            <RouterLink
              class="evp-button"
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

    <p class="evp-signout">
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
/* The landing page's type register (HomeView.vue), so signing in does not
   drop the application into a second, quieter typeface scale. */
h1 {
  font-size: 2rem;
  font-weight: 800;
  letter-spacing: -0.03em;
  line-height: 1.1;
  margin: 0 0 0.5rem;
}

.evp-identity {
  color: var(--evp-text-muted);
  margin: 0 0 2.5rem;
}

.evp-identity strong {
  color: var(--evp-text);
}

/* Vue condenses the whitespace between two elements on separate lines to
   nothing, which ran the name into its parenthesis. A margin, not a literal
   space in the template, which would be a bare string to the i18n lint. */
.evp-identity strong + .evp-muted {
  margin-inline-start: 0.25em;
}

.evp-muted {
  color: var(--evp-text-muted);
}

h2 {
  font-size: 1.25rem;
  font-weight: 800;
  letter-spacing: -0.02em;
  margin: 0 0 1rem;
}

/* auto-fill rather than a breakpoint: one card per row when one is what fits,
   which is also what 400% zoom does (docs/14 §2). */
.evp-orgs {
  display: grid;
  gap: 1.25rem;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 20rem), 1fr));
  list-style: none;
  margin: 0;
  padding: 0;
}

.evp-org {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.evp-org-head {
  /* Wraps rather than truncates: an organisation name the coordinator cannot
     read is not a card. */
  align-items: baseline;
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 0.75rem;
}

.evp-org-name {
  font-size: 1.125rem;
  font-weight: 700;
  overflow-wrap: anywhere;
}

/* The role is a border and a word, never a colour alone (docs/14 §2). The tint
   is a hint on top of a label that already says everything. */
.evp-role {
  background: color-mix(in srgb, var(--evp-accent) 12%, var(--evp-surface));
  border: 1px solid var(--evp-border);
  border-radius: 999px;
  color: var(--evp-accent);
  font-size: 0.8125rem;
  font-weight: 600;
  padding: 0.0625rem 0.5rem;
}

.evp-slug {
  font-size: 0.8125rem;
}

.evp-org-links {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-top: 1rem;
}

.evp-org-links .evp-button {
  border-radius: var(--evp-radius-md);
}

.evp-signout {
  margin: 2.5rem 0 0;
}
</style>
