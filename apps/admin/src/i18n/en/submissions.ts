// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import type fr from '../fr/submissions';

export default {
  standalone: {
    title: 'No form behind this event',
    body: 'Volunteers apply to a whole production, not to a single date (docs/09), so the form and its submissions hang off a festival. This event stands on its own — put it under a festival to give it one.',
  },
  loadFailed: 'The submissions could not be loaded.',
  lede: {
    festival:
      '{total, plural, one {# submission} other {# submissions}} for this festival. Every window each volunteer declared, in its own day’s timezone.',
    day: '{shown} of {total} {total, plural, one {submission} other {submissions}} offer time on {day}, narrowed to those windows. Pick “Whole festival” above for the rest.',
  },
  empty: {
    none: 'Nobody has answered the form yet. Load the worked example from the events page to see what this page looks like with a festival’s worth of volunteers in it.',
    day: 'Nobody offered time on this day. The other days still have {total, plural, one {# submission} other {# submissions}} between them.',
  },
  card: {
    submitted: 'Submitted {date}, {time}',
    submittedAt: 'Submitted {when}',
    total:
      '{duration} offered across {days, plural, one {# day} other {# days}}',
    noAvailability: 'No availability declared — worth a nudge.',
  },
  window: {
    range: '{startDate}, {startTime} – {endTime}',
    rangeAcrossDays: '{startDate}, {startTime} – {endDate}, {endTime}',
    duration: '{duration} ({zone})',
  },
  table: {
    caption: 'Volunteer submissions',
    region: 'Submissions table',
    columns: {
      name: 'Name',
      submitted: 'Submitted',
      availability: 'Availability',
    },
    filter: {
      label: 'Filter the “{column}” column',
      placeholder: 'Filter…',
      any: 'All',
      none: 'None declared',
      day: 'On {day}',
    },
    count:
      'Showing {shown, plural, =0 {no submissions} one {# submission} other {# submissions}} of {total}',
    reset: 'Clear filters',
    noMatch: 'No submission matches these filters.',
    availability: '{duration} · {days, plural, one {# day} other {# days}}',
    showWindows: 'Show {count, plural, one {the window} other {all # windows}}',
    hideWindows: 'Hide',
    noAvailability: 'None — worth a nudge',
    editOnBoard: 'Adjust on the Availability page',
  },
  review: {
    link: '{count, plural, =0 {Nothing to review} one {# submission to review →} other {# submissions to review →}}',
    back: '← All submissions',
    title: 'Submissions to review',
    loadFailed: 'The submissions to review could not be loaded.',
    lede: '{count, plural, =0 {Everything is handled.} one {One submission could not join the pool on its own: review it below.} other {# submissions could not join the pool on their own: review them below.}}',
    empty:
      'Every submission received found its place. Those too close to an existing volunteer, or sent too fast for a person, will show up here.',
    unnamed: 'Unreadable submission',
    received: 'Received on {date} at {time}',
    why: 'Why it is waiting',
    reasons: {
      tooFast: 'Sent in under 3 seconds',
      emailInUse: 'Email address already used by another volunteer',
      unmappable: 'The answers cannot be read',
      similar:
        '{count, plural, one {Name close to an existing volunteer} other {Name close to # existing volunteers}}',
    },
    sent: 'What was sent',
    email: 'Email address',
    phone: 'Phone',
    availability: 'Availability',
    noAvailability: 'No availability declared.',
    window: '{day} — {date}, {start}–{end}',
    candidates: 'Possible existing volunteers',
    noCandidates: 'No volunteer looks like this person.',
    similarity: 'Name {percent}% similar',
    sameLastName: 'Same last name',
    samePhone: 'Same phone',
    actions: {
      match: 'This is them',
      createNew: 'New volunteer',
      reconcile: 'Run matching again',
      reject: 'Reject',
    },
    rejectDialog: {
      title: 'Reject {name}’s submission?',
      body: 'It stays recorded, but is applied to nobody: no volunteer, no availability.',
      reason: 'Reason (optional, for the team)',
    },
    done: {
      applied: '{name}’s submission joined the pool.',
      appliedWithoutEmail:
        '{name}’s submission joined the pool without its email address: it already belongs to another volunteer.',
      rejected: '{name}’s submission was rejected.',
      stillWaiting:
        '{name}’s submission still looks like an existing volunteer: choose below.',
    },
    errors: {
      conflict:
        'Someone else already handled this submission. The list has been reloaded.',
      unavailable:
        'The server is not answering. Nothing was changed; try again in a moment.',
    },
  },
  duration: {
    minutes: '{minutes} min',
    hours: '{hours} h',
    hoursMinutes: '{hours} h {minutes}',
  },
} satisfies typeof fr;
