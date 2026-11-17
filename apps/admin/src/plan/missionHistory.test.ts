// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { describe, expect, it } from 'vitest';

import type { MissionDraft } from './missionDraft';
import {
  afterRedo,
  afterUndo,
  emptyMissionHistory,
  MISSION_HISTORY_LIMIT,
  nextRedo,
  nextUndo,
  recordStep,
  type MissionStep,
} from './missionHistory';

function draft(overrides: Partial<MissionDraft> = {}): MissionDraft {
  return {
    name: 'Bar',
    description: '',
    address: '',
    exactAddress: '',
    coordinates: '',
    minVolunteers: '',
    maxVolunteers: '',
    checkedByDefault: true,
    adultsOnly: false,
    ...overrides,
  };
}

function edit(
  missionId: string,
  before: Partial<MissionDraft>,
  after: Partial<MissionDraft>,
): MissionStep {
  return {
    kind: 'edit',
    missionId,
    before: draft(before),
    after: draft(after),
  };
}

const SUNDAY = { eventId: 'sunday', eventName: 'Sunday' };

describe('recordStep', () => {
  it('folds consecutive typing in one field of one mission into one step', () => {
    let history = emptyMissionHistory();
    history = recordStep(
      history,
      edit('m1', { description: '' }, { description: 'S' }),
    );
    history = recordStep(
      history,
      edit('m1', { description: 'S' }, { description: 'Se' }),
    );

    expect(history.done).toEqual([
      edit('m1', { description: '' }, { description: 'Se' }),
    ]);
  });

  it('starts a new step for another field of the same mission', () => {
    let history = emptyMissionHistory();
    history = recordStep(
      history,
      edit('m1', { description: '' }, { description: 'S' }),
    );
    history = recordStep(
      history,
      edit('m1', { address: '' }, { address: 'Hall' }),
    );

    expect(history.done).toHaveLength(2);
  });

  it('starts a new step for the same field of another mission', () => {
    let history = emptyMissionHistory();
    history = recordStep(
      history,
      edit('m1', { name: 'Bar' }, { name: 'Bars' }),
    );
    history = recordStep(
      history,
      edit('m2', { name: 'Bar' }, { name: 'Bars' }),
    );

    expect(history.done).toHaveLength(2);
  });

  it('does not fold an edit into one that came before an undo', () => {
    let history = emptyMissionHistory();
    history = recordStep(
      history,
      edit('m1', { description: '' }, { description: 'S' }),
    );
    history = afterUndo(history);
    history = recordStep(
      history,
      edit('m1', { description: '' }, { description: 'T' }),
    );

    expect(history.done).toEqual([
      edit('m1', { description: '' }, { description: 'T' }),
    ]);
  });

  it('never folds a day into anything', () => {
    let history = emptyMissionHistory();
    const day: MissionStep = {
      kind: 'day',
      missionId: 'm1',
      day: SUNDAY,
      added: true,
    };
    history = recordStep(history, day);
    history = recordStep(history, day);

    expect(history.done).toHaveLength(2);
  });

  it('drops what was undone once something new is recorded', () => {
    let history = emptyMissionHistory();
    history = recordStep(
      history,
      edit('m1', { name: 'Bar' }, { name: 'Bars' }),
    );
    history = afterUndo(history);
    history = recordStep(
      history,
      edit('m1', { address: '' }, { address: 'Hall' }),
    );

    expect(nextRedo(history)).toBeNull();
  });

  it('keeps the newest steps once the limit is reached', () => {
    let history = emptyMissionHistory();
    for (let index = 0; index <= MISSION_HISTORY_LIMIT; index += 1) {
      history = recordStep(history, {
        kind: 'day',
        missionId: `m${String(index)}`,
        day: SUNDAY,
        added: true,
      });
    }

    expect(history.done).toHaveLength(MISSION_HISTORY_LIMIT);
    expect(history.done[0]?.missionId).toBe('m1');
  });
});

describe('undo and redo', () => {
  it('names the step to revert without moving it, so a refused undo stays put', () => {
    const step = edit('m1', { name: 'Bar' }, { name: 'Bars' });
    const history = recordStep(emptyMissionHistory(), step);

    expect(nextUndo(history)).toEqual(step);
    expect(nextUndo(history)).toEqual(step);
  });

  it('moves the step across once it has been applied, and back on redo', () => {
    const step = edit('m1', { name: 'Bar' }, { name: 'Bars' });
    const undone = afterUndo(recordStep(emptyMissionHistory(), step));

    expect(nextUndo(undone)).toBeNull();
    expect(nextRedo(undone)).toEqual(step);

    const redone = afterRedo(undone);
    expect(nextUndo(redone)).toEqual(step);
    expect(nextRedo(redone)).toBeNull();
  });

  it('has nothing to undo or redo when empty', () => {
    expect(nextUndo(emptyMissionHistory())).toBeNull();
    expect(nextRedo(emptyMissionHistory())).toBeNull();
  });
});
