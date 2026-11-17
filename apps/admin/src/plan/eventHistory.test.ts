// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { describe, expect, it } from 'vitest';

import type { EventDraft } from './eventDraft';
import {
  afterRedo,
  afterUndo,
  emptyEventHistory,
  EVENT_HISTORY_LIMIT,
  nextRedo,
  nextUndo,
  recordStep,
  type EventStep,
} from './eventHistory';

function draft(overrides: Partial<EventDraft> = {}): EventDraft {
  return {
    start: '2026-08-01T10:00',
    end: '2026-08-02T04:00',
    doorsOpen: '',
    doorsClose: '',
    color: 0,
    ...overrides,
  };
}

function edit(
  eventId: string,
  before: Partial<EventDraft>,
  after: Partial<EventDraft>,
): EventStep {
  return { eventId, before: draft(before), after: draft(after) };
}

describe('recordStep', () => {
  /** A datetime field reports every segment typed (day, month, hour…), and
   * one undo per segment would make undoing a date a dozen presses. */
  it('folds consecutive edits of one date field of one event into one step', () => {
    let history = emptyEventHistory();
    history = recordStep(
      history,
      edit('sat', { start: '2026-08-01T10:00' }, { start: '2026-08-01T11:00' }),
    );
    history = recordStep(
      history,
      edit('sat', { start: '2026-08-01T11:00' }, { start: '2026-08-01T11:30' }),
    );

    expect(history.done).toEqual([
      edit('sat', { start: '2026-08-01T10:00' }, { start: '2026-08-01T11:30' }),
    ]);
  });

  it('keeps edits of different fields as separate steps', () => {
    let history = emptyEventHistory();
    history = recordStep(
      history,
      edit('sat', { start: '2026-08-01T10:00' }, { start: '2026-08-01T11:00' }),
    );
    history = recordStep(
      history,
      edit('sat', { end: '2026-08-02T04:00' }, { end: '2026-08-02T05:00' }),
    );

    expect(history.done).toHaveLength(2);
  });

  it('keeps edits of the same field on different events as separate steps', () => {
    let history = emptyEventHistory();
    history = recordStep(
      history,
      edit('sat', { start: '2026-08-01T10:00' }, { start: '2026-08-01T11:00' }),
    );
    history = recordStep(
      history,
      edit('sun', { start: '2026-08-01T10:00' }, { start: '2026-08-01T11:00' }),
    );

    expect(history.done).toHaveLength(2);
  });

  /** A click is a decision, unlike a keystroke: trying three colours and
   * undoing once should land on the second, not the original. */
  it('records each colour pick as a step of its own', () => {
    let history = emptyEventHistory();
    history = recordStep(history, edit('sat', { color: 0 }, { color: 3 }));
    history = recordStep(history, edit('sat', { color: 3 }, { color: 7 }));

    expect(history.done).toHaveLength(2);
    expect(nextUndo(history)?.before.color).toBe(3);
  });

  /** "Publish no door times" empties two fields at once: one step, and the
   * typing that follows it starts a new one. */
  it('records a two-field change as its own step', () => {
    let history = emptyEventHistory();
    history = recordStep(
      history,
      edit(
        'sat',
        { doorsOpen: '2026-08-01T12:00', doorsClose: '2026-08-01T23:00' },
        { doorsOpen: '', doorsClose: '' },
      ),
    );
    history = recordStep(
      history,
      edit('sat', { doorsOpen: '' }, { doorsOpen: '2026-08-01T13:00' }),
    );

    expect(history.done).toHaveLength(2);
  });

  it('forgets what was undone once something new is done', () => {
    let history = emptyEventHistory();
    history = recordStep(history, edit('sat', { color: 0 }, { color: 3 }));
    history = afterUndo(history);
    history = recordStep(history, edit('sat', { color: 0 }, { color: 5 }));

    expect(nextRedo(history)).toBeNull();
  });

  it(`keeps at most ${String(EVENT_HISTORY_LIMIT)} steps, dropping the oldest`, () => {
    let history = emptyEventHistory();
    for (let index = 0; index <= EVENT_HISTORY_LIMIT; index += 1) {
      history = recordStep(
        history,
        edit('sat', { color: index }, { color: index + 1 }),
      );
    }

    expect(history.done).toHaveLength(EVENT_HISTORY_LIMIT);
    expect(history.done[0]?.before.color).toBe(1);
  });
});

describe('undo and redo', () => {
  it('has nothing to undo or redo when nothing was done', () => {
    const history = emptyEventHistory();

    expect(nextUndo(history)).toBeNull();
    expect(nextRedo(history)).toBeNull();
  });

  /** Peek, then commit: naming the step must not move it, so a step whose
   * event has gone can stay where it is. */
  it('names the next undo without moving it', () => {
    const step = edit('sat', { color: 0 }, { color: 3 });
    const history = recordStep(emptyEventHistory(), step);

    expect(nextUndo(history)).toEqual(step);
    expect(nextUndo(history)).toEqual(step);
  });

  it('moves an undone step to redo, and back', () => {
    const step = edit('sat', { color: 0 }, { color: 3 });
    const undone = afterUndo(recordStep(emptyEventHistory(), step));

    expect(nextUndo(undone)).toBeNull();
    expect(nextRedo(undone)).toEqual(step);

    const redone = afterRedo(undone);
    expect(nextUndo(redone)).toEqual(step);
    expect(nextRedo(redone)).toBeNull();
  });

  /** After an undo, typing in the same field again is a new step: folding it
   * into the undone one would make the next undo skip past it. */
  it('closes the group on undo', () => {
    let history = emptyEventHistory();
    history = recordStep(
      history,
      edit('sat', { start: '2026-08-01T10:00' }, { start: '2026-08-01T11:00' }),
    );
    history = recordStep(
      history,
      edit('sat', { end: '2026-08-02T04:00' }, { end: '2026-08-02T05:00' }),
    );
    history = afterUndo(history);
    history = recordStep(
      history,
      edit('sat', { start: '2026-08-01T11:00' }, { start: '2026-08-01T12:00' }),
    );

    expect(history.done).toHaveLength(2);
  });

  it('leaves an empty history unchanged', () => {
    const history = emptyEventHistory();

    expect(afterUndo(history)).toEqual(history);
    expect(afterRedo(history)).toEqual(history);
  });
});
