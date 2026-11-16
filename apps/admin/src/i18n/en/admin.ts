// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import type fr from '../fr/admin';

export default {
  title: 'Admin panel',
  identity: {
    signedInAs: 'Signed in as',
  },
  orgs: {
    heading: 'Your organisations',
    events: 'Events',
    sms: 'SMS configuration',
    empty:
      'You are not a member of any organisation yet. Ask an organiser to invite you.',
  },
  roles: {
    owner: 'Owner',
    coordinator: 'Coordinator',
    zoneLead: 'Zone lead',
  },
  signOut: 'Sign out',
  unavailable:
    'The server could not be reached, so your organisations could not be loaded.',
  sessionEnded: 'Your session has ended.',
  signInAgain: 'Sign in again',
} satisfies typeof fr;
