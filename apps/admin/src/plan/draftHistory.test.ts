// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { describe, expect, it } from 'vitest';

import {
  HISTORY_LIMIT,
  adopt,
  canRedo,
  canUndo,
  record,
  redo,
  startHistory,
  undo,
} from './draftHistory';

describe('draft history', () => {
  it('starts with nothing to undo or redo', () => {
    const history = startHistory('a');
    expect(history.present).toBe('a');
    expect(canUndo(history)).toBe(false);
    expect(canRedo(history)).toBe(false);
  });

  it('steps back through recorded edits, and forward again', () => {
    const history = record(record(startHistory('a'), 'b', null), 'c', null);

    const back = undo(undo(history));
    expect(back.present).toBe('a');
    expect(canUndo(back)).toBe(false);

    const forward = redo(back);
    expect(forward.present).toBe('b');
    expect(redo(forward).present).toBe('c');
  });

  it('is no step at all when there is nothing to undo or redo', () => {
    const history = startHistory('a');
    expect(undo(history)).toBe(history);
    expect(redo(history)).toBe(history);
  });

  it('forgets what was undone once a new edit is made', () => {
    const history = record(
      undo(record(startHistory('a'), 'b', null)),
      'x',
      null,
    );
    expect(history.present).toBe('x');
    expect(canRedo(history)).toBe(false);
    expect(undo(history).present).toBe('a');
  });

  it('folds consecutive edits of one group into one step', () => {
    // Typing «Nom» into one field is three edits and one undo.
    const typed = record(
      record(record(startHistory(''), 'N', 'label:q1'), 'No', 'label:q1'),
      'Nom',
      'label:q1',
    );
    expect(undo(typed).present).toBe('');
  });

  it('starts a new step when the group changes, or after an ungrouped edit', () => {
    const history = record(
      record(record(startHistory(''), 'N', 'label:q1'), 'N!', 'help:q1'),
      'N!?',
      'help:q1',
    );
    expect(undo(history).present).toBe('N');

    const split = record(
      record(record(startHistory(''), 'N', 'label:q1'), 'N moved', null),
      'N moved!',
      'label:q1',
    );
    expect(undo(split).present).toBe('N moved');
  });

  it('starts a new step for the same group once something was undone', () => {
    const base = record(record(startHistory(''), 'a', 'g'), 'ab', 'g');
    // Undo, redo, then type more: the redo is not reopened for folding.
    const typed = record(redo(undo(base)), 'abc', 'g');
    expect(undo(typed).present).toBe('ab');
  });

  it('adopts the server’s copy of the present without making it a step', () => {
    const history = record(startHistory('a'), 'b', 'g');
    const adopted = adopt(history, 'b′');
    expect(adopted.present).toBe('b′');
    expect(undo(adopted).present).toBe('a');
    // …and a later edit in the same group does not fold into the adopted copy.
    expect(undo(record(adopted, 'b′c', 'g')).present).toBe('b′');
  });

  it(`keeps at most ${String(HISTORY_LIMIT)} steps, dropping the oldest`, () => {
    let history = startHistory(0);
    for (let i = 1; i <= HISTORY_LIMIT + 5; i += 1) {
      history = record(history, i, null);
    }
    let steps = 0;
    while (canUndo(history)) {
      history = undo(history);
      steps += 1;
    }
    expect(steps).toBe(HISTORY_LIMIT);
    expect(history.present).toBe(5);
  });
});
