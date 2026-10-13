// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { sharedEn } from '@evp/shared/i18n';

import type fr from '../fr';

export default {
  shared: sharedEn,
  productName: 'Event Volunteer Planner',
  form: {
    title: 'Volunteer form',
    loading: 'Loading the form…',
    required: 'required',
    requiredLegend: 'Questions marked “required” must be answered.',
    yes: 'Yes',
    no: 'No',
    choose: 'Choose…',
    noMissions: 'No missions offered yet.',
    adultsOnly: '18+ only',
    submit: 'Send',
    submitting: 'Sending…',
    draftRestored: 'Your earlier answers were found on this device.',
    draftDiscard: 'Clear and start over',
    honeypot: 'Do not fill in this field',
    unreachable:
      'Could not reach the server. Check your connection: your answers are kept on this device, you can try again.',
    retry: 'Try again',
  },
  errors: {
    summaryTitle:
      '{count, plural, one {One answer needs fixing} other {# answers need fixing}}',
    required: 'This question is required.',
    email:
      'This email address does not look valid (for example: name@example.com).',
    phone:
      'This number does not look valid. Digits, spaces and “+” are accepted.',
    date: 'Choose a date.',
    consent: 'Tick this box to be able to send the form.',
    availabilityRequired: 'Tell us at least one time you are available.',
    partialEmpty: 'Choose at least one time slot, or answer “No”.',
    stale:
      'The form changed while you were filling it in. It has been reloaded with your answers: check them, then send again.',
    emailTaken:
      'This email address is already used by another volunteer. Use your own, or contact the organisers.',
    captcha:
      'The automatic anti-bot check did not complete. Your answers are kept: reload the page, then send the form again.',
    refused: 'The form could not be sent. Check your answers and try again.',
  },
  availability: {
    yes: 'Yes',
    partial: 'Partly',
    no: 'No',
    hours: '{start} → {end}',
    nextDay: '(+1)',
    nextDaySpoken: 'the next day',
    publicHours: 'Public: {start} → {end}',
    timeZone: 'Times in {zone}.',
    allDays: 'Every day of {event}:',
    allDaysSet: '{count, plural, one {# day} other {# days}}: {answer}',
    chipsLegend: 'When?',
    part: {
      morning: 'Morning',
      afternoon: 'Afternoon',
      evening: 'Evening',
      night: 'Night',
    },
    custom: 'Other times…',
    from: 'From',
    to: 'To',
    timeHint: 'For example 14:30',
    add: 'Add',
    remove: 'Remove',
    removeSpoken: 'Remove {start} → {end}',
    selected: 'Available:',
    adjusted:
      'Adjusted to {start} → {end} (event hours, in {step}-minute steps).',
    unreadable: 'Time not recognised. Write for example 14:30.',
    outside: 'Outside the event hours ({start} → {end}).',
    status: {
      unset: '{day}: no answer',
      all: '{day}: available',
      no: '{day}: not available',
      partial: '{day}: available {ranges}',
      partialEmpty: '{day}: partly, no time slot chosen',
    },
    rangeSpoken: 'from {start} to {end}',
  },
  thanks: {
    title: 'Thank you!',
    body: 'Your answers have been sent. The team will get back to you by email.',
    bodyToken:
      'Your answers have been saved. You can change them at any time with the same link.',
  },
  unavailable: {
    title: 'This link is not available',
    body: 'This form does not exist, is no longer open, or the link has been revoked. Please contact the organisation that sent it to you.',
  },
} satisfies typeof fr;
