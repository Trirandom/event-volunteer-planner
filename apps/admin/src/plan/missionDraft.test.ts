// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { describe, expect, it } from 'vitest';

import type { Mission, MissionPlacement } from './missionCatalog';
import {
  draftChanges,
  draftOf,
  emptyDraft,
  missionProblem,
  newMissionInput,
} from './missionDraft';

function placement(eventId: string, name: string): MissionPlacement {
  return {
    eventId,
    eventName: eventId,
    locationId: `location-${eventId}`,
    version: 1,
    kind: 'zone',
    zoneName: null,
    name,
    description: null,
    address: null,
    exactAddress: null,
    coordinates: null,
    minVolunteers: null,
    maxVolunteers: null,
    checkedByDefault: true,
    adultsOnly: false,
  };
}

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    key: 'bar',
    name: 'Bar',
    placements: [placement('event-1', 'Bar')],
    description: null,
    address: null,
    exactAddress: null,
    coordinates: null,
    descriptionVaries: false,
    addressVaries: false,
    exactAddressVaries: false,
    coordinatesVaries: false,
    minVolunteers: null,
    maxVolunteers: null,
    minVolunteersVaries: false,
    maxVolunteersVaries: false,
    checkedByDefault: true,
    adultsOnly: false,
    checkedByDefaultVaries: false,
    adultsOnlyVaries: false,
    missingFrom: [],
    ...overrides,
  };
}

describe('draftOf', () => {
  it('shows a stored value, and an empty box when there is none', () => {
    const draft = draftOf(mission({ description: 'Serving.', address: null }));
    expect(draft).toEqual({
      name: 'Bar',
      description: 'Serving.',
      address: '',
      exactAddress: '',
      coordinates: '',
      minVolunteers: '',
      maxVolunteers: '',
      checkedByDefault: true,
      adultsOnly: false,
    });
  });

  it('starts a field the days disagree about at null, not at one of the values', () => {
    const draft = draftOf(mission({ addressVaries: true }));
    // `null` is "leave each day alone". An empty string here would be the
    // form volunteering to wipe every day's address.
    expect(draft.address).toBeNull();
  });
});

describe('draftChanges', () => {
  it('sends nothing when nothing was touched', () => {
    const subject = mission({ description: 'Serving.' });
    expect(draftChanges(subject, draftOf(subject))).toBeNull();
  });

  it('sends a renamed mission', () => {
    const subject = mission();
    expect(
      draftChanges(subject, { ...draftOf(subject), name: 'Buvette' }),
    ).toEqual({ name: 'Buvette' });
  });

  it('leaves two days spelled differently alone when the name is not touched', () => {
    // 'Bar' and 'BAR' are one mission. Saving the card without touching the
    // name has not asked for the second to be corrected.
    const subject = mission({
      placements: [placement('event-1', 'Bar'), placement('event-2', 'BAR')],
    });
    expect(draftChanges(subject, draftOf(subject))).toBeNull();
  });

  it('sends null for a field that was emptied', () => {
    const subject = mission({ address: 'Halle 3' });
    expect(
      draftChanges(subject, { ...draftOf(subject), address: '  ' }),
    ).toEqual({ address: null });
  });

  it('trims what it sends, because the schema refuses a blank string', () => {
    const subject = mission();
    expect(
      draftChanges(subject, { ...draftOf(subject), address: '  Halle 3 ' }),
    ).toEqual({ address: 'Halle 3' });
  });

  it('sends nothing for a varying field the coordinator did not touch', () => {
    const subject = mission({ addressVaries: true });
    const draft = draftOf(subject);
    expect(draft.address).toBeNull();
    expect(draftChanges(subject, draft)).toBeNull();
  });

  it('sends a varying field once it has been typed into', () => {
    const subject = mission({ addressVaries: true });
    expect(
      draftChanges(subject, { ...draftOf(subject), address: 'Halle 3' }),
    ).toEqual({ address: 'Halle 3' });
  });

  it('sends a varying field even when the text matches one of the days', () => {
    // Unifying four rows on a value one of them already had still changes the
    // other three, so "it equals what is stored" is not a reason to skip it.
    const subject = mission({ addressVaries: true, address: null });
    expect(draftChanges(subject, { ...draftOf(subject), address: '' })).toEqual(
      { address: null },
    );
  });

  it('refuses to send an empty name as a rename', () => {
    const subject = mission();
    expect(
      draftChanges(subject, { ...draftOf(subject), name: '   ' }),
    ).toBeNull();
  });

  it('sends every field that moved in one patch', () => {
    const subject = mission();
    expect(
      draftChanges(subject, {
        name: 'Buvette',
        description: 'Serving.',
        address: 'Halle 3',
        exactAddress: '12 Rue de la Paix',
        coordinates: '48.8566, 2.3522',
        minVolunteers: '2',
        maxVolunteers: '6',
        checkedByDefault: false,
        adultsOnly: true,
      }),
    ).toEqual({
      name: 'Buvette',
      description: 'Serving.',
      address: 'Halle 3',
      exactAddress: '12 Rue de la Paix',
      latitude: 48.8566,
      longitude: 2.3522,
      minVolunteers: 2,
      maxVolunteers: 6,
      checkedByDefault: false,
      adultsOnly: true,
    });
  });

  it('compares volunteer bounds as numbers, not as the text typed', () => {
    const subject = mission({ minVolunteers: '4' });
    expect(
      draftChanges(subject, { ...draftOf(subject), minVolunteers: '04' }),
    ).toBeNull();
  });

  it('sends null for a volunteer bound that was emptied', () => {
    const subject = mission({ maxVolunteers: '6' });
    expect(
      draftChanges(subject, { ...draftOf(subject), maxVolunteers: ' ' }),
    ).toEqual({ maxVolunteers: null });
  });

  it('leaves a bound the days disagree about alone until it is unified', () => {
    const subject = mission({ minVolunteersVaries: true });
    expect(draftOf(subject).minVolunteers).toBeNull();
    expect(draftChanges(subject, draftOf(subject))).toBeNull();
  });
});

describe('missionProblem', () => {
  it('refuses a mission with no name', () => {
    expect(missionProblem({ ...emptyDraft(), name: ' ' }, [])).toBe(
      'name-missing',
    );
  });

  it('refuses a name another mission already has', () => {
    expect(
      missionProblem({ ...emptyDraft(), name: 'bar' }, ['bar', 'accueil']),
    ).toBe('name-taken');
  });

  it('does not refuse a mission for having its own name', () => {
    expect(
      missionProblem({ ...emptyDraft(), name: 'Bar' }, ['bar'], 'bar'),
    ).toBeNull();
  });

  it.each([
    ['a fraction', '1.5', ''],
    ['a negative minimum', '-1', ''],
    ['a maximum of nobody', '', '0'],
    ['text', 'two', ''],
    ['more than the column holds', '', '40000'],
  ])('refuses %s as a volunteer count', (_label, min, max) => {
    expect(
      missionProblem(
        {
          ...emptyDraft(),
          name: 'Bar',
          minVolunteers: min,
          maxVolunteers: max,
        },
        [],
      ),
    ).toBe('volunteers-invalid');
  });

  it('refuses a maximum below the minimum', () => {
    expect(
      missionProblem(
        {
          ...emptyDraft(),
          name: 'Bar',
          minVolunteers: '5',
          maxVolunteers: '3',
        },
        [],
      ),
    ).toBe('volunteers-order');
  });

  it('accepts a minimum of zero and equal bounds', () => {
    expect(
      missionProblem(
        {
          ...emptyDraft(),
          name: 'Bar',
          minVolunteers: '0',
          maxVolunteers: '1',
        },
        [],
      ),
    ).toBeNull();
    expect(
      missionProblem(
        {
          ...emptyDraft(),
          name: 'Bar',
          minVolunteers: '4',
          maxVolunteers: '4',
        },
        [],
      ),
    ).toBeNull();
  });
});

describe('newMissionInput', () => {
  it('omits the optional fields rather than sending them empty', () => {
    expect(
      newMissionInput({
        name: ' Bar ',
        description: '',
        address: '  ',
        exactAddress: '',
        coordinates: '',
        minVolunteers: ' ',
        maxVolunteers: '',
        checkedByDefault: true,
        adultsOnly: false,
      }),
    ).toEqual({ name: 'Bar' });
  });

  it('sends what was filled in, trimmed', () => {
    expect(
      newMissionInput({
        name: 'Bar',
        description: ' Serving. ',
        address: 'Halle 3',
        exactAddress: ' 12 Rue de la Paix ',
        coordinates: '48.8566, 2.3522',
        minVolunteers: ' 0 ',
        maxVolunteers: '8',
        checkedByDefault: false,
        adultsOnly: true,
      }),
    ).toEqual({
      name: 'Bar',
      description: 'Serving.',
      address: 'Halle 3',
      exactAddress: '12 Rue de la Paix',
      latitude: 48.8566,
      longitude: 2.3522,
      minVolunteers: 0,
      maxVolunteers: 8,
      checkedByDefault: false,
      adultsOnly: true,
    });
  });
});

describe('form flags', () => {
  it('starts a flag the days disagree about at null', () => {
    const draft = draftOf(
      mission({ checkedByDefault: null, checkedByDefaultVaries: true }),
    );
    expect(draft.checkedByDefault).toBeNull();
    expect(draft.adultsOnly).toBe(false);
  });

  it('sends a flag only when it moved', () => {
    const subject = mission({ adultsOnly: true });
    expect(draftChanges(subject, draftOf(subject))).toBeNull();
    expect(
      draftChanges(subject, { ...draftOf(subject), adultsOnly: false }),
    ).toEqual({ adultsOnly: false });
    expect(
      draftChanges(subject, { ...draftOf(subject), checkedByDefault: false }),
    ).toEqual({ checkedByDefault: false });
  });

  it('leaves a flag the days disagree about alone until one is picked', () => {
    const subject = mission({ adultsOnly: null, adultsOnlyVaries: true });
    expect(draftChanges(subject, draftOf(subject))).toBeNull();
  });

  it('sends a picked flag when the days disagree, even one some day already had', () => {
    const subject = mission({
      checkedByDefault: null,
      checkedByDefaultVaries: true,
    });
    expect(
      draftChanges(subject, { ...draftOf(subject), checkedByDefault: true }),
    ).toEqual({ checkedByDefault: true });
  });

  it('never sends a flag for a post, which the server would refuse', () => {
    const post: MissionPlacement = {
      ...placement('event-1', 'Caisse'),
      kind: 'post',
      zoneName: 'Bar',
      checkedByDefault: null,
      adultsOnly: null,
    };
    const subject = mission({
      key: 'caisse',
      name: 'Caisse',
      placements: [post],
      checkedByDefault: null,
      adultsOnly: null,
    });
    expect(draftOf(subject).checkedByDefault).toBeNull();
    expect(
      draftChanges(subject, {
        ...draftOf(subject),
        checkedByDefault: false,
        adultsOnly: true,
      }),
    ).toBeNull();
  });

  it('creates with the server defaults unsaid', () => {
    expect(emptyDraft()).toMatchObject({
      checkedByDefault: true,
      adultsOnly: false,
    });
    expect(newMissionInput({ ...emptyDraft(), name: 'Bar' })).toEqual({
      name: 'Bar',
    });
  });
});
