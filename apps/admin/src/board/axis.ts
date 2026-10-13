// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The board's horizontal ruler: day bands and clock ticks.
 *
 * Both are computed in the **event's** IANA zone, never the browser's
 * (docs/16 §1). On the festival-wide axis that zone is the festival's own,
 * because one continuous line can only carry one clock; each bar still names
 * the zone it is actually worked in, which is the reading that matters for a
 * festival spanning two of them.
 *
 * Ticks are re-anchored on every civil midnight rather than walked as one
 * exact-duration sequence from the left edge. That is the DST decision, and
 * it is the same one ADR-0019 makes for generation: a 23-hour day gets 23
 * hourly ticks and no 02:00, because 02:00 is a clock reading that does not
 * happen and a shift cannot start at it. Walking exact hours instead would
 * keep the count and slide every label off the hour for the rest of the
 * festival.
 */
import { formatDateShort, formatTime, eventTimeZone } from '@evp/shared/intl';
import type { ViewerLocale } from '@evp/shared/intl';
import { Temporal } from '@evp/shared/time';

export interface AxisDay {
  readonly startMs: number;
  readonly endMs: number;
  readonly label: string;
}

export interface AxisTick {
  readonly atMs: number;
  readonly label: string;
}

function startOfDayAt(ms: number, timezone: string): Temporal.ZonedDateTime {
  return Temporal.Instant.fromEpochMilliseconds(ms)
    .toZonedDateTimeISO(eventTimeZone(timezone))
    .startOfDay();
}

/**
 * The axis, cut into the calendar days it crosses, clipped to the window.
 *
 * `startOfDay` rather than `with({ hour: 0 })`: in a zone where the clocks go
 * forward at midnight there is no 00:00, and Temporal's `startOfDay` answers
 * with the first instant that does exist instead of one that does not.
 */
export function axisDays(
  startMs: number,
  endMs: number,
  timezone: string,
  locale: ViewerLocale,
): readonly AxisDay[] {
  const zone = eventTimeZone(timezone);
  const days: AxisDay[] = [];

  let cursor = startOfDayAt(startMs, timezone);
  while (cursor.epochMilliseconds < endMs) {
    const next = cursor.add({ days: 1 }).startOfDay();
    days.push({
      startMs: Math.max(cursor.epochMilliseconds, startMs),
      endMs: Math.min(next.epochMilliseconds, endMs),
      label: formatDateShort(cursor.epochMilliseconds, {
        locale,
        timeZone: zone,
      }),
    });
    cursor = next;
  }

  return days;
}

/**
 * Clock ticks every `everyMinutes`, laid from each civil midnight.
 *
 * The left edge of the axis is rarely a midnight, so the walk starts before
 * the window and the ticks that fall outside it are dropped rather than
 * clamped onto its edge — a tick is a clock reading at a position, and one
 * pushed sideways to fit would be a lie about both.
 */
export function axisTicks(
  startMs: number,
  endMs: number,
  timezone: string,
  locale: ViewerLocale,
  everyMinutes: number,
): readonly AxisTick[] {
  if (!(everyMinutes > 0)) {
    throw new RangeError(
      'a tick interval must be a positive number of minutes',
    );
  }

  const zone = eventTimeZone(timezone);
  const ticks: AxisTick[] = [];

  let dayStart = startOfDayAt(startMs, timezone);
  while (dayStart.epochMilliseconds < endMs) {
    const nextDay = dayStart.add({ days: 1 }).startOfDay();

    let at = dayStart;
    while (
      at.epochMilliseconds < nextDay.epochMilliseconds &&
      at.epochMilliseconds < endMs
    ) {
      if (at.epochMilliseconds >= startMs) {
        ticks.push({
          atMs: at.epochMilliseconds,
          label: formatTime(at.epochMilliseconds, { locale, timeZone: zone }),
        });
      }
      at = at.add({ minutes: everyMinutes });
    }

    dayStart = nextDay;
  }

  return ticks;
}
