// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * What a drag *means*: an edge and a target instant, turned into shift writes.
 *
 * This is the module that makes the board honest. A bar is only a reading of
 * the shift rows (`runs.ts`), so "extend", "shorten" and "merge" are not three
 * operations — they are three shapes of the same question, *which shifts have
 * to be created, patched or deleted so that the bar ends where the pointer
 * let go*. Merging in particular is not implemented at all: filling the gap
 * between two bars is the whole of it, because the next render folds two
 * touching bars into one on its own.
 *
 * Pure, and specified rather than felt. docs/13 §2 exempts the board's drag
 * *geometry* from test-first and does not exempt this: a wrong answer here
 * deletes a coordinator's evening, not a few pixels.
 *
 * The rules that constrain every plan produced here are database rules, not
 * preferences (docs/02 §5): a shift may not fall outside its event, may not
 * be longer than 24 hours, and may not be empty. Each is enforced by a
 * constraint the API maps to a 422 — clamping here is so a coordinator feels
 * the edge of the day instead of collecting an error from it.
 *
 * **"Outside its event" is now answered by moving the event.** The rule is
 * untouched and still a constraint trigger; what changed is what the board
 * does when a drag would break it. A bar pulled past closing time is a
 * coordinator saying the crew works later than the doors are open, which is
 * true of every event anyone has ever run, so the plan widens the day and
 * then cuts the slot — in that order, because the trigger is
 * `INITIALLY IMMEDIATE` and would refuse the shift if it landed first.
 *
 * It widens the operational window and **nothing else**. The server used to
 * take the first widening as a statement about the doors, keeping the old
 * period as `public_period`; that is gone. A drag is about where the crew
 * works, and the period it happens to displace is whatever was last typed
 * into the event, not a published time anybody announced. Door times are set
 * on the event details page or not at all.
 */
import { clampMs } from './scale';
import type { BarShift, Run } from './runs';

const MS_PER_MINUTE = 60_000;

/** `shifts_period_sane`: nothing longer than a day is writable. */
const MAX_SLOT_MINUTES = 24 * 60;

export type Edge = 'start' | 'end';

/**
 * How far the board lets an edge travel — the axis, which reaches a margin
 * past the days laid on it precisely so there is somewhere to drag to.
 *
 * An argument rather than a constant because the axis belongs to the view: it
 * is what the coordinator can see and point at, and a plan that could reach
 * further than the board draws would be a plan nobody asked for.
 */
export interface Reach {
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * One write the board wants.
 *
 * `version` travels on every patch and delete because `If-Match` is required,
 * not optional — `evp-api`'s `Precondition` extractor answers a request
 * without one with `428`, and docs/02 §7 makes the stale case a visible "someone
 * else changed this" rather than a silent overwrite.
 */
export type ShiftOp =
  | {
      readonly kind: 'create';
      readonly eventId: string;
      readonly locationId: string;
      readonly startMs: number;
      readonly endMs: number;
      readonly requiredCount: number;
    }
  | {
      readonly kind: 'patch';
      readonly eventId: string;
      readonly shiftId: string;
      readonly version: number;
      readonly startMs: number;
      readonly endMs: number;
    }
  | {
      readonly kind: 'delete';
      readonly eventId: string;
      readonly shiftId: string;
      readonly version: number;
    };

/**
 * Widen the day itself, so the slots that follow have somewhere to live.
 *
 * `startMs`/`endMs` are the event's **whole new period**, not the delta: a
 * `PATCH` sets a period, and sending an edge would make the server reconstruct
 * a range it was never given. Only one end ever moves in practice, and the
 * other is sent unchanged.
 */
export interface ExtendEventOp {
  readonly kind: 'extend-event';
  readonly eventId: string;
  readonly version: number;
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * Everything one drag may have to write.
 *
 * A plan stopped being only shifts the day a bar could push the end of the
 * event outwards, and a type still called `ShiftOp[]` would have hidden that
 * a drag can now change the event a whole festival is planned around.
 */
export type BoardOp = ShiftOp | ExtendEventOp;

export interface EdgeMove {
  /** Every bar on the row. Neighbours are read from it, so a merge needs no
   * separate signal. */
  readonly runs: readonly Run[];
  readonly runKey: string;
  readonly edge: Edge;
  readonly toMs: number;
  /** The mission's current slot length — the tool setting, not stored data. */
  readonly cutMinutes: number;
  /** The board's snap granularity, and the floor on how short a drag may
   * leave a bar. */
  readonly stepMinutes: number;
  /** The axis. Nothing may be planned past what the coordinator can see. */
  readonly reach: Reach;
}

/**
 * Shrink first, grow second.
 *
 * Nothing in the schema forbids two shifts claiming the same minutes today —
 * there is no exclusion constraint on `shifts` — but an intermediate state
 * where they do is one that assignments will have to reason about when they
 * land in M3, and ordering the plan costs nothing now.
 */
function ordered(
  deletes: readonly ShiftOp[],
  patches: readonly ShiftOp[],
  creates: readonly ShiftOp[],
): readonly ShiftOp[] {
  return [...deletes, ...patches, ...creates];
}

function assertPositiveCut(cutMinutes: number): number {
  if (!(cutMinutes > 0)) {
    throw new RangeError('a cut length must be a positive number of minutes');
  }
  return Math.min(cutMinutes, MAX_SLOT_MINUTES);
}

/**
 * Lay slots across `[fromMs, toMs)` at `cutMinutes`, left to right.
 *
 * The last slot is truncated, never extended. docs/04 states that rule for
 * generation and it is the same rule for the same reason: a coordinator who
 * drags to 17:30 said 17:30, and a bar that springs past where they let go is
 * the board arguing with them.
 */
function tileForward(
  fromMs: number,
  toMs: number,
  cutMinutes: number,
  make: (startMs: number, endMs: number) => ShiftOp,
): readonly ShiftOp[] {
  const stepMs = assertPositiveCut(cutMinutes) * MS_PER_MINUTE;
  const ops: ShiftOp[] = [];
  for (let at = fromMs; at < toMs; at += stepMs) {
    ops.push(make(at, Math.min(at + stepMs, toMs)));
  }
  return ops;
}

/**
 * The same, walked backwards from `fromMs` down to `toMs`.
 *
 * Backwards rather than forwards from `toMs` so that growing a bar leftwards
 * keeps the cuts it already has where they are: the existing 14:00 boundary
 * does not move because the coordinator reached back to 09:40.
 */
function tileBackward(
  fromMs: number,
  toMs: number,
  cutMinutes: number,
  make: (startMs: number, endMs: number) => ShiftOp,
): readonly ShiftOp[] {
  const stepMs = assertPositiveCut(cutMinutes) * MS_PER_MINUTE;
  const ops: ShiftOp[] = [];
  for (let at = fromMs; at > toMs; at -= stepMs) {
    ops.push(make(Math.max(at - stepMs, toMs), at));
  }
  return ops;
}

function creator(
  run: Run,
  requiredCount: number,
): (startMs: number, endMs: number) => ShiftOp {
  return (startMs, endMs) => ({
    kind: 'create',
    eventId: run.eventId,
    locationId: run.locationId,
    startMs,
    endMs,
    requiredCount,
  });
}

function deleteOp(run: Run, shift: BarShift): ShiftOp {
  return {
    kind: 'delete',
    eventId: run.eventId,
    shiftId: shift.id,
    version: shift.version,
  };
}

function patchOp(
  run: Run,
  shift: BarShift,
  startMs: number,
  endMs: number,
): ShiftOp {
  return {
    kind: 'patch',
    eventId: run.eventId,
    shiftId: shift.id,
    version: shift.version,
    startMs,
    endMs,
  };
}

/**
 * What stopped a bar from growing any further in the direction it was pulled.
 *
 * The end of the day is no longer one of these. It used to be the only one
 * that ever fired, and it is what made this board feel broken: every bar is
 * *born* spanning its whole event — a mission nobody has cut is drawn across
 * the day, and `Cut` tiles the day — so the first edge anyone pulled outwards
 * had nowhere to go, silently, while pulling inwards worked. The day now moves
 * instead, which leaves two real walls: another bar at the same post, and the
 * far end of the axis, which is as far as the coordinator can see.
 */
export type EdgeStop = 'neighbour' | 'axis';

interface Limit {
  readonly ms: number;
  readonly from: EdgeStop;
}

/**
 * How far this bar may grow before it runs into the one beside it.
 *
 * A neighbour is a bar at the **same location**. On the festival-wide axis one
 * mission row carries several days at once, and Saturday's bar is not in
 * Friday's way — reading every bar on the row as a neighbour would refuse a
 * drag for a reason that does not exist.
 */
function growthLimit(
  runs: readonly Run[],
  subject: Run,
  edge: Edge,
  reach: Reach,
): Limit {
  const siblings = runs.filter(
    (run) => run.locationId === subject.locationId && run.key !== subject.key,
  );

  if (edge === 'end') {
    return siblings
      .filter((run) => run.startMs >= subject.endMs)
      .reduce<Limit>(
        (limit, run) =>
          run.startMs < limit.ms
            ? { ms: run.startMs, from: 'neighbour' }
            : limit,
        { ms: reach.endMs, from: 'axis' },
      );
  }
  return siblings
    .filter((run) => run.endMs <= subject.startMs)
    .reduce<Limit>(
      (limit, run) =>
        run.endMs > limit.ms ? { ms: run.endMs, from: 'neighbour' } : limit,
      { ms: reach.startMs, from: 'axis' },
    );
}

/** Where the dragged edge is actually allowed to land. */
function settle(
  subject: Run,
  edge: Edge,
  toMs: number,
  limitMs: number,
  stepMinutes: number,
): number {
  const floorMs = stepMinutes * MS_PER_MINUTE;
  return edge === 'end'
    ? clampMs(toMs, subject.startMs + floorMs, limitMs)
    : clampMs(toMs, limitMs, subject.endMs - floorMs);
}

/** Where an edge asked to go to `toMs` actually ends up, and what that costs. */
export interface SettledEdge {
  readonly ms: number;
  /**
   * What refused the rest of an *outward* pull, or `null` when the edge
   * landed where it was asked.
   *
   * Only outward, because the two directions mean different things. Growth cut
   * short is a fact about the board the coordinator cannot otherwise see — the
   * next bar at this post starts there, or the axis ends there — and it is
   * worth a sentence. A shrink stopped at the one-step floor is the
   * coordinator asking for an empty bar, which the `×` button is for.
   */
  readonly stoppedBy: EdgeStop | null;
  /**
   * The event period this edge needs, when it reaches past the day it is on.
   *
   * Surfaced rather than left inside the plan because the board has to be able
   * to *say* so before it happens: widening a day is not a change to one bar,
   * it is a change to the thing every other row on the screen is drawn
   * against.
   */
  readonly widensEvent: {
    readonly startMs: number;
    readonly endMs: number;
  } | null;
}

/**
 * The same answer, for the ghost the board draws while a pointer is still
 * down.
 *
 * Exported so the preview and the plan cannot disagree. Two copies of this
 * clamp would differ on the day somebody adjusts one of them, and the symptom
 * would be a bar that springs somewhere other than where it was dropped —
 * which reads as the board losing the edit rather than as a bug in a bound.
 *
 * `null` when the row does not carry that bar, which is the same "nothing to
 * do" [`planEdgeMove`] answers with.
 */
export function settledEdge(
  runs: readonly Run[],
  runKey: string,
  edge: Edge,
  toMs: number,
  stepMinutes: number,
  reach: Reach,
): SettledEdge | null {
  const subject = runs.find((run) => run.key === runKey);
  if (subject === undefined) {
    return null;
  }

  const limit = growthLimit(runs, subject, edge, reach);
  const ms = settle(subject, edge, toMs, limit.ms, stepMinutes);
  const asked = edge === 'end' ? toMs > limit.ms : toMs < limit.ms;

  return {
    ms,
    stoppedBy: asked && ms === limit.ms ? limit.from : null,
    widensEvent: widening(subject, edge, ms),
  };
}

/**
 * The event period this edge needs, or `null` when the day already covers it.
 *
 * Only ever outwards. A bar dragged *inwards* leaves the day alone — an event
 * that shrank every time a shift did would lose the montage morning the first
 * time somebody trimmed the bar's last slot.
 */
function widening(subject: Run, edge: Edge, settledMs: number): Period | null {
  if (edge === 'end') {
    return settledMs > subject.boundsEndMs
      ? { startMs: subject.boundsStartMs, endMs: settledMs }
      : null;
  }
  return settledMs < subject.boundsStartMs
    ? { startMs: settledMs, endMs: subject.boundsEndMs }
    : null;
}

/** A stretch of time, in the epoch milliseconds everything on this board is
 * measured in. Exported because a plan now hands one back: the period an event
 * has to grow to, and the stretch a drag across empty lane would fill. */
export interface Period {
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * A bar nobody has cut yet has no rows behind it, so there is nothing to
 * patch or delete — the edit *is* the decision to store it. The far edge
 * stays where the proposal had it, which is the event's own boundary.
 */
function materialise(
  subject: Run,
  edge: Edge,
  settledMs: number,
  cutMinutes: number,
): readonly ShiftOp[] {
  const startMs = edge === 'start' ? settledMs : subject.startMs;
  const endMs = edge === 'end' ? settledMs : subject.endMs;
  return tileForward(startMs, endMs, cutMinutes, creator(subject, 1));
}

/** The headcount a newly grown slot inherits — the one on the slot it grew
 * out of, so a bar that needs two people stays a bar that needs two people. */
function inheritedCount(subject: Run, edge: Edge): number {
  const neighbour =
    edge === 'end' ? subject.shifts.at(-1) : subject.shifts.at(0);
  return neighbour?.requiredCount ?? 1;
}

function growEnd(
  subject: Run,
  settledMs: number,
  cutMinutes: number,
): readonly ShiftOp[] {
  return tileForward(
    subject.endMs,
    settledMs,
    cutMinutes,
    creator(subject, inheritedCount(subject, 'end')),
  );
}

function shrinkEnd(subject: Run, settledMs: number): readonly ShiftOp[] {
  const deletes: ShiftOp[] = [];
  const patches: ShiftOp[] = [];

  for (const shift of subject.shifts) {
    if (shift.startMs >= settledMs) {
      deletes.push(deleteOp(subject, shift));
    } else if (shift.endMs > settledMs) {
      patches.push(patchOp(subject, shift, shift.startMs, settledMs));
    }
  }
  return ordered(deletes, patches, []);
}

function growStart(
  subject: Run,
  settledMs: number,
  cutMinutes: number,
): readonly ShiftOp[] {
  return tileBackward(
    subject.startMs,
    settledMs,
    cutMinutes,
    creator(subject, inheritedCount(subject, 'start')),
  );
}

function shrinkStart(subject: Run, settledMs: number): readonly ShiftOp[] {
  const deletes: ShiftOp[] = [];
  const patches: ShiftOp[] = [];

  for (const shift of subject.shifts) {
    if (shift.endMs <= settledMs) {
      deletes.push(deleteOp(subject, shift));
    } else if (shift.startMs < settledMs) {
      patches.push(patchOp(subject, shift, settledMs, shift.endMs));
    }
  }
  return ordered(deletes, patches, []);
}

/**
 * The writes that move one bar's edge to `toMs`.
 *
 * An empty plan is a real answer and the common one: a drag that ends where it
 * started, or a snap that lands back on the boundary it came from, must cost
 * no request at all.
 *
 * When the edge reaches past the day it is on, the day goes first. Both halves
 * of the shift-inside-event rule are `DEFERRABLE INITIALLY IMMEDIATE`
 * constraint triggers, so the order is not a preference: a slot written before
 * the event covers it is refused at the statement, not at the commit, and the
 * plan would stop there with the day still too small.
 */
export function planEdgeMove({
  runs,
  runKey,
  edge,
  toMs,
  cutMinutes,
  stepMinutes,
  reach,
}: EdgeMove): readonly BoardOp[] {
  const subject = runs.find((run) => run.key === runKey);
  if (subject === undefined) {
    return [];
  }

  const settled = settledEdge(runs, runKey, edge, toMs, stepMinutes, reach);
  const settledMs = settled?.ms ?? subject.endMs;
  const shifts = planShifts(subject, edge, settledMs, cutMinutes);

  // Nothing to widen for a plan that writes nothing: a drag that moved the
  // event but left the shifts alone is not a gesture this board offers, and
  // sending the `PATCH` anyway would bump the event's version under every
  // other coordinator reading it.
  if (shifts.length === 0 || settled?.widensEvent == null) {
    return shifts;
  }

  return [
    {
      kind: 'extend-event',
      eventId: subject.eventId,
      version: subject.eventVersion,
      startMs: settled.widensEvent.startMs,
      endMs: settled.widensEvent.endMs,
    },
    ...shifts,
  ];
}

/** The shift half of an edge move — what the plan was before a drag could
 * move the day. */
function planShifts(
  subject: Run,
  edge: Edge,
  settledMs: number,
  cutMinutes: number,
): readonly ShiftOp[] {
  if (subject.proposed) {
    return materialise(subject, edge, settledMs, cutMinutes);
  }

  if (edge === 'end') {
    if (settledMs === subject.endMs) {
      return [];
    }
    return settledMs > subject.endMs
      ? growEnd(subject, settledMs, cutMinutes)
      : shrinkEnd(subject, settledMs);
  }

  if (settledMs === subject.startMs) {
    return [];
  }
  return settledMs < subject.startMs
    ? growStart(subject, settledMs, cutMinutes)
    : shrinkStart(subject, settledMs);
}

/**
 * Re-cut one bar at a new slot length, keeping its two ends where they are.
 *
 * Existing rows are matched to the new slots **positionally** and patched
 * rather than dropped and recreated. Today that only saves two requests;
 * from M3 it saves the rosters attached to them, and writing it the cheap way
 * now would mean a coordinator who changes 120 to 90 losing an afternoon of
 * assignments.
 */
export function planRecut(
  subject: Run,
  cutMinutes: number,
): readonly ShiftOp[] {
  const targets = tileForward(
    subject.startMs,
    subject.endMs,
    cutMinutes,
    (startMs, endMs) => ({
      kind: 'create',
      eventId: subject.eventId,
      locationId: subject.locationId,
      startMs,
      endMs,
      requiredCount: inheritedCount(subject, 'start'),
    }),
  );

  const deletes: ShiftOp[] = [];
  const patches: ShiftOp[] = [];
  const creates: ShiftOp[] = [];

  subject.shifts.forEach((shift, index) => {
    const target = targets[index];
    if (target === undefined) {
      deletes.push(deleteOp(subject, shift));
    } else if (
      target.kind === 'create' &&
      (target.startMs !== shift.startMs || target.endMs !== shift.endMs)
    ) {
      patches.push(patchOp(subject, shift, target.startMs, target.endMs));
    }
  });

  creates.push(...targets.slice(subject.shifts.length));

  return ordered(deletes, patches, creates);
}

/** Remove a bar outright. A proposal has nothing to remove. */
export function planDeleteRun(subject: Run): readonly ShiftOp[] {
  return subject.shifts.map((shift) => deleteOp(subject, shift));
}

// ---------------------------------------------------------------------------
// Breaking one series into two, and moving the joins inside one
// ---------------------------------------------------------------------------

/**
 * Where a split is allowed to land, and what it carves out.
 *
 * A bar is a *maximal* contiguous stretch of shifts (`runs.ts`): two shifts
 * that touch are one bar on the next render, whatever the coordinator meant.
 * So "give this post two separate series" cannot be expressed by a boundary —
 * it is expressed by an **absence**, and a split has to take some minutes off
 * the board to make one. The gap it opens is one step, the finest thing the
 * board offers, because the coordinator's next gesture is to drag the second
 * series' start to where the break really is and a wider default would be the
 * board guessing at that for them.
 *
 * `null` where the split has nothing to do: at or past either end there is no
 * second series to leave behind, and asking for one would silently shorten the
 * bar instead — which is the edge drag, and is not what a double click said.
 */
export interface SplitRange {
  readonly fromMs: number;
  readonly toMs: number;
}

export function splitRange(
  subject: Run,
  atMs: number,
  gapMinutes: number,
): SplitRange | null {
  if (!(gapMinutes > 0)) {
    throw new RangeError('a split gap must be a positive number of minutes');
  }
  // A proposal has no rows behind it, so there is nothing to divide: the whole
  // bar is a drawing of an event, and two drawings of one event would be a
  // second record of it — exactly what ADR-0029 refused.
  if (subject.proposed) {
    return null;
  }

  const range = { fromMs: atMs, toMs: atMs + gapMinutes * MS_PER_MINUTE };
  return range.fromMs <= subject.startMs || range.toMs >= subject.endMs
    ? null
    : range;
}

/**
 * The join nearest the middle of a bar, which is where a split with no pointer
 * behind it goes.
 *
 * Not the geometric middle when the bar already has joins: cutting at an
 * existing boundary costs one slot's tail and no shift is divided, whereas the
 * middle of a 2-hour slot divides it and leaves two odd stubs. The middle is
 * only the answer for a bar nobody has cut, where there is no boundary to
 * prefer.
 */
export function middleOf(subject: Run, stepMinutes: number): number {
  const middleMs = subject.startMs + (subject.endMs - subject.startMs) / 2;
  const nearest = subject.cutsMs.reduce<number | null>(
    (best, cut) =>
      best === null || Math.abs(cut - middleMs) < Math.abs(best - middleMs)
        ? cut
        : best,
    null,
  );
  // Anchored on the bar's own start, never on the epoch: a grid measured from
  // the epoch is a grid in UTC, and `snapMs` exists in `scale.ts` for exactly
  // that reason. A bar that begins at 10:07 is divided at 10:07 plus a whole
  // number of steps, not at a clock its event does not run on.
  const stepMs = stepMinutes * MS_PER_MINUTE;
  const fromStart = Math.round((middleMs - subject.startMs) / stepMs) * stepMs;
  return nearest ?? subject.startMs + fromStart;
}

/**
 * Break one bar in two at `atMs`, by taking `gapMinutes` out of it.
 *
 * Every shift the gap touches is trimmed to what survives on either side of
 * it: one that straddles the gap is patched down to its left half and a fresh
 * row is written for its right, one that only pokes into the gap is patched,
 * and one the gap swallows whole is deleted. Deletes first, then the patches,
 * then the creates — the same order every plan here uses, so no intermediate
 * state has two rows claiming one minute (`ordered`).
 *
 * The headcount is carried onto the new row from the shift it was split out
 * of. A series that needed two people on the bar still needs two people after
 * lunch, and resetting to one would be the board quietly restaffing an
 * afternoon it was only asked to divide.
 */
export function planSplitRun(
  subject: Run,
  atMs: number,
  gapMinutes: number,
): readonly ShiftOp[] {
  const range = splitRange(subject, atMs, gapMinutes);
  if (range === null) {
    return [];
  }

  const deletes: ShiftOp[] = [];
  const patches: ShiftOp[] = [];
  const creates: ShiftOp[] = [];

  for (const shift of subject.shifts) {
    if (shift.endMs <= range.fromMs || shift.startMs >= range.toMs) {
      continue;
    }
    const keepsLeft = shift.startMs < range.fromMs;
    const keepsRight = shift.endMs > range.toMs;

    if (keepsLeft) {
      patches.push(patchOp(subject, shift, shift.startMs, range.fromMs));
      if (keepsRight) {
        creates.push(
          creator(subject, shift.requiredCount)(range.toMs, shift.endMs),
        );
      }
    } else if (keepsRight) {
      patches.push(patchOp(subject, shift, range.toMs, shift.endMs));
    } else {
      deletes.push(deleteOp(subject, shift));
    }
  }

  return ordered(deletes, patches, creates);
}

/**
 * Where a join between two shifts may be dragged to, and what that costs.
 *
 * A join is not a thing: it is the instant one shift ends and the next begins,
 * so moving it is one patch to each of them. Its travel is bounded by the two
 * joins either side — the start of the shift before it and the end of the
 * shift after it — and **reaching one of those bounds merges**. That is the
 * honest reading of the gesture rather than a special case: an edge pushed all
 * the way to the next boundary leaves a shift with no minutes in it, and a
 * zero-length shift is refused by `shifts_period_sane` anyway, so the row goes
 * and the coordinator is left with the one long shift they drew.
 */
export interface SettledCut {
  readonly ms: number;
  /** Which neighbour this move swallows: the shift before the join, the one
   * after it, or neither. */
  readonly merges: 'before' | 'after' | null;
}

export function settledCut(
  subject: Run,
  cutIndex: number,
  toMs: number,
): SettledCut | null {
  const before = subject.shifts[cutIndex];
  const after = subject.shifts[cutIndex + 1];
  if (before === undefined || after === undefined) {
    return null;
  }

  // `Math.max` rather than `after.endMs`: the schema has no exclusion
  // constraint on shifts at a location, so two overlapping rows are a shape
  // this board has to draw (`runs.ts`) and therefore a shape this clamp has to
  // survive without running backwards.
  const loMs = before.startMs;
  const hiMs = Math.max(before.endMs, after.endMs);
  const ms = clampMs(toMs, loMs, hiMs);

  return {
    ms,
    merges: ms <= loMs ? 'before' : ms >= hiMs ? 'after' : null,
  };
}

/** The writes that move one join to `toMs`, merging where it lands on a
 * neighbouring one. An unmoved join costs no request at all. */
export function planCutMove(
  subject: Run,
  cutIndex: number,
  toMs: number,
): readonly ShiftOp[] {
  const settled = settledCut(subject, cutIndex, toMs);
  const before = subject.shifts[cutIndex];
  const after = subject.shifts[cutIndex + 1];
  if (settled === null || before === undefined || after === undefined) {
    return [];
  }

  const endMs = Math.max(before.endMs, after.endMs);

  if (settled.merges === 'before') {
    return ordered(
      [deleteOp(subject, before)],
      [patchOp(subject, after, before.startMs, after.endMs)],
      [],
    );
  }
  if (settled.merges === 'after') {
    return ordered(
      [deleteOp(subject, after)],
      [patchOp(subject, before, before.startMs, endMs)],
      [],
    );
  }
  if (settled.ms === before.endMs && settled.ms === after.startMs) {
    return [];
  }
  return ordered(
    [],
    [
      patchOp(subject, before, before.startMs, settled.ms),
      patchOp(subject, after, settled.ms, after.endMs),
    ],
    [],
  );
}

// ---------------------------------------------------------------------------
// Drawing a new series on an empty stretch
// ---------------------------------------------------------------------------

export interface NewRun {
  /** Every bar on the row, so the stretch drawn on cannot land on top of one
   * that is already there. */
  readonly runs: readonly Run[];
  readonly locationId: string;
  /** The day the drag started in. A new series lives inside one event — the
   * shift-inside-event rule is a constraint trigger (docs/02 §5) and a drag
   * that reached across midnight into the next day would be planning a shift
   * against an event that does not cover it. */
  readonly window: Period;
  /** Where the pointer went down: the one end of the gesture that decides
   * *which* empty stretch is being drawn on. */
  readonly anchorMs: number;
  readonly toMs: number;
  readonly stepMinutes: number;
}

/**
 * The stretch a drag across empty lane would fill, or `null` for one that
 * cannot fill anything.
 *
 * Held inside the gap the gesture started in, not merely inside the day: a
 * drag that ran over the bar beside it would write shifts on top of that bar,
 * and two rows claiming one minute at one post is a shape the board can draw
 * but nobody meant. Feeling the neighbour is the same courtesy the edge drag
 * pays (`growthLimit`).
 *
 * `null` when the anchor is inside an existing bar — that gesture is an edge
 * drag on the bar, not a new series — or when what is left is shorter than one
 * step, which would be a click rather than a drag.
 */
export function settledNewRun({
  runs,
  locationId,
  window,
  anchorMs,
  toMs,
  stepMinutes,
}: NewRun): Period | null {
  const siblings = runs.filter((run) => run.locationId === locationId);
  if (
    anchorMs < window.startMs ||
    anchorMs >= window.endMs ||
    siblings.some((run) => anchorMs >= run.startMs && anchorMs < run.endMs)
  ) {
    return null;
  }

  const loMs = siblings
    .filter((run) => run.endMs <= anchorMs)
    .reduce((lo, run) => Math.max(lo, run.endMs), window.startMs);
  const hiMs = siblings
    .filter((run) => run.startMs >= anchorMs)
    .reduce((hi, run) => Math.min(hi, run.startMs), window.endMs);

  const startMs = clampMs(Math.min(anchorMs, toMs), loMs, hiMs);
  const endMs = clampMs(Math.max(anchorMs, toMs), loMs, hiMs);

  return endMs - startMs < stepMinutes * MS_PER_MINUTE
    ? null
    : { startMs, endMs };
}

/**
 * The writes that fill `range` with slots at the mission's own length.
 *
 * One person per slot, unlike a bar grown at its edge: there is no neighbour
 * to inherit a headcount from, and inventing one from another series at the
 * same post would be the board deciding how many people a stretch of the
 * evening needs.
 */
export function planNewRun(
  eventId: string,
  locationId: string,
  range: Period,
  cutMinutes: number,
): readonly ShiftOp[] {
  return tileForward(
    range.startMs,
    range.endMs,
    cutMinutes,
    (startMs, endMs) => ({
      kind: 'create',
      eventId,
      locationId,
      startMs,
      endMs,
      requiredCount: 1,
    }),
  );
}
