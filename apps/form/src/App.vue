<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * The footer notice is not decoration. Volunteers interacting with a
 * deployment are network users under AGPL §13 exactly as coordinators are, so
 * the source link is a product requirement (CONTRIBUTING, docs/09 §6).
 *
 * The header is the other half of the same idea and is not decoration either:
 * a volunteer arrives from a link in a message, on a phone, with no way to
 * tell this page from any other form. The mark says whose it is before the
 * first question is read.
 *
 * `BrandMark` is an `<img>`, so it costs one cached request and nothing in the
 * JavaScript bundle measured against the 1.5 s cold load in docs/01 §5.
 */
import { BrandMark, LocaleSwitcher, SourceNotice } from '@evp/shared';
import type { Locale } from '@evp/shared/i18n';
import { RouterView, useRoute, useRouter } from 'vue-router';

import { locale, t } from './i18n';

const route = useRoute();
const router = useRouter();

/**
 * The choice goes into `?lang=`, and the router guard applies it
 * (`router/index.ts`): one path for a link that arrives with `?lang=` and a
 * volunteer who presses the button, so they cannot behave differently.
 * `replace`, because a language is not a place the back button should visit.
 * The token in `?t=` is carried over with the rest of the query.
 */
function chooseLocale(next: Locale): void {
  void router.replace({ query: { ...route.query, lang: next } });
}
</script>

<template>
  <div class="evp-page">
    <!-- Not a link: there is nowhere for a volunteer to go from here. A mark
         that looks clickable and is not is worse than a mark that does not. -->
    <div class="evp-form-header">
      <BrandMark :size="28" />
      <span class="evp-form-header-name">{{ t('productName') }}</span>
      <LocaleSwitcher
        class="evp-form-header-locale"
        :current="locale"
        @select="chooseLocale"
      />
    </div>

    <main id="main">
      <RouterView />
    </main>

    <footer class="evp-footer">
      <SourceNotice />
    </footer>
  </div>
</template>

<style scoped>
.evp-form-header-locale {
  margin-left: auto;
}

.evp-footer {
  border-top: 1px solid var(--evp-border);
  margin-top: 2.5rem;
  padding-top: 1rem;
}
</style>
