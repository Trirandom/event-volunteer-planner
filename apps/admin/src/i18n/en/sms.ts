// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import type fr from '../fr/sms';

export default {
  title: 'SMS configuration',
  intro:
    'OVH SMS credentials for this organisation. Volunteers are notified by SMS using these keys once they are saved here.',
  loadFailed:
    'The server could not be reached, so the current settings could not be loaded.',
  saved: 'Saved.',
  fields: {
    serviceName: 'OVH SMS service name',
    serviceNamePlaceholder: 'sms-xxxxx-1',
    sender: 'Sender',
    senderPlaceholder: 'Name shown on the volunteer’s phone',
    applicationKey: 'Application key',
    applicationSecret: 'Application secret',
    consumerKey: 'Consumer key',
    alreadySet: 'already set, leave blank to keep it',
  },
  error: {
    unavailable:
      'The server could not be reached. Check your connection and try again.',
    forbidden: 'Your role in this organisation does not permit this action.',
  },
} satisfies typeof fr;
