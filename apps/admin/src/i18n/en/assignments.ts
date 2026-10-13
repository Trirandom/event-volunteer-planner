// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import type fr from '../fr/assignments';

export default {
  help: {
    title: 'Assignments',
    seats:
      'Every slot is a stack of dropdowns, one per volunteer the mission needs at minimum — a slot still short of people is outlined and says so. Once those are filled, one more appears for an extra pair of hands.',
    pick: 'Pick a name to roster somebody, pick “{removeOption}” to take them off, or pick a different name to swap.',
    ranking:
      'The list is ordered by what each volunteer told the form: who is free for those hours first, then who said nothing, then who cannot — anybody already working elsewhere at that time is shown and cannot be chosen, because the database refuses a double booking.',
    folds:
      'Hours no day reaches are folded behind a ⋯; press one to open that stretch back up.',
    drag: 'To move somebody, drag their seat onto another one; hold Ctrl or Alt while dropping to copy them there instead.',
    keyboard:
      'Ctrl+C and Ctrl+V on a focused seat do the same without a pointer.',
    zoom: 'Ctrl + wheel over the board zooms it, the same as the slider above.',
    shiftsLink: 'The slots themselves are cut on the shifts page.',
  },
  toolbar: {
    coverage:
      '{filled, number} of {required, plural, one {# place} other {# places}} filled',
    zoom: 'zoom',
    zoomUnit: '(px / hour)',
    onlyGaps: 'only missions with places left',
  },
  empty: {
    noMissions: 'No missions declared yet, so there is nobody to place.',
    noMissionsLink: 'Add them on the missions page first.',
    noShifts:
      'These missions are not cut into shifts yet, so there are no places to fill.',
    noShiftsLink: 'Cut them on the shifts page first.',
    allStaffed: 'Every mission in view is fully staffed.',
  },
  board: {
    missionsHeader: 'Missions',
    foldGlyph: '⋯',
    showFold: 'Show the {length} with no day on them, from {start} to {end}',
    hideFold:
      'Hide the {length} with no day on them again, from {start} to {end}',
    alsoAtDays: 'also {count, plural, one {# other day} other {# other days}}',
    missionCount: '{filled, number}/{required, number} placed',
  },
  seat: {
    remove: '— remove —',
    addExtra: '+ add somebody (extra)',
    nobodyYet: '— nobody yet —',
    saving: '{name} — saving…',
    label:
      '{mission}, {event}, {hours} ({timezone}), volunteer {position, number} of {total, number}',
    dragHint: 'Drag to move {name}, Ctrl/Alt-drag to copy',
    candidate:
      '{name} — {state, select, available {free} partial {free for part of it} unknown {no answer} unavailable {said no} busy {already working} other {not coming}}',
  },
  loadFailed: {
    locations:
      'At least one day’s zones and posts could not be loaded, so its missions are missing from this board.',
    shifts:
      'At least one day’s shifts could not be loaded, so this board shows fewer places than there are.',
    participants:
      'At least one day’s volunteers could not be loaded. Their dropdowns are empty — that is this page failing to ask, not nobody having signed up.',
    assignments:
      'At least one day’s roster could not be loaded, so slots below may look emptier than they are. Nothing here should be changed until it reloads.',
  },
  rejection: {
    unavailable:
      'The server could not be reached, so this change was not saved.',
    placeEmptied:
      '{reason} The volunteer who held that place was already taken off it, so the place is now empty.',
  },
  clipboard: {
    copied: 'Copied:',
    pasteHint: 'Focus a seat and press Ctrl+V to place them there.',
    clear: 'Clear the copied volunteer',
  },
} satisfies typeof fr;
