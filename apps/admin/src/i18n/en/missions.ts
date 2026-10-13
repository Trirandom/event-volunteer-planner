// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import type fr from '../fr/missions';

export default {
  view: {
    help: {
      title: 'Missions',
      intro:
        'A mission is a job volunteers are staffed on: a zone is the physical area — a bar, an entrance, a prevention stand — and a post is a specific job inside it. What you write here is what volunteers are told about it; the hours it is worked are cut on the shifts page.',
      festival:
        'This festival runs {count, plural, one {# day} other {# days}}, and a mission is declared on each of them — adding or editing one here changes every day it runs on. Pick a day from the strip above to work on it alone.',
    },
    locationsFailed:
      'At least one day’s missions could not be loaded, so this list is incomplete. Nothing here should be added or removed until it reloads: a day that is missing from the list is not necessarily a day without the mission.',
    noDays: 'This festival has no days yet, so there is nothing to staff.',
    empty:
      'No missions yet. Add the posts this production is staffed on — a bar, an entrance, a prevention stand — and then cut them into shifts on the board.',
    postsInZone: 'Posts in {zone}',
  },
  kind: {
    zone: 'Zone',
    post: 'Post',
  },
  fields: {
    name: 'Name',
    description: 'What the job is',
    descriptionHelp:
      'Briefing text for the volunteers assigned to it — what they will be doing, and anything they should bring or know.',
    descriptionHelpNew:
      'Optional now, and the thing volunteers will actually read later.',
    address: 'Where to stand',
    addressHelp:
      'As you would say it to somebody who is lost — a hall, a gate, a landmark. Not a postal address.',
    volunteers: 'Volunteers',
    volunteersHelp:
      'How many volunteers this mission can take at once. Below the minimum it counts as understaffed; past the maximum, nobody more is assigned. Leave either blank for no limit.',
    minimum: 'Minimum',
    maximum: 'Maximum',
    noMinimum: 'No minimum',
    noMaximum: 'No maximum',
    exactAddress: 'Exact address',
    exactAddressHelp:
      'A postal address a map or courier can resolve — not the wayfinding text above. Leave it blank for open ground with no address of its own.',
    coordinates: 'GPS coordinates',
    coordinatesHelp:
      'For a site with no address at all, such as a field during build/strike: latitude, longitude in decimal degrees, e.g. "48.8566, 2.3522".',
    coordinatesPlaceholder: '48.8566, 2.3522',
    checkedByDefault: 'Ticked by default on the volunteer form',
    checkedByDefaultHint:
      'Untick for a technical mission: volunteers will have to tick it themselves.',
    adultsOnly: 'Adults only (18+)',
    adultsOnlyHint: 'Shown on the form; never ticked by default.',
  },
  problem: {
    nameMissingMission: 'Give the mission a name.',
    nameMissingPost: 'Give the post a name.',
    nameTakenOnPage: 'Another mission on this page already has that name.',
    nameTakenInProduction:
      'This production already has a mission with that name. Edit that one instead — a second row with the same name would fold into it anyway.',
    coordinatesInvalid:
      'GPS coordinates should look like "48.8566, 2.3522" — latitude then longitude, in decimal degrees.',
    coordinatesInvalidShort: 'GPS coordinates are not valid.',
    volunteersInvalid:
      'Volunteer counts are whole numbers: a minimum of 0 or more, a maximum of 1 or more.',
    volunteersOrder: 'The maximum cannot be lower than the minimum.',
  },
  refusal: {
    day: '{day} ({detail})',
    dayUnreachable: '{day} (the server could not be reached)',
    separator: '; ',
    nothingSaved: 'Nothing was saved. {days}',
    savedPartly:
      '{applied} of {total} days were saved; the rest were not. {days}',
    nothingRemoved: 'Nothing was removed. {days}',
    removedPartly:
      '{applied} of {total} days were removed; the rest were not. {days}',
    missionNotCreated: 'The mission was not created. {days}',
    postNotCreated: 'The post was not created. {days}',
    createdPartly:
      'Created on {applied} of {total} days; the rest were refused. {days}',
  },
  bounds: {
    varies: 'Volunteers vary by day',
    exactly: '{count, plural, one {# volunteer} other {# volunteers}}',
    range: '{min}–{max, plural, one {# volunteer} other {# volunteers}}',
    atLeast: 'At least {min, plural, one {# volunteer} other {# volunteers}}',
    upTo: 'Up to {max, plural, one {# volunteer} other {# volunteers}}',
  },
  card: {
    runsOnDays: 'Runs on {count, plural, one {# day} other {# days}}: {days}',
    dayCount: '{count, plural, one {# day} other {# days}}',
    unsaved: 'Unsaved changes',
    remove: 'Remove {name}',
    summary: {
      briefingVaries: 'Briefing varies by day',
      noBriefing: 'No briefing yet',
      addressVaries: 'Location varies by day',
      adultsOnly: '18+',
      adultsOnlyVaries: '18+ on some days',
      optIn: 'Not ticked by default',
      optInVaries: 'Ticked by default on some days',
    },
    notDeclaredOn:
      'Not declared on {missing}. Saving changes {days} and leaves those alone.',
    nothingSaid: 'nothing said',
    noBound: 'none',
    unifyDescription: 'Use one description on every day',
    unifyAddress: 'Use one address on every day',
    unifyMinimum: 'Use one minimum on every day',
    unifyMaximum: 'Use one maximum on every day',
    unifyExactAddress: 'Use one exact address on every day',
    unifyCoordinates: 'Use one pin on every day',
    flagOn: 'yes',
    flagOff: 'no',
    unifyFlag: 'Tick or untick the box to apply one choice to every day.',
    saved: 'Saved.',
    savedOnDays: 'Saved on {count, plural, one {# day} other {# days}}.',
    saveChanges: 'Save changes',
    deleteConfirm: {
      title: 'Remove {name}?',
      confirmZone: 'Remove zone',
      confirmPost: 'Remove post',
      busy: 'Removing…',
      body: 'Remove the {kind, select, zone {zone} other {post}} {name} from {days}, along with every shift already cut on it?',
      bodyWithPosts:
        'Remove the {kind, select, zone {zone} other {post}} {name} from {days}, along with {count, plural, one {# post} other {# posts}} nested under it ({names}) and every shift already cut on any of them?',
      irreversible: 'This cannot be undone.',
    },
  },
  newZone: {
    open: 'Add a zone',
    heading: 'New zone',
    headingHelp:
      'A zone is a physical area volunteers are staffed on — a bar, an entrance, a prevention stand. Once it exists you can split it into posts from its own card, if one job needs telling apart from another.',
    allDays:
      'It will be declared on {count, plural, one {the one day} other {all # days}} of this festival; you can change or remove it on a single day afterwards.',
    added: '{name} added.',
    addedToAllDays:
      '{name} added to {count, plural, one {the one day} other {all # days}}.',
    adding: 'Adding…',
    submit: 'Add mission',
    done: 'Done',
  },
  newPost: {
    open: 'Add a post in {zone}',
    heading: 'New post in {zone}',
    headingHelp:
      'A post is a specific job inside this zone — a till, a door, a single table.',
    allDays:
      'It will be declared on {count, plural, one {the one day} other {all # days}} this zone runs on.',
    added: '{name} added.',
    addedToAllDays:
      '{name} added to {count, plural, one {the one day} other {all # days}}.',
    adding: 'Adding…',
    submit: 'Add post',
    done: 'Done',
  },
} satisfies typeof fr;
