// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * Ranges as text, twice: once to read on screen, once to hear.
 *
 * The visual form marks a range that runs past midnight with «(+1)», which is
 * how a festival night is written on every running order; a screen reader
 * reading "plus one" would be noise, so the spoken form says the day
 * instead (docs/09 §3: the selection is announced as text, not a graphic).
 */
import { eventTimeZone, formatDay, formatTime } from '@evp/shared/intl';

import { t } from '../i18n';
import type { Chip, DayAnswer, DayRow, Range } from './model';
import { normalize } from './model';

export interface Zoned {
  readonly locale: 'fr' | 'en';
  readonly timeZone: string;
}

function opts({ locale, timeZone }: Zoned) {
  return { locale, timeZone: eventTimeZone(timeZone) };
}

export function dayLabel(row: DayRow, zone: Zoned): string {
  return formatDay(row.start, opts(zone));
}

function crossesInto(row: DayRow, epoch: number, zone: Zoned): boolean {
  // Midnight exactly is the end of this day, not the start of the next.
  return formatDay(epoch - 1, opts(zone)) !== formatDay(row.start, opts(zone));
}

/** Both ends as clock readings, the one past midnight marked «(+1)». */
export function rangeEnds(
  range: Range,
  row: DayRow,
  zone: Zoned,
): { start: string; end: string } {
  const mark = ` ${t('availability.nextDay')}`;
  const start = formatTime(range.start, opts(zone));
  const end = formatTime(range.end, opts(zone));
  // Marked once: a range that already starts the next day ends on it too.
  const startNext = crossesInto(row, range.start + 1, zone);
  const endNext = !startNext && crossesInto(row, range.end, zone);
  return {
    start: startNext ? `${start}${mark}` : start,
    end: endNext ? `${end}${mark}` : end,
  };
}

export function rangeText(range: Range, row: DayRow, zone: Zoned): string {
  return t('availability.hours', rangeEnds(range, row, zone));
}

export function rangeSpoken(range: Range, row: DayRow, zone: Zoned): string {
  const next = ` ${t('availability.nextDaySpoken')}`;
  const start = formatTime(range.start, opts(zone));
  const end = formatTime(range.end, opts(zone));
  return t('availability.rangeSpoken', {
    start: crossesInto(row, range.start + 1, zone) ? `${start}${next}` : start,
    end: crossesInto(row, range.end, zone) ? `${end}${next}` : end,
  });
}

export function chipName(chip: Chip, locale: 'fr' | 'en'): string {
  if (chip.label.kind === 'part') {
    return t(`availability.part.${chip.label.part}`);
  }
  const { fr, en } = chip.label.label;
  return locale === 'en' && en != null && en.trim() !== '' ? en : fr;
}

/** What a screen reader hears for the row, whatever was last tapped. */
export function statusSpoken(
  row: DayRow,
  answer: DayAnswer,
  zone: Zoned,
  dayName: string,
): string {
  const day = dayName;
  switch (answer.status) {
    case 'unset':
      return t('availability.status.unset', { day });
    case 'all':
      return t('availability.status.all', { day });
    case 'no':
      return t('availability.status.no', { day });
    case 'partial': {
      const ranges = normalize(answer.ranges);
      if (ranges.length === 0) {
        return t('availability.status.partialEmpty', { day });
      }
      return t('availability.status.partial', {
        day,
        ranges: ranges.map((r) => rangeSpoken(r, row, zone)).join(', '),
      });
    }
  }
}
