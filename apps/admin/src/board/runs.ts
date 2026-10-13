// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * Shifts, folded into the bars the board actually draws.
 *
 * A **run** is a maximal contiguous stretch of a mission's shifts at one
 * location: the black bar in the design. Its interior boundaries are the
 * **cuts** — the green ticks — and they are the joins between adjacent
 * shifts, nothing more. There is no "mission window" row behind them and
 * deliberately so: ADR-0029 rejected any layer that keeps shifts aligned to
 * something, so a bar is a *reading* of the shift rows and never a second
 * record of them. Drag an edge and shifts are created, patched or deleted;
 * nothing else changes, because there is nothing else.
 *
 * Each run carries its own event's window as `bounds*`. On the festival-wide
 * axis one mission's bars come from several events sitting on one line, and
 * "a shift cannot fall outside its event" is a hard rule enforced by a
 * constraint trigger (docs/02 §5) — so the clamp is per bar, not per row.
 *
 * Pure. `api/usePlan.ts` feeds it; `edit.ts` decides what a drag means.
 */
import { Temporal } from '@evp/shared/time';

import type { MissionBoard, MissionShift } from '../plan/missions';

/** An event, reduced to what layout and editing need. */
export interface EventWindow {
  readonly id: string;
  readonly name: string;
  /** The event's own IANA zone — the one its shifts are worked in. */
  readonly timezone: string;
  /** The operational window: where shifts may live, and what a bar dragged
   * past the end of the day widens. */
  readonly startMs: number;
  readonly endMs: number;
  /**
   * The event's `version`, carried because the board can now write to the
   * event itself: widening a day sends `If-Match`, the same as every other
   * write (docs/02 §7).
   */
  readonly version: number;
  /**
   * Index into the 64-colour event palette (`@evp/shared`'s `eventColor`).
   *
   * Carried here rather than looked up by the view because it is layout, not
   * decoration: the strip under the ruler and every chip on the board are
   * drawn in it, and "which day is this bar?" is answered by the two matching.
   */
  readonly color: number;
  /** When the doors are open, once that has stopped being the whole window.
   * `null` while the two are still the same thing. */
  readonly publicStartMs: number | null;
  readonly publicEndMs: number | null;
}

export interface BarShift {
  readonly id: string;
  readonly version: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly title: string;
  readonly requiredCount: number;
  readonly maxCount: number | null;
}

export interface Run {
  /**
   * Stable across a re-render so focus survives one.
   *
   * Keyed on the location and the run's position in it rather than on the
   * first shift's id: extending a bar's *start* prepends a new shift, so an
   * id-based key would change under a coordinator mid-drag and take the
   * focused handle with it.
   */
  readonly key: string;
  readonly eventId: string;
  readonly eventName: string;
  readonly locationId: string;
  readonly timezone: string;
  /**
   * The event's period as it stands.
   *
   * No longer a clamp. An edge dragged past it widens the event rather than
   * stopping at it — the bar staff who arrive before the doors open are not a
   * mistake to be refused — so this is where the *day* currently ends, which
   * is what `Home`/`End` run to and what tells a plan whether it has to grow
   * the event before it can add a slot.
   */
  readonly boundsStartMs: number;
  readonly boundsEndMs: number;
  /** The event's `version`, for the `If-Match` on a widening. */
  readonly eventVersion: number;
  /** The event's palette index, so a chip can be drawn in the colour of the
   * line its day has on the strip. */
  readonly color: number;
  /**
   * When the doors are open, once the day has grown around them.
   *
   * `null` while the operational window and the public one are still the same
   * thing. Carried onto the bar rather than looked up by the view because it
   * is what tells a coordinator, at the moment of the drag, whether they are
   * about to *set* the published closing time or merely move work past one
   * that is already recorded.
   */
  readonly publicStartMs: number | null;
  readonly publicEndMs: number | null;
  readonly startMs: number;
  readonly endMs: number;
  readonly shifts: readonly BarShift[];
  /** Interior shift boundaries, in order. Empty for a single-shift bar. */
  readonly cutsMs: readonly number[];
  /**
   * Nothing is stored for this bar yet.
   *
   * A mission with no shifts is drawn across its whole event, dashed, because
   * that is the honest default — the post exists, it is simply not cut up
   * yet. It is a proposal: no row backs it, and the first edit is what writes
   * one.
   */
  readonly proposed: boolean;
}

export interface MissionRow {
  readonly key: string;
  readonly name: string;
  readonly runs: readonly Run[];
  /**
   * Days of the festival that run this mission but are not on the axis.
   *
   * Zero on the festival-wide reading, where every day is in view. Carried
   * through from `plan/missions.ts` rather than dropped, because it is
   * precisely what a day-at-a-time board would otherwise hide: Saturday's bar
   * is not a Saturday decision, and a coordinator about to re-cut it should
   * see that four other days say the same word.
   */
  readonly alsoAtDays: number;
}

/** `Date.parse` is banned (docs/16 §4) and rightly: it accepts things that are
 * not RFC 3339 and answers `NaN` for the rest, which on this board would be a
 * bar positioned at the left edge of the epoch rather than an error. */
function msOf(iso: string): number {
  return Temporal.Instant.from(iso).epochMilliseconds;
}

function barShift(shift: MissionShift): BarShift {
  return {
    id: shift.id,
    version: shift.version,
    startMs: msOf(shift.period.start),
    endMs: msOf(shift.period.end),
    title: shift.title,
    requiredCount: shift.requiredCount,
    maxCount: shift.maxCount,
  };
}

/**
 * Group one location's shifts into contiguous runs.
 *
 * The join test is `start <= end`, not `start === end`: the schema has no
 * exclusion constraint on shifts at a location, so two overlapping shifts are
 * a shape the board must draw rather than one it can rule out. They become
 * one bar reaching the later end, which is what a coordinator sees on the
 * ground.
 */
function groupRuns(shifts: readonly BarShift[]): readonly BarShift[][] {
  const ordered = [...shifts].sort((a, b) => a.startMs - b.startMs);
  const runs: BarShift[][] = [];
  let current: BarShift[] = [];
  let reach = Number.NEGATIVE_INFINITY;

  for (const shift of ordered) {
    if (current.length > 0 && shift.startMs > reach) {
      runs.push(current);
      current = [];
    }
    current.push(shift);
    reach = Math.max(reach, shift.endMs);
  }
  if (current.length > 0) {
    runs.push(current);
  }
  return runs;
}

/** The interior joins — the design's green ticks. The bar's own ends are drag
 * handles, and offering them as cuts would invite merging a bar with the empty
 * space beside it. */
function cutsOf(shifts: readonly BarShift[]): readonly number[] {
  return shifts.slice(1).map((shift) => shift.startMs);
}

function reachOf(shifts: readonly BarShift[]): number {
  return shifts.reduce(
    (latest, shift) => Math.max(latest, shift.endMs),
    Number.NEGATIVE_INFINITY,
  );
}

/**
 * Every mission as a row of bars, laid on one shared axis.
 *
 * An occurrence whose event is not in `windows` is dropped rather than drawn
 * against a guessed window: the window is what a drag is clamped to, and
 * guessing it would be guessing about a hard constraint.
 */
export function missionRows(
  board: MissionBoard,
  windows: readonly EventWindow[],
): readonly MissionRow[] {
  const byEvent = new Map(windows.map((window) => [window.id, window]));

  return board.missions.map((mission): MissionRow => {
    const runs: Run[] = [];

    for (const occurrence of mission.occurrences) {
      const window = byEvent.get(occurrence.eventId);
      if (window === undefined) {
        continue;
      }

      const shifts = occurrence.shifts.map(barShift);
      const groups = groupRuns(shifts);

      if (groups.length === 0) {
        runs.push({
          key: `${occurrence.locationId}:0`,
          eventId: window.id,
          eventName: window.name,
          locationId: occurrence.locationId,
          timezone: window.timezone,
          boundsStartMs: window.startMs,
          boundsEndMs: window.endMs,
          eventVersion: window.version,
          color: window.color,
          publicStartMs: window.publicStartMs,
          publicEndMs: window.publicEndMs,
          startMs: window.startMs,
          endMs: window.endMs,
          shifts: [],
          cutsMs: [],
          proposed: true,
        });
        continue;
      }

      groups.forEach((group, index) => {
        runs.push({
          key: `${occurrence.locationId}:${String(index)}`,
          eventId: window.id,
          eventName: window.name,
          locationId: occurrence.locationId,
          timezone: window.timezone,
          boundsStartMs: window.startMs,
          boundsEndMs: window.endMs,
          eventVersion: window.version,
          color: window.color,
          publicStartMs: window.publicStartMs,
          publicEndMs: window.publicEndMs,
          startMs: group[0]?.startMs ?? window.startMs,
          endMs: reachOf(group),
          shifts: group,
          cutsMs: cutsOf(group),
          proposed: false,
        });
      });
    }

    // Chronological, not per-occurrence: the row is one timeline, and its bars
    // must read left to right whatever order the days were fetched in.
    runs.sort((a, b) => a.startMs - b.startMs);

    return {
      key: mission.key,
      name: mission.name,
      runs,
      alsoAtDays: mission.alsoAtDays,
    };
  });
}
