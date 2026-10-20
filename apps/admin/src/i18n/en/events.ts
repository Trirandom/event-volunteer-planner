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
    saved: 'Saved.',
    saveChanges: 'Save changes',
    discard: 'Discard',
    delete: 'Delete this event',
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
      'This festival has no days yet, so there is nothing to configure. Add the first one below.',
  },
} satisfies typeof fr;
