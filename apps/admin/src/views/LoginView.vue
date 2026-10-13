<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * Sign-in.
 *
 * Password is the only method implemented, and is deliberately the fallback
 * rather than the intended front door (ADR-0031): it exists so that a
 * deployment has a way in before SMTP or an identity provider is configured.
 * Magic links and OIDC land on the same session model, at which point this
 * form gains siblings above it — the ones rendered from
 * `GET /api/v1/auth/providers` (docs/04 §3), so that adding a provider stays a
 * config file and a restart with no frontend rebuild.
 *
 * There is no "create an account" and no "forgot your password" link, and
 * their absence is the design: a second user arrives by invitation, and a
 * forgotten password by magic link. A link here that leads nowhere would be a
 * promise this build does not keep.
 *
 * docs/14 §2, WCAG 2.2 SC 3.3.8 — no cognitive function test in the login
 * path, and nothing blocks pasting into the password field, which is what a
 * password manager does.
 */
import { BrandMark } from '@evp/shared';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import {
  login,
  sessionQueryKey,
  type LoginRejection,
  type Session,
} from '../api/session';
import { t } from '../i18n';
import { afterLoginTarget } from '../router/redirect';

const route = useRoute();
const router = useRouter();
const queryClient = useQueryClient();

const email = ref('');
const password = ref('');

/**
 * The last refusal, or `null`. Held separately from the mutation's own error
 * state because `login()` never rejects: a wrong password is an outcome, not
 * an exception, and routing it through `catch` would put the one failure users
 * actually hit on the path reserved for the ones they never see.
 */
const rejection = ref<LoginRejection | null>(null);

const { mutate, isPending } = useMutation({
  mutationFn: async () => login(email.value, password.value),
  onSuccess: async (result) => {
    if (!result.ok) {
      rejection.value = result.rejection;
      return;
    }

    // Seed the cache from the login response rather than letting the guard
    // re-ask: the body of a successful login is the same `UserResponse` that
    // `GET /auth/me` returns, by construction on the server, so the extra
    // round trip would buy nothing but a slower transition.
    const session: Session = { status: 'authenticated', user: result.user };
    queryClient.setQueryData<Session>(sessionQueryKey, session);

    // `replace`, not `push`: the login page must not be what Back returns to
    // once it has done its job.
    await router.replace(afterLoginTarget(route.query['redirect']));
  },
});

const errorMessage = computed(() => {
  const current = rejection.value;
  if (current === null) {
    return null;
  }

  switch (current.reason) {
    case 'unavailable':
      return t('login.error.unavailable');
    case 'invalid-credentials':
      // One sentence for an unknown address, an account with no password and
      // a wrong password, in every language — any difference between the
      // three is an account oracle (docs/12).
      return t('login.error.invalidCredentials');
    case 'refused':
      // A refusal this build has no message for: the server's own sentence
      // is better than a generic one that hides what it said.
      return current.detail;
  }
});

/** Whether to mark the two fields themselves as invalid. */
const credentialsRejected = computed(
  () => rejection.value?.reason === 'invalid-credentials',
);

function submit(): void {
  // Cleared on every attempt, so a stale message cannot sit under a request
  // that is still in flight and look like its answer.
  rejection.value = null;
  mutate();
}
</script>

<template>
  <div class="evp-login-card evp-panel">
    <!-- The mark stands alone here, so unlike the header it is labelled: there
         is no adjacent product name for it to be redundant with. -->
    <BrandMark :size="44" :label="t('common.productName')" />

    <h1>{{ t('login.title') }}</h1>
    <p class="evp-login-intro">{{ t('login.intro') }}</p>

    <!-- No `novalidate`: `required` and `type="email"` let the browser catch
       an empty or malformed address before a round trip, with a message it
       has already translated and that assistive technology already knows.
       Semantics before ARIA (docs/14 §2) — a hand-rolled validator here
       would be a worse copy of one every browser ships. -->
    <form class="evp-login" @submit.prevent="submit">
      <!-- `role="alert"` rather than a polite live region: a refusal is the
         answer to something the user just did, and it must interrupt. The
         element is only rendered when there is something to say, so a screen
         reader announces it on insertion. -->
      <p
        v-if="errorMessage !== null"
        id="login-error"
        class="evp-error"
        role="alert"
      >
        {{ errorMessage }}
      </p>

      <!-- Wrapped *and* `for`/`id`: either alone associates the label, but the
         pair also makes the text itself a click target, which is the whole
         24x24 label rather than the 16px box (docs/14 §2). -->
      <p class="evp-field">
        <label for="login-email">
          <span>{{ t('login.email') }}</span>
          <input
            id="login-email"
            v-model="email"
            type="email"
            name="email"
            autocomplete="username"
            inputmode="email"
            required
            :aria-invalid="credentialsRejected"
            :aria-describedby="
              errorMessage === null ? undefined : 'login-error'
            "
          />
        </label>
      </p>

      <p class="evp-field">
        <label for="login-password">
          <span>{{ t('login.password') }}</span>
          <input
            id="login-password"
            v-model="password"
            type="password"
            name="password"
            autocomplete="current-password"
            required
            :aria-invalid="credentialsRejected"
            :aria-describedby="
              errorMessage === null ? undefined : 'login-error'
            "
          />
        </label>
      </p>

      <button
        class="evp-button evp-button--primary"
        type="submit"
        :disabled="isPending"
      >
        <!-- The label itself changes, so the pending state is not carried by the
           disabled styling alone (docs/14 §2). -->
        {{ isPending ? t('login.submitting') : t('login.submit') }}
      </button>
    </form>

    <p class="evp-note">{{ t('login.note') }}</p>
  </div>
</template>

<style scoped>
/* A card rather than a bare form on the page. Sign-in is the one screen an
   unauthenticated visitor is sent to from elsewhere, and a bounded surface with
   the mark on it is what says "you are in the right place" before the fields
   are read. */
.evp-login-card {
  margin: 0 auto;
  max-width: 26rem;
  padding: 1.75rem 1.5rem 1.5rem;
}

.evp-login-card h1 {
  font-size: 1.5rem;
  letter-spacing: -0.02em;
  margin: 1rem 0 0.25rem;
}

.evp-login-intro {
  color: var(--evp-text-muted);
  margin: 0 0 1.5rem;
}

.evp-login {
  max-width: 24rem;
}

/* The field sits on the card, not on the page, so it needs the page's own
   ground to stay distinguishable from what is behind it. */
.evp-login .evp-field input {
  background: var(--evp-surface);
}

.evp-login .evp-button {
  width: 100%;
}

.evp-error {
  background: var(--evp-surface);
  /* A border on the leading edge as well as colour: a red word on a grey panel
     is not a message a colour-blind reader can pick out of the page. */
  border: 1px solid var(--evp-danger);
  border-left-width: 4px;
  border-radius: 0.375rem;
  color: var(--evp-danger);
  margin: 0 0 1.25rem;
  padding: 0.75rem;
}

.evp-note {
  border-top: 1px solid var(--evp-border);
  color: var(--evp-text-muted);
  font-size: 0.875rem;
  margin: 1.75rem 0 0;
  max-width: 40ch;
  padding-top: 1rem;
}
</style>
