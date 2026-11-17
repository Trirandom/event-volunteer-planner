// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The missions page's undo: the steps this coordinator took here (ADR-0049).
 *
 * Steps rather than whole snapshots, unlike the form builder's
 * `draftHistory.ts`. The page is many independent rows, and undoing is a
 * write per step. A snapshot would have to be diffed back into those writes,
 * and some of them (removing a day that has since gained shifts) must be
 * refused rather than sent. Naming each step is what lets the view refuse
 * one.
 *
 * **Peek, then commit.** `nextUndo` names the step without moving it, and
 * `afterUndo` moves it once its write has landed. An undo the server refuses
 * leaves the history exactly as it was, so pressing it again tries again.
 *
 * **Grouping.** Consecutive edits of one field of one mission fold into one
 * step, so a typed word is one undo. That follows `draftHistory.ts`'s rule:
 * grouped by what was edited, not by elapsed time.
 */
import type { DayRef } from './missionCatalog';
import type { MissionDraft } from './missionDraft';

export const MISSION_HISTORY_LIMIT = 100;

export type MissionStep =
  | {
      readonly kind: 'edit';
      readonly missionId: string;
      readonly before: MissionDraft;
      readonly after: MissionDraft;
    }
  | {
      readonly kind: 'day';
      readonly missionId: string;
      readonly day: DayRef;
      /** Ticked (`true`) or unticked (`false`). */
      readonly added: boolean;
    };

export interface MissionHistory {
  readonly done: readonly MissionStep[];
  readonly undone: readonly MissionStep[];
  /** What the last recorded step edited, or `null` when the next edit must
   * be a step of its own. */
  readonly group: string | null;
}

export function emptyMissionHistory(): MissionHistory {
  return { done: [], undone: [], group: null };
}

const FIELDS = [
  'name',
  'description',
  'address',
  'exactAddress',
  'coordinates',
  'minVolunteers',
  'maxVolunteers',
  'checkedByDefault',
  'adultsOnly',
] as const satisfies readonly (keyof MissionDraft)[];

/** `"<mission>:<field>"` when exactly one field changed; otherwise `null`
 * (a unify button, an undo), which is a step of its own. */
function groupOf(step: MissionStep): string | null {
  if (step.kind !== 'edit') {
    return null;
  }
  const changed = FIELDS.filter(
    (field) => step.before[field] !== step.after[field],
  );
  const [only] = changed;
  return changed.length === 1 && only !== undefined
    ? `${step.missionId}:${only}`
    : null;
}

export function recordStep(
  history: MissionHistory,
  step: MissionStep,
): MissionHistory {
  const group = groupOf(step);
  const last = history.done.at(-1);
  if (
    group !== null &&
    group === history.group &&
    last?.kind === 'edit' &&
    step.kind === 'edit'
  ) {
    return {
      done: [...history.done.slice(0, -1), { ...last, after: step.after }],
      undone: [],
      group,
    };
  }
  return {
    done: [...history.done, step].slice(-MISSION_HISTORY_LIMIT),
    undone: [],
    group,
  };
}

export function nextUndo(history: MissionHistory): MissionStep | null {
  return history.done.at(-1) ?? null;
}

export function nextRedo(history: MissionHistory): MissionStep | null {
  return history.undone[0] ?? null;
}

export function afterUndo(history: MissionHistory): MissionHistory {
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

export function afterRedo(history: MissionHistory): MissionHistory {
  const [step, ...rest] = history.undone;
  if (step === undefined) {
    return history;
  }
  return { done: [...history.done, step], undone: rest, group: null };
}
