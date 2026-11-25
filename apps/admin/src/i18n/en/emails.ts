// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import type fr from '../fr/emails';

export default {
  lede: 'Write the message every volunteer will receive with their shifts, then check it person by person in the table below.',
  notSent:
    'No volunteer receives anything from this page yet: real sending arrives with roster publishing. The test send sends every message to your own address instead.',
  loadFailed:
    'Part of the plan could not be loaded: some messages below may be incomplete.',
  template: {
    heading: 'Template',
    subject: 'Subject',
    subjectDefault: 'Your volunteer shifts – {eventOrFestival}',
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
  test: {
    heading: 'Test send',
    address: 'Test address',
    placeholder: 'you@example.com',
    send: 'Send the test',
    sending: 'Sending…',
    hint: '{count, plural, one {# volunteer’s message goes} other {All # volunteers’ messages go}} to this address and nowhere else, rendered by the server exactly as they will be sent. Each subject starts with “[Test: name]”.',
    invalidAddress: 'Enter a single email address.',
    sent: '{sent, plural, =0 {No message sent} one {# message sent} other {# messages sent}} to {address}.',
    optedOut:
      '{count, plural, one {# volunteer opted out of email and will not get one} other {# volunteers opted out of email and will not get one}}.',
    noAddress:
      '{count, plural, one {No email address, reach them another way} other {No email address, reach them another way}}: {names}',
    stopped: {
      refused: 'The mail server refused {name}’s message: {detail}',
      relay_unavailable:
        'The mail server could not be reached: sending stopped at {name}’s message. Try again later.',
      render_failed: '{name}’s message could not be composed: {detail}',
    },
    failed: {
      invalid: 'The send was refused: {detail}',
      forbidden: 'Only coordinators can send a test.',
      refused: 'The send was refused: {detail}',
      unavailable: 'The server is not answering. Try again in a moment.',
    },
  },
  editor: {
    toolbar: 'Formatting',
    bold: 'Bold',
    italic: 'Italic',
    underline: 'Underline',
    bulletList: 'Bulleted list',
    orderedList: 'Numbered list',
    link: 'Link',
    undo: 'Undo',
    redo: 'Redo',
    linkUrl: 'Link address',
    linkPlaceholder: 'https://',
    linkApply: 'Apply',
    linkRemove: 'Remove link',
    linkCancel: 'Close',
    linkInvalid:
      'Only web (https://…) and email (mailto:…) addresses can be linked in a message.',
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
