// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { Temporal } from '@evp/shared/time';
import { describe, expect, it } from 'vitest';

import { packLanes, runLanes } from './lanes';
import type { BarShift, Run } from './runs';

const HOUR = 60 * 60_000;
const OPEN = Temporal.Instant.from('2026-09-05T08:00:00Z').epochMilliseconds;

function barShift(id: string, startMs: number, endMs: number): BarShift {
  return {
    id,
    version: 1,
    startMs,
    endMs,
    title: 'Bar',
    requiredCount: 1,
    maxCount: null,
  };
}

/** A bar at `locationId`, running `fromHour`–`toHour` of the festival. */
function bar(
  key: string,
  eventId: string,
  fromHour: number,
  toHour: number,
): Run {
  const startMs = OPEN + fromHour * HOUR;
  const endMs = OPEN + toHour * HOUR;
  return {
    key,
    eventId,
    eventName: eventId,
    locationId: key.split(':')[0] ?? key,
    timezone: 'Europe/Paris',
    boundsStartMs: startMs,
    boundsEndMs: endMs,
    eventVersion: 1,
    color: 0,
    publicStartMs: null,
    publicEndMs: null,
    startMs,
    endMs,
    shifts: [barShift(key, startMs, endMs)],
    cutsMs: [],
    proposed: false,
  };
}

describe('packLanes', () => {
  interface Block {
    readonly id: string;
    readonly startMs: number;
    readonly endMs: number;
  }

  function block(id: string, fromHour: number, toHour: number): Block {
    return {
      id,
      startMs: OPEN + fromHour * HOUR,
      endMs: OPEN + toHour * HOUR,
    };
  }

  function rows(blocks: readonly Block[]): Record<string, number> {
    return Object.fromEntries(
      packLanes(blocks, (item) => ({
        startMs: item.startMs,
        endMs: item.endMs,
        key: item.id,
      })).lanes.map((lane) => [lane.item.id, lane.row]),
    );
  }

  it('keeps everything that never overlaps on one row', () => {
    const packed = packLanes([block('a', 0, 4), block('b', 6, 10)], (item) => ({
      startMs: item.startMs,
      endMs: item.endMs,
      key: item.id,
    }));

    expect(packed.rowCount).toBe(1);
    expect(packed.lanes.map((lane) => lane.row)).toEqual([0, 0]);
  });

  /** Periods are half-open (docs/04 §1): one ending exactly as the next
   * begins is consecutive, not concurrent, and spending a row on that would
   * make a plain two-day festival look like two parallel productions. */
  it('shares a row with something that starts exactly where it ends', () => {
    expect(rows([block('a', 0, 4), block('b', 4, 8)])).toEqual({ a: 0, b: 0 });
  });

  it('uses as many rows as the deepest overlap and no more', () => {
    const packed = packLanes(
      [
        block('a', 0, 10),
        block('b', 2, 12),
        block('c', 4, 6),
        block('d', 12, 14),
      ],
      (item) => ({ startMs: item.startMs, endMs: item.endMs, key: item.id }),
    );

    expect(packed.rowCount).toBe(3);
    expect(
      Object.fromEntries(packed.lanes.map((lane) => [lane.item.id, lane.row])),
    ).toEqual({ a: 0, b: 1, c: 2, d: 0 });
  });

  /** The board fetches its days per query and narrows them in the client, so
   * the order the items arrive in is not something the view can promise. */
  it('does not depend on the order the items arrive in', () => {
    const blocks = [block('a', 0, 12), block('b', 2, 14), block('c', 4, 16)];

    expect(rows([...blocks].reverse())).toEqual(rows(blocks));
  });

  it('breaks a tie on end, then on the key', () => {
    const packed = packLanes(
      [block('z', 0, 8), block('a', 0, 12), block('m', 0, 8)],
      (item) => ({ startMs: item.startMs, endMs: item.endMs, key: item.id }),
    );

    expect(packed.lanes.map((lane) => lane.item.id)).toEqual(['m', 'z', 'a']);
  });
});

/**
 * One mission is one line, and on the festival-wide axis that line carries
 * every day at once. Two bars on the same pixels would draw one over the
 * other, which on a board whose whole job is showing where the hole is, is the
 * worst thing it can do.
 */
describe('runLanes', () => {
  it('keeps a mission worked on consecutive days on one row', () => {
    const packed = runLanes([
      bar('bar:0', 'fri', 0, 8),
      bar('bar:1', 'sat', 24, 32),
    ]);

    expect(packed.rowCount).toBe(1);
    expect(packed.lanes.map((lane) => lane.row)).toEqual([0, 0]);
  });

  it('stacks the bars of two days that genuinely run at once', () => {
    // The club night's bar, and the after that laps its last two hours.
    const packed = runLanes([
      bar('club-bar:0', 'club', 14, 22),
      bar('after-bar:0', 'after', 20, 28),
    ]);

    expect(packed.rowCount).toBe(2);
    expect(
      Object.fromEntries(packed.lanes.map((lane) => [lane.item.key, lane.row])),
    ).toEqual({ 'club-bar:0': 0, 'after-bar:0': 1 });
  });

  /** Two bars at one post can never overlap — `runs.ts` folds shifts that
   * touch into one bar — so a post's own series always share a row, however
   * many of them a split has left behind. */
  it('keeps two series at the same post on one row', () => {
    const packed = runLanes([
      bar('bar:0', 'fri', 0, 4),
      bar('bar:1', 'fri', 6, 10),
    ]);

    expect(packed.rowCount).toBe(1);
  });

  it('has no rows at all for a mission with no bars', () => {
    expect(runLanes([])).toEqual({ lanes: [], rowCount: 0 });
  });
});
