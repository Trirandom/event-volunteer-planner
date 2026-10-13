// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The events themselves, drawn as coloured lines under the ruler.
 *
 * The board's axis is one continuous line across the whole festival
 * (`PlanShiftsView.vue`), which is what lets a club night running 22:00–05:00
 * read as one stretch of work. The cost is that nothing on the ruler says
 * *which day* a bar belongs to: the date bands mark civil midnights, and a
 * festival's days are not civil days — Friday's load-in starts at 08:00 and
 * Saturday's club night ends at 05:00 on what the calendar calls Sunday.
 *
 * So each event gets a line in its own palette colour, and every shift chip
 * below is drawn in that same colour. The pairing is the whole point: the
 * question "is this 03:00 bar shift Saturday's or Sunday's?" becomes a colour
 * match instead of a date sum.
 *
 * **Overlapping events need their own row.** Two events of one festival may
 * genuinely run at once — a main stage and an afterparty, or a load-out that
 * laps the next day's load-in — and laying them on one line would draw one on
 * top of the other, which is the one reading the strip exists to prevent.
 * That stacking is `lanes.ts` and is shared with the mission rows below,
 * which have the same problem for the same reason: the strip and the chips
 * disagreeing about which things overlap is exactly the confusion the two
 * being one colour was introduced to end.
 *
 * Pure, and over `EventWindow` rather than over the API rows, for the same
 * reason `runs.ts` is: the packing is the part worth proving without a server.
 */
import { packLanes } from './lanes';
import type { EventWindow } from './runs';

export interface EventLane {
  readonly window: EventWindow;
  /** 0-based row in the strip. Overlapping events never share one. */
  readonly row: number;
}

export interface EventLanes {
  readonly lanes: readonly EventLane[];
  /** How many rows the strip needs — what the axis is made taller by. */
  readonly rowCount: number;
}

/**
 * Lay every event out, splitting onto extra rows only where they overlap.
 *
 * Ties are broken on end then on id so that two events starting at the same
 * instant are ordered by something the server also agrees on. Without it the
 * strip would depend on the order the days happened to be fetched in — which
 * is why the id, and not the name, is what `packLanes` is handed as the key.
 */
export function eventLanes(windows: readonly EventWindow[]): EventLanes {
  const packed = packLanes(windows, (window) => ({
    startMs: window.startMs,
    endMs: window.endMs,
    key: window.id,
  }));

  return {
    lanes: packed.lanes.map((lane) => ({ window: lane.item, row: lane.row })),
    rowCount: packed.rowCount,
  };
}
