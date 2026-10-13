// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import type fr from '../fr/availability';

export default {
  title: 'Availability',
  help: {
    intro:
      'One row per volunteer, one chip per stretch they can work. Drag a chip’s edge to lengthen or shorten it — push an edge onto its neighbour and the two become one — and drag across empty track to declare a new stretch.',
    keys: {
      home: 'Home',
      end: 'End',
      ctrl: 'Ctrl',
      wheel: '+ wheel',
    },
    does: {
      split: 'Divides a chip in two.',
      remove: 'Removes a chip.',
      arrows:
        'With an edge focused, moves it by {minutes, plural, one {# minute} other {# minutes}}.',
      homeEnd: 'Runs a focused edge to the ends of the day.',
      wheel: 'Over the board, zooms it — the same as the slider above.',
    },
    outro:
      'Every change is saved as it is made. A hatched chip is one a volunteer offered and nobody has touched; a solid one has been changed here — and either way, what they filled in on the form is kept exactly as it arrived.',
  },
  zoom: {
    label: 'zoom',
    unit: '(px / hour)',
  },
  rosterFailed:
    'The roster could not be loaded, so this board would be missing people.',
  empty: {
    lead: 'Nobody is enrolled on the days in view yet. Availability arrives with the volunteer form —',
    link: 'see what has come in',
  },
  columnHead: 'Volunteers',
  fold: {
    show: 'Show the {length} with no day on them, from {start} to {end}',
    hide: 'Hide the {length} with no day on them again, from {start} to {end}',
  },
  row: {
    nothingDeclared: 'nothing declared',
    resetLabel: 'Reset {name}’s availability to what they submitted',
    resetTitle: 'Reset to submitted availability',
  },
  chip: {
    label: '{name}, {day}, {start} to {end}',
    startHandle: 'Start of {name}, {day}, {start} to {end}',
    endHandle: 'End of {name}, {day}, {start} to {end}',
    hours: '{start}–{end}',
    split: 'split',
    splitLabel: 'Divide {name}, {day}, {start} to {end} in two',
    removeLabel: 'Remove {name}, {day}, {start} to {end}',
  },
  notice: {
    merged: 'Those two stretches met, so they are one now.',
    notEnrolled:
      '{name} is not enrolled on {day}, so there is nothing to declare there.',
    tooShort: 'That stretch is too short to divide — drag an edge instead.',
    split:
      'Divided into two stretches, {minutes, plural, one {# minute} other {# minutes}} apart. Drag the new edges to where the break really is.',
    removed: 'Removed {start} to {end} on {day}.',
    reset: '{name}’s availability is back to what they submitted.',
  },
  rejection: {
    unavailable:
      'The server could not be reached, so that change was not saved.',
  },
} satisfies typeof fr;
