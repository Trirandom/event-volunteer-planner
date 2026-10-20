// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import type fr from '../fr/emails';

export default {
  lede: 'Write the message every volunteer will receive with their shifts, then check it person by person in the table below.',
  notSent:
    'Nothing is sent from this page yet: sending arrives with roster publishing. Use it to check who will get what.',
  loadFailed:
    'Part of the plan could not be loaded: some messages below may be incomplete.',
  template: {
    heading: 'Template',
    label: 'Message template',
    reset: 'Restore the default template',
    variables: 'Variables',
    insert: 'Insert {name} into the template',
    hint: '“{example}” uses the first non-empty value: the day’s name for a single day, the festival’s otherwise.',
    unknown:
      '{count, plural, one {Unknown variable, left as written} other {Unknown variables, left as written}}: {names}',
    default:
      '<p>Hi {firstName},</p><p>Thank you for volunteering at {eventOrFestival}!</p><p><strong>Here are your volunteer shifts:</strong></p>{assignations}<p>If anything is wrong with one of the shifts you have been given, please let us know by replying to this email.</p><p>See you soon</p><p><strong>The {organizationName} team</strong></p>',
  },
  preview: {
    heading: 'Preview',
    recipient: 'Volunteer',
    frame: 'Preview of the message for {name}',
    empty: 'Nobody is enrolled in this period: there is nobody to write to.',
  },
  table: {
    heading: 'Messages per volunteer',
    caption: 'The message each volunteer will receive',
    region: 'Messages table',
    count:
      '{shown, plural, one {# volunteer shown} other {# volunteers shown}} of {total}',
    filter: 'Filter by name',
    onlyEmpty: 'Only volunteers with no shifts',
    columns: {
      name: 'Volunteer',
      shifts: 'Shifts',
      message: 'Message',
    },
    shiftCount:
      '{count, plural, =0 {No shifts} one {# shift} other {# shifts}}',
    show: 'Preview',
    showLabel: 'Show {name}’s message in the preview',
    noMatch: 'No volunteer matches this filter.',
  },
  message: {
    line: '{day}, {start}–{end}: {mission}',
    lineAcrossDays: '{day}, {start} – {endDay}, {end}: {mission}',
    none: 'You have not been given any shifts yet.',
  },
} satisfies typeof fr;
