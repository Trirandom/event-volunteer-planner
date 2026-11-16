// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The form builder's undo: a history of whole draft states (ADR-0048).
 *
 * Whole states rather than inverse patches because a draft is small, it is
 * already replaced immutably on every edit, and a stored state cannot be
 * replayed wrongly. This is the editor's history of a working copy, not the
 * operations stack of ADR-0024; publishing is the domain action.
 *
 * **Grouping.** An edit may name a group, such as "the French label of
 * question 3". Consecutive edits of one group fold into one step, so typing a
 * word is one undo, not one per letter. Anything else (a move, an add, an
 * undo itself) closes the group. Grouping is by what was edited, not by
 * elapsed time, so the result does not depend on how fast somebody types.
 */

/** Enough for a working session; a bound so a long one does not grow without
 * limit. The oldest steps are dropped first. */
export const HISTORY_LIMIT = 100;

export interface DraftHistory<T> {
  readonly past: readonly T[];
  readonly present: T;
  readonly future: readonly T[];
  /** The group the present state was last edited in, or `null` when the next
   * edit must start a step of its own. */
  readonly group: string | null;
}

export function startHistory<T>(state: T): DraftHistory<T> {
  return { past: [], present: state, future: [], group: null };
}

export function record<T>(
  history: DraftHistory<T>,
  next: T,
  group: string | null,
): DraftHistory<T> {
  if (group !== null && group === history.group) {
    return { ...history, present: next, future: [] };
  }
  return {
    past: [...history.past, history.present].slice(-HISTORY_LIMIT),
    present: next,
    future: [],
    group,
  };
}

/** Replaces the present with an equivalent copy (the server's, after a save)
 * without making it a step, and closes the group so the next edit is a step
 * of its own. */
export function adopt<T>(history: DraftHistory<T>, state: T): DraftHistory<T> {
  return { ...history, present: state, group: null };
}

export function canUndo<T>(history: DraftHistory<T>): boolean {
  return history.past.length > 0;
}

export function canRedo<T>(history: DraftHistory<T>): boolean {
  return history.future.length > 0;
}

export function undo<T>(history: DraftHistory<T>): DraftHistory<T> {
  const previous = history.past.at(-1);
  if (previous === undefined) {
    return history;
  }
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
    group: null,
  };
}

export function redo<T>(history: DraftHistory<T>): DraftHistory<T> {
  const [next, ...rest] = history.future;
  if (next === undefined) {
    return history;
  }
  return {
    past: [...history.past, history.present],
    present: next,
    future: rest,
    group: null,
  };
}
