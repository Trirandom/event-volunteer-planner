// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import type fr from '../fr/common';

export default {
  productName: 'Event Volunteer Planner',
  actions: {
    save: 'Save',
    cancel: 'Cancel',
    close: 'Close',
    delete: 'Delete',
    edit: 'Edit',
    retry: 'Retry',
    undo: 'Undo',
  },
  status: {
    loading: 'Loading…',
    saving: 'Saving…',
    loadFailed: 'Loading failed.',
  },
} satisfies typeof fr;
