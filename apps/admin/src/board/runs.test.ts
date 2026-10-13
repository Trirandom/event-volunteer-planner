// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { Temporal } from '@evp/shared/time';
import { describe, expect, it } from 'vitest';

import { missionRows, type EventWindow } from './runs';
import type { MissionBoard, MissionShift } from '../plan/missions';

const HOUR = 3_600_000;

/** Friday 5 Sept 2026, 10:00 → 6 Sept 02:00 in the event's zone; expressed in
 * UTC here because that is what the wire carries. */
const FRI_OPEN = Temporal.Instant.from(
  '2026-09-05T08:00:00Z',
).epochMilliseconds;
const FRI_CLOSE = FRI_OPEN + 16 * HOUR;
const SAT_OPEN = Temporal.Instant.from(
  '2026-09-06T04:00:00Z',
).epochMilliseconds;
const SAT_CLOSE = SAT_OPEN + 16 * HOUR;

const FRIDAY: EventWindow = {
  id: 'fri',
  name: 'Friday',
  timezone: 'Europe/Paris',
  startMs: FRI_OPEN,
  endMs: FRI_CLOSE,
  version: 3,
  color: 0,
  publicStartMs: null,
  publicEndMs: null,
};

const SATURDAY: EventWindow = {
  id: 'sat',
  name: 'Saturday',
  timezone: 'Europe/Paris',
  startMs: SAT_OPEN,
  endMs: SAT_CLOSE,
  version: 5,
  color: 1,
  publicStartMs: null,
  publicEndMs: null,
};

function shift(
  id: string,
  eventId: string,
  startMs: number,
  endMs: number,
): MissionShift {
  return {
    id,
    version: 1,
    eventId,
    eventName: eventId,
    locationId: `${eventId}-bar`,
    timezone: 'Europe/Paris',
    title: 'Bar',
    period: {
      start: Temporal.Instant.fromEpochMilliseconds(startMs).toString(),
      end: Temporal.Instant.fromEpochMilliseconds(endMs).toString(),
    },
    requiredCount: 2,
    maxCount: null,
  };
}

function board(
  occurrences: readonly {
    eventId: string;
    locationId: string;
    shifts: readonly MissionShift[];
  }[],
  alsoAtDays = 0,
): MissionBoard {
  return {
    missions: [
      {
        key: 'bar',
        name: 'Bar',
        occurrences: occurrences.map((occurrence) => ({
          eventId: occurrence.eventId,
          eventName: occurrence.eventId,
          locationId: occurrence.locationId,
          zoneName: null,
          shifts: occurrence.shifts,
          requiredTotal: 0,
        })),
        shiftCount: 0,
        requiredTotal: 0,
        alsoAtDays,
      },
    ],
    unplacedShifts: [],
  };
}

describe('missionRows', () => {
  it('joins shifts that touch into one bar', () => {
    const rows = missionRows(
      board([
        {
          eventId: 'fri',
          locationId: 'fri-bar',
          shifts: [
            shift('a', 'fri', FRI_OPEN, FRI_OPEN + 2 * HOUR),
            shift('b', 'fri', FRI_OPEN + 2 * HOUR, FRI_OPEN + 4 * HOUR),
          ],
        },
      ]),
      [FRIDAY],
    );

    expect(rows[0]?.runs).toHaveLength(1);
    expect(rows[0]?.runs[0]?.startMs).toBe(FRI_OPEN);
    expect(rows[0]?.runs[0]?.endMs).toBe(FRI_OPEN + 4 * HOUR);
  });

  /** The green ticks in the design: a boundary *between* two shifts. The
   * bar's own two ends are drag handles, not cuts, and counting them as cuts
   * would offer to merge a bar with the gap beside it. */
  it('reports interior boundaries as cuts, and never the bar ends', () => {
    const rows = missionRows(
      board([
        {
          eventId: 'fri',
          locationId: 'fri-bar',
          shifts: [
            shift('a', 'fri', FRI_OPEN, FRI_OPEN + 2 * HOUR),
            shift('b', 'fri', FRI_OPEN + 2 * HOUR, FRI_OPEN + 4 * HOUR),
            shift('c', 'fri', FRI_OPEN + 4 * HOUR, FRI_OPEN + 6 * HOUR),
          ],
        },
      ]),
      [FRIDAY],
    );

    expect(rows[0]?.runs[0]?.cutsMs).toEqual([
      FRI_OPEN + 2 * HOUR,
      FRI_OPEN + 4 * HOUR,
    ]);
  });

  it('breaks a bar where there is a gap', () => {
    const rows = missionRows(
      board([
        {
          eventId: 'fri',
          locationId: 'fri-bar',
          shifts: [
            shift('a', 'fri', FRI_OPEN, FRI_OPEN + 2 * HOUR),
            shift('b', 'fri', FRI_OPEN + 5 * HOUR, FRI_OPEN + 7 * HOUR),
          ],
        },
      ]),
      [FRIDAY],
    );

    const runs = rows[0]?.runs ?? [];
    expect(runs).toHaveLength(2);
    expect(runs[0]?.endMs).toBe(FRI_OPEN + 2 * HOUR);
    expect(runs[1]?.startMs).toBe(FRI_OPEN + 5 * HOUR);
  });

  it('sorts shifts before folding them, whatever order they arrived in', () => {
    const rows = missionRows(
      board([
        {
          eventId: 'fri',
          locationId: 'fri-bar',
          shifts: [
            shift('b', 'fri', FRI_OPEN + 2 * HOUR, FRI_OPEN + 4 * HOUR),
            shift('a', 'fri', FRI_OPEN, FRI_OPEN + 2 * HOUR),
          ],
        },
      ]),
      [FRIDAY],
    );

    expect(rows[0]?.runs).toHaveLength(1);
    expect(rows[0]?.runs[0]?.shifts.map((entry) => entry.id)).toEqual([
      'a',
      'b',
    ]);
  });

  /** The schema permits overlapping shifts at one location and has no
   * exclusion constraint against them, so the board has to draw one. Two
   * overlapping shifts are one bar that reaches the later end. */
  it('folds overlapping shifts into one bar reaching the later end', () => {
    const rows = missionRows(
      board([
        {
          eventId: 'fri',
          locationId: 'fri-bar',
          shifts: [
            shift('a', 'fri', FRI_OPEN, FRI_OPEN + 4 * HOUR),
            shift('b', 'fri', FRI_OPEN + 2 * HOUR, FRI_OPEN + 3 * HOUR),
          ],
        },
      ]),
      [FRIDAY],
    );

    const run = rows[0]?.runs[0];
    expect(run?.startMs).toBe(FRI_OPEN);
    expect(run?.endMs).toBe(FRI_OPEN + 4 * HOUR);
  });

  describe('a mission nobody has cut yet', () => {
    it('is proposed across its whole event, and stores nothing', () => {
      const rows = missionRows(
        board([{ eventId: 'fri', locationId: 'fri-bar', shifts: [] }]),
        [FRIDAY],
      );

      const run = rows[0]?.runs[0];
      expect(run?.proposed).toBe(true);
      expect(run?.startMs).toBe(FRI_OPEN);
      expect(run?.endMs).toBe(FRI_CLOSE);
      expect(run?.shifts).toEqual([]);
      expect(run?.cutsMs).toEqual([]);
    });

    it('is proposed per day, not once across the festival', () => {
      const rows = missionRows(
        board([
          { eventId: 'fri', locationId: 'fri-bar', shifts: [] },
          { eventId: 'sat', locationId: 'sat-bar', shifts: [] },
        ]),
        [FRIDAY, SATURDAY],
      );

      expect(rows[0]?.runs).toHaveLength(2);
      expect(rows[0]?.runs.every((run) => run.proposed)).toBe(true);
      expect(rows[0]?.runs[1]?.startMs).toBe(SAT_OPEN);
    });

    it('is not proposed once a single shift exists', () => {
      const rows = missionRows(
        board([
          {
            eventId: 'fri',
            locationId: 'fri-bar',
            shifts: [shift('a', 'fri', FRI_OPEN, FRI_OPEN + 2 * HOUR)],
          },
        ]),
        [FRIDAY],
      );

      expect(rows[0]?.runs.map((run) => run.proposed)).toEqual([false]);
    });
  });

  describe('the bounds a drag is clamped to', () => {
    /**
     * "A shift cannot fall outside its event" is a hard rule enforced by a
     * constraint trigger (docs/02 §5). Each bar therefore carries *its own*
     * event's window, not the festival's — on a continuous festival axis two
     * bars of one mission sit on the same line and stop at different edges.
     */
    it('is the run own event, never the festival around it', () => {
      const rows = missionRows(
        board([
          {
            eventId: 'fri',
            locationId: 'fri-bar',
            shifts: [shift('a', 'fri', FRI_OPEN, FRI_OPEN + 2 * HOUR)],
          },
          {
            eventId: 'sat',
            locationId: 'sat-bar',
            shifts: [shift('b', 'sat', SAT_OPEN, SAT_OPEN + 2 * HOUR)],
          },
        ]),
        [FRIDAY, SATURDAY],
      );

      const runs = rows[0]?.runs ?? [];
      expect(runs[0]?.boundsStartMs).toBe(FRI_OPEN);
      expect(runs[0]?.boundsEndMs).toBe(FRI_CLOSE);
      expect(runs[1]?.boundsStartMs).toBe(SAT_OPEN);
      expect(runs[1]?.boundsEndMs).toBe(SAT_CLOSE);
    });
  });

  it('orders a row by time, so a festival row reads left to right', () => {
    const rows = missionRows(
      board([
        {
          eventId: 'sat',
          locationId: 'sat-bar',
          shifts: [shift('b', 'sat', SAT_OPEN, SAT_OPEN + 2 * HOUR)],
        },
        {
          eventId: 'fri',
          locationId: 'fri-bar',
          shifts: [shift('a', 'fri', FRI_OPEN, FRI_OPEN + 2 * HOUR)],
        },
      ]),
      [FRIDAY, SATURDAY],
    );

    expect(rows[0]?.runs.map((run) => run.eventId)).toEqual(['fri', 'sat']);
  });

  /** A day whose event failed to load has no window to clamp against, and a
   * guessed one would be a guess about a hard constraint. */
  it('drops an occurrence whose event is not among the windows', () => {
    const rows = missionRows(
      board([{ eventId: 'ghost', locationId: 'ghost-bar', shifts: [] }]),
      [FRIDAY],
    );

    expect(rows[0]?.runs).toEqual([]);
  });
});

describe('what a narrowed row still says', () => {
  /** The one fact a day-at-a-time board cannot show for itself. */
  it('carries the other days that run the mission', () => {
    const rows = missionRows(
      board([{ eventId: 'fri', locationId: 'fri-bar', shifts: [] }], 4),
      [FRIDAY],
    );

    expect(rows[0]?.alsoAtDays).toBe(4);
  });
});
