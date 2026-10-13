// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The timeline's ruler (`board/*`), shared by the shift board and the
 * assignation board: what the axis itself writes on screen.
 */
export default {
  fold: {
    /** The mark drawn over a folded stretch of night; a symbol, not a word. */
    glyph: '⋯',
    /** Length of a folded stretch, written under the mark: short unit. */
    hours: '{hours, number} h',
    /** The same, once it is two days or more: short unit for « jours ». */
    days: '{days, number} j',
  },
  /** Ruler labels at a day’s published opening hours; `time` is a clock
   * time. Short: the label sits between two ticks. */
  publicMark: {
    doors: 'ouverture {time}',
    close: 'fermeture {time}',
  },
};
