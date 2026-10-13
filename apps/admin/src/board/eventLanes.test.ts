// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { describe, expect, it } from 'vitest';

import { eventLanes } from './eventLanes';
import type { EventWindow } from './runs';

const HOUR = 3_600_000;

function window_(
  id: string,
  startHour: number,
  endHour: number,
  color = 0,
): EventWindow {
  return {
    id,
    name: id,
    timezone: 'Europe/Paris',
    startMs: startHour * HOUR,
    endMs: endHour * HOUR,
    version: 1,
    color,
    publicStartMs: null,
    publicEndMs: null,
  };
}

/** Which row each event landed on, by id — the only thing the view reads. */
function rowsById(windows: readonly EventWindow[]): Record<string, number> {
  const entries = eventLanes(windows).lanes.map(
    (lane): readonly [string, number] => [lane.window.id, lane.row],
  );
  return Object.fromEntries(entries);
}

describe('eventLanes', () => {
  it('has no rows for no events', () => {
    expect(eventLanes([])).toEqual({ lanes: [], rowCount: 0 });
  });

  it('keeps a festival of consecutive days on one row', () => {
    const days = [window_('fri', 10, 26), window_('sat', 34, 50)];

    expect(rowsById(days)).toEqual({ fri: 0, sat: 0 });
    expect(eventLanes(days).rowCount).toBe(1);
  });

  // Half-open, as every period on the wire is: the day that ends at 02:00 and
  // the one that starts at 02:00 are consecutive, not concurrent, and a second
  // row for them would make a plain festival look like two productions.
  it('treats touching events as consecutive, not overlapping', () => {
    const days = [window_('fri', 10, 26), window_('sat', 26, 42)];

    expect(eventLanes(days).rowCount).toBe(1);
  });

  it('puts an overlapping event on its own row', () => {
    const days = [window_('main', 10, 26), window_('after', 22, 30)];

    expect(rowsById(days)).toEqual({ main: 0, after: 1 });
    expect(eventLanes(days).rowCount).toBe(2);
  });

  it('needs as many rows as the deepest overlap', () => {
    const days = [
      window_('a', 0, 12),
      window_('b', 2, 14),
      window_('c', 4, 16),
      window_('d', 20, 24),
    ];

    expect(rowsById(days)).toEqual({ a: 0, b: 1, c: 2, d: 0 });
    expect(eventLanes(days).rowCount).toBe(3);
  });

  /** The row freed first is the row reused, so a short event tucked under a
   * long one does not push everything after it down a row. */
  it('reuses the earliest row that has come free', () => {
    const days = [
      window_('long', 0, 40),
      window_('short', 2, 6),
      window_('later', 8, 12),
    ];

    expect(rowsById(days)).toEqual({ long: 0, short: 1, later: 1 });
    expect(eventLanes(days).rowCount).toBe(2);
  });

  // The board fetches days per query and narrows them in the client, so the
  // array's order is not something the view can promise. The strip must not
  // reshuffle because an unrelated day arrived first.
  it('does not depend on the order the events arrive in', () => {
    const days = [
      window_('a', 0, 12),
      window_('b', 2, 14),
      window_('c', 4, 16),
    ];

    expect(rowsById([...days].reverse())).toEqual(rowsById(days));
  });

  it('orders same-start events by end, then by id', () => {
    const days = [window_('z', 0, 8), window_('a', 0, 12), window_('m', 0, 8)];

    expect(eventLanes(days).lanes.map((lane) => lane.window.id)).toEqual([
      'm',
      'z',
      'a',
    ]);
  });

  it('carries the event through, so the strip can colour and name it', () => {
    const lane = eventLanes([window_('fri', 10, 26, 7)]).lanes[0];

    expect(lane?.window.color).toBe(7);
    expect(lane?.window.name).toBe('fri');
  });
});
