// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import type fr from '../fr/shell';

export default {
  skipToContent: 'Skip to content',
  nav: {
    label: 'Primary',
    events: 'Events',
    sms: 'SMS configuration',
    admin: 'Admin panel',
    signIn: 'Sign in',
  },
  org: {
    label: 'Organisation',
  },
  theme: {
    toDark: 'Switch to dark theme',
    toLight: 'Switch to light theme',
  },
} satisfies typeof fr;
