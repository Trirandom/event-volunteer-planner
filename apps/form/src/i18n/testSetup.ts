// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { config } from '@vue/test-utils';

import { i18n } from './index';

/**
 * The form's tests run in its default language, French: that is what most
 * volunteers see, so it is what the assertions should read like. The plugin
 * is installed for the shared components, which reach vue-i18n by injection.
 */
await i18n.setLocale('fr');
config.global.plugins.push(i18n.plugin);
