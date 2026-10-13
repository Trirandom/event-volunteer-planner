// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { Temporal } from '@evp/shared/time';
import { describe, expect, it } from 'vitest';

import {
  middleOf,
  planCutMove,
  planDeleteRun,
  planEdgeMove,
  planNewRun,
  planRecut,
  planSplitRun,
  settledCut,
  settledEdge,
  settledNewRun,
  type BoardOp,
} from './edit';
import type { BarShift, Run } from './runs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const OPEN = Temporal.Instant.from('2026-09-05T08:00:00Z').epochMilliseconds;
const CLOSE = OPEN + 12 * HOUR;

function barShift(
  id: string,
  startMs: number,
  endMs: number,
  requiredCount = 1,
): BarShift {
  return {
    id,
    version: 3,
    startMs,
    endMs,
    title: 'Bar',
    requiredCount,
    maxCount: null,
  };
}

function run(shifts: readonly BarShift[], key = 'bar:0'): Run {
  const startMs = shifts[0]?.startMs ?? OPEN;
  return {
    key,
    eventId: 'fri',
    eventName: 'Friday',
    locationId: 'bar',
    timezone: 'Europe/Paris',
    boundsStartMs: OPEN,
    boundsEndMs: CLOSE,
    eventVersion: 7,
    color: 0,
    publicStartMs: null,
    publicEndMs: null,
    startMs,
    endMs: shifts.reduce((latest, s) => Math.max(latest, s.endMs), startMs),
    shifts,
    cutsMs: shifts.slice(1).map((s) => s.startMs),
    proposed: false,
  };
}

function proposedRun(key = 'bar:0'): Run {
  return { ...run([], key), startMs: OPEN, endMs: CLOSE, proposed: true };
}

/** Two 2-hour shifts, 08:00–12:00Z, with 8 hours of event left after them. */
function twoShiftRun(): Run {
  return run([
    barShift('a', OPEN, OPEN + 2 * HOUR),
    barShift('b', OPEN + 2 * HOUR, OPEN + 4 * HOUR),
  ]);
}

const CUT = 120;
const STEP = 15;

/**
 * The axis, two hours past the day at each end — what `PlanShiftsView` draws
 * so that an outward drag has somewhere to land.
 *
 * Every test that does not care about the margin still has to state it, which
 * is the point: the reach is the board's, not the planner's, and a default
 * here would let a plan quietly assume a board that does not exist.
 */
const REACH = { startMs: OPEN - 2 * HOUR, endMs: CLOSE + 2 * HOUR };

function move(
  runs: readonly Run[],
  runKey: string,
  edge: 'start' | 'end',
  toMs: number,
  reach = REACH,
): readonly BoardOp[] {
  return planEdgeMove({
    runs,
    runKey,
    edge,
    toMs,
    cutMinutes: CUT,
    stepMinutes: STEP,
    reach,
  });
}

describe('planEdgeMove — dragging the end later', () => {
  it('tiles the new stretch at the cut length', () => {
    const subject = twoShiftRun();
    const ops = move([subject], subject.key, 'end', OPEN + 8 * HOUR);

    expect(ops).toEqual([
      {
        kind: 'create',
        eventId: 'fri',
        locationId: 'bar',
        startMs: OPEN + 4 * HOUR,
        endMs: OPEN + 6 * HOUR,
        requiredCount: 1,
      },
      {
        kind: 'create',
        eventId: 'fri',
        locationId: 'bar',
        startMs: OPEN + 6 * HOUR,
        endMs: OPEN + 8 * HOUR,
        requiredCount: 1,
      },
    ]);
  });

  /** docs/04 is explicit that a remainder is never rounded up. A coordinator
   * who drags to 17:30 gets a 90-minute last slot, not a 2-hour one that
   * reaches past where they let go. */
  it('truncates the last slot rather than overshooting the drag', () => {
    const subject = twoShiftRun();
    const ops = move([subject], subject.key, 'end', OPEN + 7 * HOUR);

    expect(ops).toHaveLength(2);
    expect(ops[1]).toMatchObject({
      startMs: OPEN + 6 * HOUR,
      endMs: OPEN + 7 * HOUR,
    });
  });

  it('inherits the headcount of the slot it is growing from', () => {
    const subject = run([barShift('a', OPEN, OPEN + 2 * HOUR, 4)]);
    const ops = move([subject], subject.key, 'end', OPEN + 4 * HOUR);

    expect(ops[0]).toMatchObject({ kind: 'create', requiredCount: 4 });
  });

  /** The end of the day used to be where this stopped. It now takes the day
   * with it — see "lengthening the day to fit the work" below — and what is
   * left to stop it is the end of the axis. */
  it('stops at the end of the axis, not at the end of its own event', () => {
    const subject = twoShiftRun();
    const ops = move([subject], subject.key, 'end', REACH.endMs + 5 * HOUR);

    expect(ops.at(-1)).toMatchObject({ kind: 'create', endMs: REACH.endMs });
  });
});

describe('planEdgeMove — dragging the end earlier', () => {
  it('truncates the slot the edge lands inside', () => {
    const subject = twoShiftRun();
    const ops = move([subject], subject.key, 'end', OPEN + 3 * HOUR);

    expect(ops).toEqual([
      {
        kind: 'patch',
        eventId: 'fri',
        shiftId: 'b',
        version: 3,
        startMs: OPEN + 2 * HOUR,
        endMs: OPEN + 3 * HOUR,
      },
    ]);
  });

  it('deletes the slots it passes entirely', () => {
    const subject = twoShiftRun();
    const ops = move([subject], subject.key, 'end', OPEN + 2 * HOUR);

    expect(ops).toEqual([
      { kind: 'delete', eventId: 'fri', shiftId: 'b', version: 3 },
    ]);
  });

  /** Dragging an edge past its opposite edge would ask the database for an
   * empty range, which `shifts_period_valid` refuses. One step is the floor,
   * and deleting a bar is an explicit action rather than an overshot drag. */
  it('never collapses a bar to nothing', () => {
    const subject = twoShiftRun();
    const ops = move([subject], subject.key, 'end', OPEN - 3 * HOUR);

    expect(ops).toEqual([
      { kind: 'delete', eventId: 'fri', shiftId: 'b', version: 3 },
      {
        kind: 'patch',
        eventId: 'fri',
        shiftId: 'a',
        version: 3,
        startMs: OPEN,
        endMs: OPEN + STEP * MINUTE,
      },
    ]);
  });
});

describe('planEdgeMove — dragging the start', () => {
  it('tiles backwards from the existing edge when growing', () => {
    const subject = run([barShift('a', OPEN + 4 * HOUR, OPEN + 6 * HOUR)]);
    const ops = move([subject], subject.key, 'start', OPEN + 1 * HOUR);

    expect(ops).toEqual([
      {
        kind: 'create',
        eventId: 'fri',
        locationId: 'bar',
        startMs: OPEN + 2 * HOUR,
        endMs: OPEN + 4 * HOUR,
        requiredCount: 1,
      },
      {
        kind: 'create',
        eventId: 'fri',
        locationId: 'bar',
        startMs: OPEN + 1 * HOUR,
        endMs: OPEN + 2 * HOUR,
        requiredCount: 1,
      },
    ]);
  });

  it('stops at the start of the axis, not at the start of its own event', () => {
    const subject = run([barShift('a', OPEN + 1 * HOUR, OPEN + 3 * HOUR)]);
    const ops = move([subject], subject.key, 'start', REACH.startMs - 6 * HOUR);

    expect(ops.at(-1)).toMatchObject({
      kind: 'create',
      startMs: REACH.startMs,
    });
  });

  it('truncates the slot the edge lands inside when shrinking', () => {
    const subject = twoShiftRun();
    const ops = move([subject], subject.key, 'start', OPEN + 1 * HOUR);

    expect(ops).toEqual([
      {
        kind: 'patch',
        eventId: 'fri',
        shiftId: 'a',
        version: 3,
        startMs: OPEN + 1 * HOUR,
        endMs: OPEN + 2 * HOUR,
      },
    ]);
  });

  it('deletes the slots it passes entirely when shrinking', () => {
    const subject = twoShiftRun();
    const ops = move([subject], subject.key, 'start', OPEN + 2 * HOUR);

    expect(ops).toEqual([
      { kind: 'delete', eventId: 'fri', shiftId: 'a', version: 3 },
    ]);
  });
});

describe('planEdgeMove — merging', () => {
  const first = run([barShift('a', OPEN, OPEN + 2 * HOUR)], 'bar:0');
  const second = run(
    [barShift('c', OPEN + 6 * HOUR, OPEN + 8 * HOUR)],
    'bar:1',
  );

  /**
   * Merging is not a separate operation. Filling the gap is all there is: the
   * next render folds two touching bars into one, because a bar was only ever
   * a reading of the shift rows (`runs.ts`).
   */
  it('fills the gap exactly, and no further, when dragged into a neighbour', () => {
    const ops = move([first, second], 'bar:0', 'end', OPEN + 7 * HOUR);

    expect(ops.at(-1)).toMatchObject({ endMs: OPEN + 6 * HOUR });
    expect(
      ops.every((op) => op.kind === 'create' && op.endMs <= OPEN + 6 * HOUR),
    ).toBe(true);
  });

  it('caps at the neighbour rather than overlapping it', () => {
    const ops = move([first, second], 'bar:0', 'end', OPEN + 6 * HOUR);
    const covered = ops.reduce(
      (total, op) =>
        op.kind === 'create' ? total + (op.endMs - op.startMs) : total,
      0,
    );

    expect(covered).toBe(4 * HOUR);
  });

  it('caps a leftward drag at the neighbour before it', () => {
    const ops = move([first, second], 'bar:1', 'start', OPEN);

    expect(ops.at(-1)).toMatchObject({ startMs: OPEN + 2 * HOUR });
  });

  /** A neighbour is a bar at the *same* location. On the festival axis one
   * row carries several days; Saturday's bar is not in Friday's way. */
  it('ignores a bar at another location on the same row', () => {
    const elsewhere: Run = {
      ...run([barShift('z', OPEN + 6 * HOUR, OPEN + 8 * HOUR)], 'other:0'),
      locationId: 'entrance',
    };
    const ops = move([first, elsewhere], 'bar:0', 'end', OPEN + 8 * HOUR);

    expect(ops.at(-1)).toMatchObject({ endMs: OPEN + 8 * HOUR });
  });
});

describe('planEdgeMove — a bar nobody has cut yet', () => {
  it('writes the whole proposal, cut at the current length', () => {
    const ops = move([proposedRun()], 'bar:0', 'end', OPEN + 4 * HOUR);

    expect(ops).toEqual([
      {
        kind: 'create',
        eventId: 'fri',
        locationId: 'bar',
        startMs: OPEN,
        endMs: OPEN + 2 * HOUR,
        requiredCount: 1,
      },
      {
        kind: 'create',
        eventId: 'fri',
        locationId: 'bar',
        startMs: OPEN + 2 * HOUR,
        endMs: OPEN + 4 * HOUR,
        requiredCount: 1,
      },
    ]);
  });

  it('keeps the far edge where the proposal had it', () => {
    const ops = move([proposedRun()], 'bar:0', 'start', OPEN + 10 * HOUR);

    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      startMs: OPEN + 10 * HOUR,
      endMs: CLOSE,
    });
  });
});

describe('planEdgeMove — nothing to do', () => {
  it('plans no writes when the edge did not move', () => {
    const subject = twoShiftRun();
    expect(move([subject], subject.key, 'end', subject.endMs)).toEqual([]);
    expect(move([subject], subject.key, 'start', subject.startMs)).toEqual([]);
  });

  it('plans no writes for a bar that is not on the row', () => {
    const subject = twoShiftRun();
    expect(move([subject], 'nope:0', 'end', OPEN + 8 * HOUR)).toEqual([]);
  });
});

/**
 * The end of the day used to be a wall, and it was the only one that ever got
 * hit: every bar is *born* spanning its whole event — a mission nobody has cut
 * is drawn across the day, and `Cut` tiles the day — so the first edge anyone
 * pulled outwards had nowhere to go, silently, while pulling inwards worked.
 * The day moves now, and what is left to refuse is another bar at the same
 * post and the far end of the axis.
 */
describe('settledEdge — how far an edge gets', () => {
  const fills = run([barShift('a', OPEN, CLOSE)]);

  it('says nothing when the edge landed where it was asked', () => {
    const subject = twoShiftRun();
    expect(
      settledEdge([subject], subject.key, 'end', OPEN + 6 * HOUR, STEP, REACH),
    ).toEqual({ ms: OPEN + 6 * HOUR, stoppedBy: null, widensEvent: null });
  });

  it('goes past the end of the day, and reports the day it needs', () => {
    expect(
      settledEdge([fills], fills.key, 'end', CLOSE + HOUR, STEP, REACH),
    ).toEqual({
      ms: CLOSE + HOUR,
      stoppedBy: null,
      widensEvent: { startMs: OPEN, endMs: CLOSE + HOUR },
    });
  });

  it('goes past the start of the day the same way', () => {
    expect(
      settledEdge([fills], fills.key, 'start', OPEN - HOUR, STEP, REACH),
    ).toEqual({
      ms: OPEN - HOUR,
      stoppedBy: null,
      widensEvent: { startMs: OPEN - HOUR, endMs: CLOSE },
    });
  });

  /** The axis is the one thing a drag may not reach past: the board would be
   * planning somewhere the coordinator cannot see. */
  it('stops at the end of the axis', () => {
    expect(
      settledEdge(
        [fills],
        fills.key,
        'end',
        REACH.endMs + 5 * HOUR,
        STEP,
        REACH,
      ),
    ).toEqual({
      ms: REACH.endMs,
      stoppedBy: 'axis',
      widensEvent: { startMs: OPEN, endMs: REACH.endMs },
    });
  });

  it('names the neighbour when another bar is in the way', () => {
    const first = run([barShift('a', OPEN, OPEN + 2 * HOUR)], 'bar:0');
    const second = run(
      [barShift('c', OPEN + 6 * HOUR, OPEN + 8 * HOUR)],
      'bar:1',
    );

    expect(
      settledEdge([first, second], 'bar:0', 'end', CLOSE, STEP, REACH),
    ).toEqual({
      ms: OPEN + 6 * HOUR,
      stoppedBy: 'neighbour',
      widensEvent: null,
    });
  });

  /** A drag that stops exactly on the limit asked for nothing more, so there
   * is nothing to explain — the coordinator got what they pointed at. */
  it('says nothing when the edge was asked for exactly the limit', () => {
    expect(
      settledEdge([fills], fills.key, 'end', REACH.endMs, STEP, REACH)
        ?.stoppedBy,
    ).toBeNull();
  });

  /**
   * Shrinking is never a widening. An event that grew every time a shift did
   * would be one thing; an event that *shrank* every time a shift did would
   * lose the montage morning the first time somebody trimmed the bar.
   */
  it('never narrows the day', () => {
    const subject = twoShiftRun();
    expect(
      settledEdge([subject], subject.key, 'end', OPEN + HOUR, STEP, REACH)
        ?.widensEvent,
    ).toBeNull();
  });

  it('stays quiet when a shrink hits the one-step floor', () => {
    const subject = twoShiftRun();
    expect(
      settledEdge([subject], subject.key, 'end', OPEN, STEP, REACH)?.stoppedBy,
    ).toBeNull();
  });

  it('is null for a bar that is not on the row', () => {
    expect(
      settledEdge([fills], 'nope:0', 'end', CLOSE, STEP, REACH),
    ).toBeNull();
  });
});

/**
 * The feature this whole change exists for: pulling a bar past closing time
 * lengthens the day and cuts the slot, in that order.
 *
 * The order is not cosmetic. Both halves of the shift-inside-event rule are
 * `DEFERRABLE INITIALLY IMMEDIATE` constraint triggers, so a slot written
 * before the event covers it is refused at the statement — and the board sends
 * a plan one write at a time and stops at the first refusal
 * (`api/useShiftWrites.ts`), so the wrong order does not fail atomically, it
 * fails halfway.
 */
describe('planEdgeMove — lengthening the day to fit the work', () => {
  const fills = run([barShift('a', OPEN, CLOSE)]);

  it('widens the event first, then tiles the new stretch', () => {
    const ops = move([fills], fills.key, 'end', CLOSE + 2 * HOUR);

    expect(ops[0]).toEqual({
      kind: 'extend-event',
      eventId: 'fri',
      version: 7,
      startMs: OPEN,
      endMs: CLOSE + 2 * HOUR,
    });
    expect(ops.slice(1)).toEqual([
      {
        kind: 'create',
        eventId: 'fri',
        locationId: 'bar',
        startMs: CLOSE,
        endMs: CLOSE + 2 * HOUR,
        requiredCount: 1,
      },
    ]);
  });

  /** One slot, at the mission's own length, is the unit a coordinator asked
   * for — `cutMinutes`, not the size of the gesture. */
  it('cuts the new stretch at the shift length, truncating the remainder', () => {
    const ops = move([fills], fills.key, 'end', CLOSE + 90 * MINUTE);

    expect(ops.slice(1)).toEqual([
      {
        kind: 'create',
        eventId: 'fri',
        locationId: 'bar',
        startMs: CLOSE,
        endMs: CLOSE + 90 * MINUTE,
        requiredCount: 1,
      },
    ]);
  });

  it('lengthens the day backwards for a start edge', () => {
    const ops = move([fills], fills.key, 'start', OPEN - 2 * HOUR);

    expect(ops[0]).toMatchObject({
      kind: 'extend-event',
      startMs: OPEN - 2 * HOUR,
      endMs: CLOSE,
    });
    expect(ops.at(-1)).toMatchObject({
      kind: 'create',
      startMs: OPEN - 2 * HOUR,
      endMs: OPEN,
    });
  });

  it('carries the headcount of the slot it grew out of', () => {
    const busy = run([barShift('a', OPEN, CLOSE, 4)]);
    const ops = move([busy], busy.key, 'end', CLOSE + HOUR);

    expect(ops.at(-1)).toMatchObject({ kind: 'create', requiredCount: 4 });
  });

  /** A proposal is the first thing a coordinator meets, and it spans the whole
   * day — so the very first outward drag on a fresh board is this case. */
  it('writes a proposal across a day it has just lengthened', () => {
    const ops = move([proposedRun()], 'bar:0', 'end', CLOSE + 2 * HOUR);

    expect(ops[0]).toMatchObject({
      kind: 'extend-event',
      endMs: CLOSE + 2 * HOUR,
    });
    expect(ops.at(-1)).toMatchObject({
      kind: 'create',
      endMs: CLOSE + 2 * HOUR,
    });
  });

  /**
   * A widening with no slot behind it is not an edit anyone made. Sending it
   * anyway would bump the event's `version` under every other coordinator
   * reading the same festival, for nothing.
   */
  it('does not touch the day when the plan writes no shifts', () => {
    expect(move([fills], 'nope:0', 'end', CLOSE + 2 * HOUR)).toEqual([]);
  });

  it('leaves the day alone when the bar stays inside it', () => {
    const subject = twoShiftRun();
    const ops = move([subject], subject.key, 'end', OPEN + 6 * HOUR);

    expect(ops.every((op) => op.kind !== 'extend-event')).toBe(true);
  });
});

describe('op ordering', () => {
  /** Shrink before growing. Nothing in the schema forbids two shifts claiming
   * the same minutes today, but an intermediate state where they do is a
   * state assignments will have to reason about in M3, and the ordering costs
   * nothing now. */
  it('puts deletes and patches before creates', () => {
    const subject = run([
      barShift('a', OPEN + 4 * HOUR, OPEN + 6 * HOUR),
      barShift('b', OPEN + 6 * HOUR, OPEN + 8 * HOUR),
    ]);
    const ops = planRecut(subject, 240);

    const firstCreate = ops.findIndex((op) => op.kind === 'create');
    const lastOther = ops.reduce(
      (index, op, at) => (op.kind === 'create' ? index : at),
      -1,
    );
    expect(firstCreate === -1 || firstCreate > lastOther).toBe(true);
  });
});

describe('planRecut', () => {
  it('re-tiles a bar at the new length, reusing the rows it can', () => {
    const subject = run([
      barShift('a', OPEN, OPEN + 2 * HOUR),
      barShift('b', OPEN + 2 * HOUR, OPEN + 4 * HOUR),
    ]);
    const ops = planRecut(subject, 240);

    expect(ops).toEqual([
      { kind: 'delete', eventId: 'fri', shiftId: 'b', version: 3 },
      {
        kind: 'patch',
        eventId: 'fri',
        shiftId: 'a',
        version: 3,
        startMs: OPEN,
        endMs: OPEN + 4 * HOUR,
      },
    ]);
  });

  it('creates the slots it does not already have rows for', () => {
    const subject = run([barShift('a', OPEN, OPEN + 4 * HOUR)]);
    const ops = planRecut(subject, 120);

    expect(ops).toEqual([
      {
        kind: 'patch',
        eventId: 'fri',
        shiftId: 'a',
        version: 3,
        startMs: OPEN,
        endMs: OPEN + 2 * HOUR,
      },
      {
        kind: 'create',
        eventId: 'fri',
        locationId: 'bar',
        startMs: OPEN + 2 * HOUR,
        endMs: OPEN + 4 * HOUR,
        requiredCount: 1,
      },
    ]);
  });

  it('leaves a row alone when the new tiling already matches it', () => {
    const subject = run([
      barShift('a', OPEN, OPEN + 2 * HOUR),
      barShift('b', OPEN + 2 * HOUR, OPEN + 4 * HOUR),
    ]);

    expect(planRecut(subject, 120)).toEqual([]);
  });

  it('cuts a proposal into slots across its whole event', () => {
    const ops = planRecut(proposedRun(), 360);

    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({ kind: 'create', startMs: OPEN });
    expect(ops[1]).toMatchObject({ kind: 'create', endMs: CLOSE });
  });

  /** `shifts_period_sane` refuses anything longer than 24 hours, so a cut
   * length beyond a day cannot produce a writable slot. */
  it('never plans a slot longer than a day', () => {
    const long: Run = {
      ...proposedRun(),
      boundsEndMs: OPEN + 72 * HOUR,
      endMs: OPEN + 72 * HOUR,
    };
    const ops = planRecut(long, 4320);

    expect(
      ops.every(
        (op) => op.kind !== 'create' || op.endMs - op.startMs <= 24 * HOUR,
      ),
    ).toBe(true);
  });

  it('refuses a cut length that is not a positive number of minutes', () => {
    expect(() => planRecut(twoShiftRun(), 0)).toThrow();
  });
});

describe('planDeleteRun', () => {
  it('removes every slot in the bar', () => {
    const ops = planDeleteRun(twoShiftRun());

    expect(ops).toEqual([
      { kind: 'delete', eventId: 'fri', shiftId: 'a', version: 3 },
      { kind: 'delete', eventId: 'fri', shiftId: 'b', version: 3 },
    ]);
  });

  it('has nothing to remove for a proposal', () => {
    expect(planDeleteRun(proposedRun())).toEqual([]);
  });
});

/**
 * Splitting is the only way to get two series at one post, and it is the one
 * edit that deliberately removes work from the board — so what it removes is
 * specified to the minute rather than felt.
 */
describe('planSplitRun', () => {
  /** Four 2-hour slots, 08:00–16:00Z. */
  function fourShiftRun(): Run {
    return run([
      barShift('a', OPEN, OPEN + 2 * HOUR),
      barShift('b', OPEN + 2 * HOUR, OPEN + 4 * HOUR),
      barShift('c', OPEN + 4 * HOUR, OPEN + 6 * HOUR),
      barShift('d', OPEN + 6 * HOUR, OPEN + 8 * HOUR),
    ]);
  }

  /**
   * The gap is the whole point. Two bars that touch are one bar on the next
   * render (`runs.ts`), so a split that only moved a boundary would redraw as
   * the bar it started from.
   */
  it('takes one step out of the bar at the split point', () => {
    const ops = planSplitRun(fourShiftRun(), OPEN + 4 * HOUR, STEP);

    // The join at 12:00Z is already a boundary, so only the shift after it
    // moves: it now starts a quarter of an hour later.
    expect(ops).toEqual([
      {
        kind: 'patch',
        eventId: 'fri',
        shiftId: 'c',
        version: 3,
        startMs: OPEN + 4 * HOUR + 15 * MINUTE,
        endMs: OPEN + 6 * HOUR,
      },
    ]);
  });

  it('divides the slot a split lands inside, keeping its headcount', () => {
    const subject = run([barShift('a', OPEN, OPEN + 4 * HOUR, 3)]);
    const ops = planSplitRun(subject, OPEN + 2 * HOUR, STEP);

    expect(ops).toEqual([
      {
        kind: 'patch',
        eventId: 'fri',
        shiftId: 'a',
        version: 3,
        startMs: OPEN,
        endMs: OPEN + 2 * HOUR,
      },
      {
        kind: 'create',
        eventId: 'fri',
        locationId: 'bar',
        startMs: OPEN + 2 * HOUR + 15 * MINUTE,
        endMs: OPEN + 4 * HOUR,
        // A series that needed three people on the bar still needs three
        // after the break; resetting to one would be the board restaffing an
        // afternoon it was asked to divide.
        requiredCount: 3,
      },
    ]);
  });

  /** A gap wider than the slot it lands in swallows it whole — and a deleted
   * row goes before the patches, like every other plan here. */
  it('deletes a slot the gap covers entirely', () => {
    const subject = run([
      barShift('a', OPEN, OPEN + HOUR),
      barShift('b', OPEN + HOUR, OPEN + HOUR + 15 * MINUTE),
      barShift('c', OPEN + HOUR + 15 * MINUTE, OPEN + 3 * HOUR),
    ]);
    const ops = planSplitRun(subject, OPEN + HOUR, STEP);

    expect(ops).toEqual([
      { kind: 'delete', eventId: 'fri', shiftId: 'b', version: 3 },
    ]);
  });

  it('refuses a split with no work left on one side', () => {
    const subject = fourShiftRun();

    expect(planSplitRun(subject, subject.startMs, STEP)).toEqual([]);
    expect(planSplitRun(subject, subject.endMs - 10 * MINUTE, STEP)).toEqual(
      [],
    );
    expect(planSplitRun(subject, subject.startMs - HOUR, STEP)).toEqual([]);
  });

  /** A proposal is a drawing of an event, not a row. Two drawings of one
   * event would be the second record of it that ADR-0029 refused. */
  it('has nothing to divide in a proposal', () => {
    expect(planSplitRun(proposedRun(), OPEN + HOUR, STEP)).toEqual([]);
  });

  it('refuses a gap that is not a positive number of minutes', () => {
    expect(() => planSplitRun(fourShiftRun(), OPEN + HOUR, 0)).toThrow();
  });
});

describe('middleOf', () => {
  it('picks the join nearest the middle, so no slot is divided', () => {
    const subject = run([
      barShift('a', OPEN, OPEN + 3 * HOUR),
      barShift('b', OPEN + 3 * HOUR, OPEN + 8 * HOUR),
    ]);

    expect(middleOf(subject, STEP)).toBe(OPEN + 3 * HOUR);
  });

  it('falls back to the middle for a bar with no joins at all', () => {
    const subject = run([barShift('a', OPEN, OPEN + 3 * HOUR)]);

    expect(middleOf(subject, STEP)).toBe(OPEN + 90 * MINUTE);
  });
});

/**
 * A join is where one shift hands over to the next, which is the single
 * most-edited fact on a real plan — and pushing one onto its neighbour is a
 * deletion, so both halves are specified.
 */
describe('planCutMove', () => {
  function threeShiftRun(): Run {
    return run([
      barShift('a', OPEN, OPEN + 2 * HOUR),
      barShift('b', OPEN + 2 * HOUR, OPEN + 4 * HOUR),
      barShift('c', OPEN + 4 * HOUR, OPEN + 6 * HOUR),
    ]);
  }

  it('patches both shifts the join divides', () => {
    const ops = planCutMove(threeShiftRun(), 0, OPEN + 3 * HOUR);

    expect(ops).toEqual([
      {
        kind: 'patch',
        eventId: 'fri',
        shiftId: 'a',
        version: 3,
        startMs: OPEN,
        endMs: OPEN + 3 * HOUR,
      },
      {
        kind: 'patch',
        eventId: 'fri',
        shiftId: 'b',
        version: 3,
        startMs: OPEN + 3 * HOUR,
        endMs: OPEN + 4 * HOUR,
      },
    ]);
  });

  it('costs no request at all when the join has not moved', () => {
    expect(planCutMove(threeShiftRun(), 0, OPEN + 2 * HOUR)).toEqual([]);
  });

  /** Two joins that meet leave a shift with no minutes in it, which
   * `shifts_period_sane` refuses — so the row goes and its neighbour covers
   * the whole stretch. */
  it('merges into the shift before it when pushed that far', () => {
    const ops = planCutMove(threeShiftRun(), 1, OPEN + 2 * HOUR);

    expect(ops).toEqual([
      { kind: 'delete', eventId: 'fri', shiftId: 'b', version: 3 },
      {
        kind: 'patch',
        eventId: 'fri',
        shiftId: 'c',
        version: 3,
        startMs: OPEN + 2 * HOUR,
        endMs: OPEN + 6 * HOUR,
      },
    ]);
  });

  it('merges into the shift after it when pushed the other way', () => {
    const ops = planCutMove(threeShiftRun(), 1, OPEN + 6 * HOUR);

    expect(ops).toEqual([
      { kind: 'delete', eventId: 'fri', shiftId: 'c', version: 3 },
      {
        kind: 'patch',
        eventId: 'fri',
        shiftId: 'b',
        version: 3,
        startMs: OPEN + 2 * HOUR,
        endMs: OPEN + 6 * HOUR,
      },
    ]);
  });

  /** A join cannot leave the two shifts it divides: dragging past the next
   * one merges, it does not walk through it. */
  it('clamps to its two neighbours rather than running past them', () => {
    expect(settledCut(threeShiftRun(), 1, OPEN - 10 * HOUR)).toEqual({
      ms: OPEN + 2 * HOUR,
      merges: 'before',
    });
    expect(settledCut(threeShiftRun(), 1, OPEN + 40 * HOUR)).toEqual({
      ms: OPEN + 6 * HOUR,
      merges: 'after',
    });
    expect(planCutMove(threeShiftRun(), 1, OPEN - 10 * HOUR)).toEqual(
      planCutMove(threeShiftRun(), 1, OPEN + 2 * HOUR),
    );
  });

  it('has no join to move at an index the bar does not have', () => {
    expect(settledCut(threeShiftRun(), 7, OPEN)).toBeNull();
    expect(planCutMove(threeShiftRun(), 7, OPEN)).toEqual([]);
    expect(planCutMove(proposedRun(), 0, OPEN)).toEqual([]);
  });
});

/**
 * Drawing a second series on a stretch of empty lane — the gesture that makes
 * "two series in one day" reachable without dragging an edge across the gap a
 * split opened.
 */
describe('settledNewRun', () => {
  const WINDOW = { startMs: OPEN, endMs: CLOSE };

  function draw(
    runs: readonly Run[],
    anchorMs: number,
    toMs: number,
    window = WINDOW,
  ) {
    return settledNewRun({
      runs,
      locationId: 'bar',
      window,
      anchorMs,
      toMs,
      stepMinutes: STEP,
    });
  }

  it('fills the stretch the drag covered, whichever way it went', () => {
    const drawn = { startMs: OPEN + 6 * HOUR, endMs: OPEN + 9 * HOUR };

    expect(draw([], OPEN + 6 * HOUR, OPEN + 9 * HOUR)).toEqual(drawn);
    expect(draw([], OPEN + 9 * HOUR, OPEN + 6 * HOUR)).toEqual(drawn);
  });

  /** The bar beside it is felt, not written over: two rows claiming one
   * minute at one post is a shape the board can draw and nobody meant. */
  it('stops at the bar it is drawn towards', () => {
    const neighbour = run([barShift('a', OPEN + 8 * HOUR, OPEN + 10 * HOUR)]);

    expect(draw([neighbour], OPEN + 6 * HOUR, OPEN + 11 * HOUR)).toEqual({
      startMs: OPEN + 6 * HOUR,
      endMs: OPEN + 8 * HOUR,
    });
  });

  it('stays inside the day it started in', () => {
    expect(draw([], OPEN + 11 * HOUR, CLOSE + 5 * HOUR)).toEqual({
      startMs: OPEN + 11 * HOUR,
      endMs: CLOSE,
    });
    expect(draw([], CLOSE, CLOSE + HOUR)).toBeNull();
  });

  /** A press inside an existing bar is an edge drag on that bar, not a new
   * series underneath it. */
  it('draws nothing from inside a bar that is already there', () => {
    const existing = run([barShift('a', OPEN, OPEN + 4 * HOUR)]);

    expect(draw([existing], OPEN + HOUR, OPEN + 6 * HOUR)).toBeNull();
  });

  it('ignores bars at other posts on the same row', () => {
    const elsewhere: Run = {
      ...run([barShift('a', OPEN + 2 * HOUR, OPEN + 10 * HOUR)], 'door:0'),
      locationId: 'door',
    };

    expect(draw([elsewhere], OPEN + 3 * HOUR, OPEN + 5 * HOUR)).toEqual({
      startMs: OPEN + 3 * HOUR,
      endMs: OPEN + 5 * HOUR,
    });
  });

  /** A click is not a drag: anything shorter than one step is the coordinator
   * putting the pointer down, not asking for a shift. */
  it('draws nothing shorter than one step', () => {
    expect(draw([], OPEN + 2 * HOUR, OPEN + 2 * HOUR + 10 * MINUTE)).toBeNull();
  });
});

describe('planNewRun', () => {
  it('tiles the drawn stretch at the mission slot length', () => {
    const ops = planNewRun(
      'fri',
      'bar',
      { startMs: OPEN + 6 * HOUR, endMs: OPEN + 9 * HOUR },
      CUT,
    );

    expect(ops).toEqual([
      {
        kind: 'create',
        eventId: 'fri',
        locationId: 'bar',
        startMs: OPEN + 6 * HOUR,
        endMs: OPEN + 8 * HOUR,
        requiredCount: 1,
      },
      {
        kind: 'create',
        eventId: 'fri',
        locationId: 'bar',
        startMs: OPEN + 8 * HOUR,
        endMs: OPEN + 9 * HOUR,
        requiredCount: 1,
      },
    ]);
  });
});
