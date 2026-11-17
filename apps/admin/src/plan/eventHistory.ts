// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The event details page's undo: the edits this coordinator made here
 * (ADR-0051).
 *
 * The same peek/commit shape as `missionHistory.ts`, without its day steps. An
 * event step only ever puts a draft back, and the row then autosaves it, so
 * there is no write here that the server could refuse halfway. That is why
 * this is its own small module rather than a generalisation of the missions
 * one (ADR-0051, "Alternatives").
 *
 * **Grouping.** Consecutive edits of one date field of one event fold into one
 * step: a `datetime-local` reports every segment typed, and a date should be
 * one undo. A colour pick never folds. It is a click, and each click is a
 * decision somebody may want to step back through.
 */
import type { EventDraft } from './eventDraft';

export const EVENT_HISTORY_LIMIT = 100;

export interface EventStep {
  readonly eventId: string;
  readonly before: EventDraft;
  readonly after: EventDraft;
}

export interface EventHistory {
  readonly done: readonly EventStep[];
  readonly undone: readonly EventStep[];
  /** What the last recorded step edited, or `null` when the next edit must
   * be a step of its own. */
  readonly group: string | null;
}

export function emptyEventHistory(): EventHistory {
  return { done: [], undone: [], group: null };
}

const DATE_FIELDS = [
  'start',
  'end',
  'doorsOpen',
  'doorsClose',
] as const satisfies readonly (keyof EventDraft)[];

/** `"<event>:<field>"` when exactly one date field changed and nothing else
 * did; otherwise `null`. */
function groupOf(step: EventStep): string | null {
  if (step.before.color !== step.after.color) {
    return null;
  }
  const changed = DATE_FIELDS.filter(
    (field) => step.before[field] !== step.after[field],
  );
  const [only] = changed;
  return changed.length === 1 && only !== undefined
    ? `${step.eventId}:${only}`
    : null;
}

export function recordStep(
  history: EventHistory,
  step: EventStep,
): EventHistory {
  const group = groupOf(step);
  const last = history.done.at(-1);
  if (group !== null && group === history.group && last !== undefined) {
    return {
      done: [...history.done.slice(0, -1), { ...last, after: step.after }],
      undone: [],
      group,
    };
  }
  return {
    done: [...history.done, step].slice(-EVENT_HISTORY_LIMIT),
    undone: [],
    group,
  };
}

export function nextUndo(history: EventHistory): EventStep | null {
  return history.done.at(-1) ?? null;
}

export function nextRedo(history: EventHistory): EventStep | null {
  return history.undone[0] ?? null;
}

export function afterUndo(history: EventHistory): EventHistory {
  const step = history.done.at(-1);
  if (step === undefined) {
    return history;
  }
  return {
    done: history.done.slice(0, -1),
    undone: [step, ...history.undone],
    group: null,
  };
}

export function afterRedo(history: EventHistory): EventHistory {
  const [step, ...rest] = history.undone;
  if (step === undefined) {
    return history;
  }
  return { done: [...history.done, step], undone: rest, group: null };
}
