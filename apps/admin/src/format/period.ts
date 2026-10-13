// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * Rendering a stored period in the event's own timezone (docs/16 §1,
 * ADR-0019), and the reverse: turning what a coordinator typed into the local
 * wall-clock, into the UTC instant the API expects.
 *
 * The API sends two UTC instants. A club night deliberately runs past
 * midnight — 22:00 to 05:00 the next day, in the event's zone — so the start
 * and end are formatted as two independent zoned readings, each carrying its
 * own date, rather than one "date at time–time" string. Collapsing them onto
 * a single calendar date is exactly the bug this module exists not to have.
 */
import {
  eventTimeZone,
  formatDate,
  formatTime,
  timeZoneLabel,
  type ViewerLocale,
} from '@evp/shared/intl';
import { Temporal } from '@evp/shared/time';

import { t } from '../i18n';

export interface StoredPeriod {
  readonly start: string;
  readonly end: string;
}

export interface PeriodDisplay {
  readonly startDate: string;
  readonly startTime: string;
  readonly endDate: string;
  readonly endTime: string;
  /**
   * Whether the end falls on a different calendar day, in the event's own
   * zone, from the start — the club-night case, and the one a view must
   * check before rendering only one date for the whole period.
   */
  readonly spansMultipleDays: boolean;
  readonly timeZoneLabel: string;
}

/** `timezone` is the event's own IANA name, exactly as `docs/16 §2` stores
 * it — never the browser's. */
export function formatPeriod(
  period: StoredPeriod,
  timezone: string,
  locale: ViewerLocale,
): PeriodDisplay {
  const zone = eventTimeZone(timezone);
  const start = Temporal.Instant.from(period.start);
  const end = Temporal.Instant.from(period.end);
  const options = { locale, timeZone: zone };

  const startDate = formatDate(start.epochMilliseconds, options);
  const endDate = formatDate(end.epochMilliseconds, options);

  return {
    startDate,
    startTime: formatTime(start.epochMilliseconds, options),
    endDate,
    endTime: formatTime(end.epochMilliseconds, options),
    spansMultipleDays: startDate !== endDate,
    timeZoneLabel: timeZoneLabel(start.epochMilliseconds, options),
  };
}

/**
 * A period as one line: start, end and zone.
 *
 * One message per shape rather than the pieces glued in a template, so a
 * language that orders them differently can. The end date is only named when
 * it differs from the start's — which is the club-night case the module
 * comment is about, and exactly when leaving it out would be a lie.
 */
export function periodText(display: PeriodDisplay): string {
  const values = {
    startDate: display.startDate,
    startTime: display.startTime,
    endTime: display.endTime,
    timeZone: display.timeZoneLabel,
  };
  return display.spansMultipleDays
    ? t('plan.period.acrossDays', { ...values, endDate: display.endDate })
    : t('plan.period.sameDay', values);
}

/** A period by its dates alone, for a festival: its span is days, and the
 * hours belong to each day. */
export function periodDatesText(display: PeriodDisplay): string {
  return t('plan.period.dates', {
    startDate: display.startDate,
    endDate: display.endDate,
  });
}

/**
 * The other direction: an `<input type="datetime-local">` value (a wall-clock
 * reading with no offset) plus the timezone the coordinator picked for the
 * festival or event, turned into the UTC instant the API contract requires.
 *
 * Wall-clock in, instant out — never the other way — is the same rule
 * `docs/16 §3` states for event duplication, applied here to creation.
 */
export function instantFromLocal(
  dateTimeLocal: string,
  timezone: string,
): string {
  const zone = eventTimeZone(timezone);
  return Temporal.PlainDateTime.from(dateTimeLocal)
    .toZonedDateTime(zone)
    .toInstant()
    .toString();
}

/**
 * An instant, as the `<input type="datetime-local">` value that would produce
 * it again in the event's own zone.
 *
 * The round trip with `instantFromLocal` is the whole point: an editing form
 * reads a stored instant into a field, the coordinator changes one digit or
 * none, and what comes back must be the same instant unless they actually
 * moved it. Going through `toZonedDateTime` rather than slicing an ISO string
 * is what makes that hold across the two Sundays a year when a wall-clock
 * reading is ambiguous or absent.
 *
 * Minute precision, no seconds: the field renders a seconds box if it is
 * given one, and no event boundary in this product is specified to the second.
 */
export function localFromInstant(instant: string, timezone: string): string {
  return Temporal.Instant.from(instant)
    .toZonedDateTimeISO(eventTimeZone(timezone))
    .toPlainDateTime()
    .toString({ smallestUnit: 'minute' });
}
