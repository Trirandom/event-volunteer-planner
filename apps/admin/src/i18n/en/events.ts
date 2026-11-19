// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import type fr from '../fr/events';

export default {
  list: {
    title: 'Events',
    create: {
      heading: 'Add to the plan',
      newEvent: 'New event',
      newFestival: 'New festival',
      name: 'Name',
      slug: 'Slug',
      timezone: 'Timezone (IANA name, e.g. Europe/Paris)',
      starts: 'Starts',
      ends: 'Ends',
      creating: 'Creating…',
      createEvent: 'Create event',
      createFestival: 'Create festival',
    },
    example: {
      loading: 'Loading the example…',
      loadFestival: 'Load the example festival',
      loadEvent: 'Load the example event',
      loaded:
        '{kind, select, festival {Loaded the example festival “{name}”.} other {Loaded the example event “{name}”.}}',
      conflict:
        '{kind, select, festival {Another coordinator already loaded a festival for this organisation — showing it below.} other {Another coordinator already loaded an event for this organisation — showing it below.}}',
    },
    unavailable:
      'The server could not be reached. Check your connection and try again.',
    loadFailed: 'The server could not be reached, so nothing could be loaded.',
    festivalsFailed:
      'Festivals could not be loaded, so events are listed without their festival.',
    empty: {
      heading: 'Nothing planned yet',
      body: 'An event is what volunteers get shifts on; a festival groups several events under one banner. Use the form above — or one of its "load the example" buttons — to see how the planner is meant to be used.',
    },
    upcoming: 'Coming up',
    past: 'Past',
    finished: '· finished',
    noEventsYet: 'No events yet.',
    noEvents: 'No events.',
    kind: {
      festival: 'Festival',
      event: 'Event',
    },
  },
  newEvent: {
    addAnotherEvent: 'Add another event',
    addEventToFestival: 'Add an event',
    addDayButton: 'Add a day',
    headingEvent: 'New event',
    headingDay: 'New day',
    hintStandalone:
      'A second event alongside {production}, standalone like it is. Its hours are its own; nothing is copied over.',
    hintFestivalEvent:
      'A new event in {production}. It keeps its own hours and is staffed independently of the festival’s other events.',
    hintDay:
      'Another day of {production}. It joins the strip above, gets its own colour, and is staffed independently of the other days.',
    name: 'Name',
    slug: 'Slug',
    slugHint:
      'What the day is called in a URL. Filled in from the name until you change it.',
    timezone: 'Timezone',
    timezoneHint:
      'The day’s own clock, and what the two times below are read in. Taken from {production}; change it for a day that runs somewhere else.',
    starts: 'Starts',
    ends: 'Ends',
    periodHint:
      'Everything the day covers, load-in and load-out included — the same working hours the cards below hold. Door times are set afterwards, on the day’s own card.',
    problem: {
      nameMissing: 'Give the day a name — “Samedi”, “Open Air”, “Nuit 2”.',
      slugMissing:
        'The day needs a slug for its URL. It is filled in from the name; type one if the name has nothing to make it out of.',
      slugTaken:
        'This production already has a day with that slug. Slugs are the URL, so they have to differ even when two days are called the same thing.',
      timezoneUnknown:
        'That is not an IANA timezone name. Use the form Europe/Paris.',
      startMissing: 'Say when the day starts.',
      endMissing: 'Say when the day ends.',
      periodInverted:
        'The day has to end after it starts. A night that runs past midnight ends on the next date — that is fine.',
    },
    unavailable: 'The server could not be reached, so nothing was created.',
    created: '{name} added.',
    adding: 'Adding…',
    addEvent: 'Add event',
    addDay: 'Add day',
    done: 'Done',
  },
  details: {
    zone: '{timeZone} · times below are this event’s local clock',
    workingHours: 'Working hours',
    starts: 'Starts',
    ends: 'Ends',
    doors: 'Doors',
    doorsOpen: 'Doors open',
    doorsClose: 'Doors close',
    clearDoors: 'Publish no door times',
    colour: 'Colour',
    swatch:
      '{retained, select, yes {Colour {index} (this event’s current colour)} other {Colour {index}}}',
    problem: {
      startMissing: 'Give the event a start date and time.',
      endMissing: 'Give the event an end date and time.',
      periodInverted: 'The event has to end after it starts.',
      doorsHalfStated:
        'Door times come in pairs. Fill both, or clear both to publish none.',
      doorsInverted: 'The doors have to close after they open.',
      doorsOutsidePeriod:
        'The doors are open during the event, so they cannot fall outside its start and end. Widen the event first.',
    },
    conflict:
      '{detail} Reload the page to pick up their version before editing again.',
    saveUnavailable: 'The server could not be reached, so nothing was saved.',
    deleteUnavailable:
      'The server could not be reached, so nothing was deleted.',
    deleteHint:
      'Archiving keeps a published roster readable; deleting does not. Use this for an event that should never have existed.',
    deleteConfirm:
      'Delete {name} and everything scheduled on it? This cannot be undone.',
    deleting: 'Deleting…',
    confirmDelete: 'Yes, delete it',
    keep: 'Keep it',
  },
  detailsPage: {
    helpTitle: 'Event details',
    allDays:
      'Every day of this festival. Pick one from the strip above to work on it alone.',
    help: {
      workingHoursTerm: 'Working hours',
      workingHours:
        'everything the event covers, including load-in and load-out. Every shift has to fit inside it.',
      doorsTerm: 'Doors',
      doors:
        'when the event is open to the public, if that has been decided. Optional and never guessed: leave both empty to publish none.',
      colourTerm: 'Colour',
      colour:
        'how an event is drawn wherever it appears beside another one: the day strip above, and every chip that names it. Every colour offered reads against both black and white text.',
    },
    noDays:
      'This festival has no days yet, so there is nothing to configure. Add the first one above.',
    /** Deleting the festival itself (ADR-0053), from the bottom of its page. */
    deleteFestival: {
      button: 'Delete the festival',
      title: 'Delete {name}?',
      counting: 'Working out what the deletion would take…',
      countFailed:
        'Could not work out what the deletion would take. Close this and try again.',
      ungroup:
        '{count, plural, =0 {The festival has no events.} one {Its event will be kept: it will become a standalone event.} other {Its # events will be kept: they will become standalone events.}}',
      individually:
        'An event is never deleted with its festival. To delete them too, they will then have to be deleted one at a time, each from its own row.',
      forms:
        '{count, plural, =0 {No form belongs to the festival.} one {Its form will be deleted.} other {Its # forms will be deleted.}}',
      submissions:
        '{count, plural, one {The one answer it received will be deleted, with the availability it gave. This will be permanent.} other {The # answers received will be deleted, with the availability they gave. This will be permanent.}}',
      typeName: 'To confirm, type the festival’s name: {name}',
      confirm: 'Delete the festival',
      deleting: 'Deleting…',
      keep: 'Keep the festival',
      conflict:
        'The festival changed since this page was opened. Reload it and try again.',
      forbidden: 'Only an owner can delete a festival.',
      unavailable: 'The server could not be reached: nothing was deleted.',
    },
  },
  card: {
    doors: 'Doors {open}–{close}',
    noDoors: 'No door times published',
    unsaved: 'Not saved',
    remove: 'Delete {name}',
    deleteTitle: 'Delete {name}?',
  },
  toolbar: {
    label: 'Saving and undo',
    allSaved: 'Everything is saved',
    blocked:
      '{count, plural, one {One event is not saved: see its row} other {# events are not saved: see their rows}}',
    undo: 'Undo the last change',
    undoHint: 'Undo (Ctrl+Z)',
    redo: 'Redo the change',
    redoHint: 'Redo (Ctrl+Shift+Z)',
  },
  history: {
    undone: 'Change undone.',
    redone: 'Change redone.',
    gone: 'That event is no longer on the page, so there is nothing to undo.',
  },
  leave: {
    title: 'Leave without saving?',
    body: 'At least one event has a change that cannot be saved — its row says why. Leaving loses that change.',
    confirm: 'Leave anyway',
    stay: 'Stay on the page',
  },
} satisfies typeof fr;
