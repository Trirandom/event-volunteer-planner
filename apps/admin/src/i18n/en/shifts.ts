// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import type fr from '../fr/shifts';

export default {
  title: 'Shifts',
  help: {
    edges:
      'Drag a bar’s edge to lengthen, shorten or join it, and a break inside it to move where one shift ends and the next begins — push a break onto its neighbour and those two shifts become one.',
    draw: 'Double-click a bar to divide it into two separate series, and drag across empty lane inside a day to draw a new one.',
    hours:
      'A line down the board marks every hour, and a drag snaps to one when it passes close by.',
    outside:
      'Past the ends of the day — the hatched strips — the day itself lengthens.',
    keys: {
      shift: 'Shift',
      home: 'Home',
      end: 'End',
      ctrl: 'Ctrl',
      wheel: '+ wheel',
    },
    does: {
      barControls:
        'Every bar carries its own, so a festival-wide row is still edited one day at a time.',
      shift:
        'Hold while dragging to place an edge or a break off the hour instead.',
      arrows:
        'With an edge or a break focused, move it by {minutes} minutes, and with Shift by one slot.',
      homeEnd:
        'Run an edge to the ends of its day and push a break onto its neighbours.',
      fold: 'Hours no day reaches at all are folded away behind one; press one to open that stretch back up.',
      wheel: 'Over the board, zooms it, the same as the slider above.',
    },
    doors: 'Door times are not touched by any of that.',
    doorsLink: 'Set them on the event details page.',
  },
  tools: {
    cutLength: 'shift length',
    cutUnit: '(minutes)',
    zoom: 'zoom',
    zoomUnit: '(px / hour)',
  },
  empty: {
    lead: 'No missions declared yet, so there is nothing to cut into shifts.',
    link: 'Add them on the missions page first.',
  },
  columnHead: 'Missions',
  fold: {
    show: 'Show the {length} with no day on them, from {start} to {end}',
    hide: 'Hide the {length} with no day on them again, from {start} to {end}',
  },
  row: {
    alsoAtDays: 'also {count, plural, one {# other day} other {# other days}}',
    cutLengthLabel: 'Slot length for {mission}, in minutes',
  },
  run: {
    label: '{mission}, {day}, {start} to {end}',
    start: 'Start of {bar}',
    end: 'End of {bar}',
    break: 'Break {index} of {bar}',
    cut: 'cut',
    cutLabel: 'Cut {bar} into {minutes} minute slots',
    split: 'split',
    splitLabel: 'Split {bar} into two series',
    removeLabel: 'Remove {bar}',
    removeConfirm: 'sure?',
    removeConfirmLabel:
      'Confirm removing {count, plural, one {# slot} other {# slots}} from {bar}',
    saving: 'saving…',
    notCut: 'not cut yet',
  },
  unplaced: {
    heading: 'Shifts with no mission',
    body: 'Scheduled against a zone or post that could not be loaded, so they have no row to sit on. They are shown rather than hidden: they still have to be staffed.',
    item: '{title} — {start} to {end}',
  },
  failed: {
    locations:
      'At least one day’s zones and posts could not be loaded, so its missions are missing from this board.',
    shifts:
      'At least one day’s shifts could not be loaded, so this board shows less work than there is. Nothing here should be edited until it reloads.',
  },
  rejection: {
    unavailable:
      'The server could not be reached, so this change was not saved.',
    partial:
      '{count, plural, other {# of the changes were already saved}}; the board below has been re-read from the server.',
  },
  stop: {
    neighbourEnd:
      'This bar already reaches the next one at this post. Two bars that touch are one bar, so there is nothing left to fill.',
    neighbourStart:
      'This bar already reaches back to the previous one at this post. Two bars that touch are one bar, so there is nothing left to fill.',
    axis: 'That is as far as this board reaches. Lengthening a day by more than {hours, plural, one {# hour} other {# hours}} at a time is the same drag again — the board draws fresh room past each new edge.',
  },
  notice: {
    widenEnd: '{day} now runs until {time} so this bar can.',
    widenStart: '{day} now starts at {time} so this bar can.',
    merged:
      'Two breaks met, so the shift between them is gone and its neighbour now covers the whole stretch.',
    splitUncut:
      '{mission} is not cut into shifts yet on {day}, so there is nothing to divide. Cut it first.',
    splitNoRoom:
      'A break needs work left on both sides of it. Split further inside the bar, or drag its edge instead.',
    split:
      '{mission} is now two separate series on {day}, {minutes, plural, one {# minute} other {# minutes}} apart. Drag the new edges to where the break really is.',
    noDay:
      'No day runs at that hour, so there is nowhere to put a shift. Lengthen a day by dragging a bar past its edge first.',
    notAPost:
      '{mission} is not one of {day}’s posts, so it has nowhere to be staffed that day.',
  },
} satisfies typeof fr;
