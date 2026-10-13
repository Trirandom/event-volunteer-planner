// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { VueQueryPlugin } from '@tanstack/vue-query';
import { createPinia } from 'pinia';
import { createApp } from 'vue';

import { queryClient } from './api/queryClient';
import App from './App.vue';
import { i18n } from './i18n';
import { initialLocale } from './i18n/preference';
import { router } from './router';
import './styles.css';

const app = createApp(App);

// Server state goes through TanStack Query; Pinia holds only genuinely
// client-side state — current org and event, board zoom, selection, filters
// (ADR-0004). Both are installed here so the split is established before the
// first feature has a chance to blur it. The session is server state and lives
// in the query cache accordingly; see `api/queryClient.ts` for why the client
// is built outside this call.
app.use(createPinia());
app.use(VueQueryPlugin, { queryClient });
app.use(router);
app.use(i18n.plugin);

// Awaited before mounting so an English reader never sees a French first
// paint: the catalogue is one small chunk, and a flash of the wrong language
// is also a flash of the wrong `lang` for a screen reader.
await i18n.setLocale(initialLocale());

app.mount('#app');
