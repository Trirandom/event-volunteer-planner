// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import type fr from '../fr/plan';

export default {
  nav: {
    label: 'Sections',
    details: 'Event details',
    missions: 'Missions',
    shifts: 'Shifts',
    form: 'Form',
    assignments: 'Assignments',
    submissions: 'Form submissions',
    availability: 'Availability',
    emails: 'Emails',
  },
  scope: {
    label: 'Festival scope',
    wholeFestival: 'Whole festival',
  },
  daySummaryMeta: '{status} · /{slug}',
  festivalFailed:
    'The festival this day belongs to could not be loaded, so only this day is shown.',
  loadFailed: 'This page could not be loaded.',
  status:
    '{status, select, draft {draft} planning {planning} published {published} running {running} archived {archived} other {{status}}}',
  period: {
    sameDay: '{startDate}, {startTime} – {endTime} ({timeZone})',
    acrossDays: '{startDate}, {startTime} – {endDate}, {endTime} ({timeZone})',
    dates: '{startDate} – {endDate}',
  },
} satisfies typeof fr;
