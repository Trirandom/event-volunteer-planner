// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import type fr from '../fr/board';

export default {
  fold: {
    glyph: '⋯',
    hours: '{hours, number} h',
    days: '{days, number} d',
  },
  publicMark: {
    doors: 'doors {time}',
    close: 'close {time}',
  },
} satisfies typeof fr;
