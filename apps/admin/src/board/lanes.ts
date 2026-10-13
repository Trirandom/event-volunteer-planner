// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * Laying intervals onto as few rows as their overlaps demand.
 *
 * The board has two places that need this and they are the same problem: the
 * event strip under the ruler (`eventLanes.ts`), where a main stage and an
 * afterparty must not be drawn on top of each other, and a mission's own row,
 * where one post's bars come from several days at once. A festival-wide board
 * shows Saturday's bar and the afterparty's bar on one line called "Bar", and
 * when those two days genuinely overlap the two bars land on the same pixels —
 * one hiding the other, which on a board whose whole job is showing where the
 * hole is, is the worst thing it can do.
 *
 * Packing is greedy over start time, which is optimal for interval graphs (the
 * rows it uses equal the deepest overlap) and stable: the same items always
 * land on the same rows, so nothing reshuffles under a coordinator when an
 * unrelated day is edited.
 *
 * Pure, and generic over the item so the two callers cannot drift into two
 * different answers about what "overlapping" means.
 */
import type { Run } from './runs';

export interface Lane<T> {
  readonly item: T;
  /** 0-based row. Overlapping items never share one. */
  readonly row: number;
}

export interface Lanes<T> {
  readonly lanes: readonly Lane<T>[];
  /** How many rows the packing needs — what the caller is made taller by. */
  readonly rowCount: number;
}

/** What packing needs to know about an item: when it runs, and a tiebreak
 * that does not depend on the order it was fetched in. */
export interface Span {
  readonly startMs: number;
  readonly endMs: number;
  readonly key: string;
}

/**
 * Lay every item out, splitting onto extra rows only where they overlap.
 *
 * Periods are half-open, as they are everywhere else on the wire (docs/04 §1),
 * so an item ending exactly when the next one starts shares its row: those two
 * are consecutive, not concurrent, and spending a second row on them would
 * make a plain two-day festival look like two parallel productions.
 */
export function packLanes<T>(
  items: readonly T[],
  spanOf: (item: T) => Span,
): Lanes<T> {
  const ordered = [...items].sort((a, b) => {
    const left = spanOf(a);
    const right = spanOf(b);
    return (
      left.startMs - right.startMs ||
      left.endMs - right.endMs ||
      (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
    );
  });

  // Per row, the instant it is free from. Because the walk is in start order,
  // the last item placed on a row is also the one reaching furthest right on
  // it, so one number per row is the whole state the packing needs.
  const freeFrom: number[] = [];

  const lanes = ordered.map((item): Lane<T> => {
    const span = spanOf(item);
    const found = freeFrom.findIndex((end) => end <= span.startMs);
    const row = found === -1 ? freeFrom.length : found;
    freeFrom[row] = span.endMs;
    return { item, row };
  });

  return { lanes, rowCount: freeFrom.length };
}

/**
 * One mission's bars, stacked where two days run its post at the same time.
 *
 * Two bars at the *same* location can never overlap — `runs.ts` folds shifts
 * that touch or overlap into one bar — so every extra row here is two
 * different days, or two different posts folded into one mission by name. Both
 * are readings a coordinator needs to see rather than have hidden: an
 * afterparty that laps the club night staffs its bar separately, and the chips
 * carry each day's own colour to say which is which.
 */
export function runLanes(runs: readonly Run[]): Lanes<Run> {
  return packLanes(runs, (run) => ({
    startMs: run.startMs,
    endMs: run.endMs,
    key: run.key,
  }));
}
