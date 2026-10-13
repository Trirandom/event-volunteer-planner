// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { createApp } from 'vue';

import App from './App.vue';
import { i18n } from './i18n';
import { router } from './router';
import './styles.css';

// No Pinia and no query client. This bundle has no session, no coordinator
// routes and no server cache to invalidate — it renders one form, submits it
// once, and is measured against a 1.5 s cold load on 3G-fast (docs/01 §5).
const app = createApp(App);
app.use(router);
app.use(i18n.plugin);
app.mount('#app');
