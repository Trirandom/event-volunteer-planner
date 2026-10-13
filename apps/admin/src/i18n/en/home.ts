// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import type fr from '../fr/home';

export default {
  hero: {
    lead: 'Plan who is where, when — without double-booking anyone.',
    body: 'Coordinator tooling for volunteer-run events: availability in, shifts out, and a schedule the people working it can actually rely on.',
    openAdmin: 'Open the admin panel',
    signIn: 'Sign in',
  },
  features: {
    heading: 'What it does',
    availability: {
      title: 'Collects availability',
      body: 'As real time ranges, not checkboxes — a volunteer free from 14:00 to 19:30 can say so.',
    },
    refusal: {
      title: 'Refuses double-bookings',
      body: 'In the database rather than in the interface, so two coordinators working at once cannot create one.',
    },
    notify: {
      title: 'Tells everyone their own schedule',
      body: 'By email, SMS or a calendar subscription, in the event’s timezone.',
    },
  },
  statusNote:
    'This deployment is an early build: sign-in works, the planner itself is still being built.',
  about: {
    heading: 'About this deployment',
  },
} satisfies typeof fr;
