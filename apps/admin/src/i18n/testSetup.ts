// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { config } from '@vue/test-utils';

import { i18n } from './index';

/**
 * Every admin test runs in English, whatever the machine's language: a test
 * asserting on text must not pass on one laptop and fail on another. English
 * rather than the French default because it is what the suite was written
 * against; a test that is *about* French sets it and restores it.
 *
 * The plugin is installed globally so the shared components, which reach
 * vue-i18n by injection rather than by import, render in any mounted tree.
 */
await i18n.setLocale('en');
config.global.plugins.push(i18n.plugin);
