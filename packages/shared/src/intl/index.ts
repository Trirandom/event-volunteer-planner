// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * Formatters for the three independent axes of docs/16 §1: language, locale
 * and timezone. The lint in `eslint.config.ts` forbids `Intl.DateTimeFormat`
 * and the `toLocaleString` family everywhere else, so this is the only route
 * to a formatted time — and every signature here makes the event's timezone a
 * required argument.
 *
 * That is the gate. A required parameter cannot be forgotten under deadline;
 * a convention about passing `timeZone` can.
 */

/** An IANA zone name, taken from the *event*, never from the browser. */
export type EventTimeZone = string & { readonly __brand: 'EventTimeZone' };

/**
 * The one place a plain string becomes an `EventTimeZone`.
 *
 * The brand's whole job is to make every formatter signature below require a
 * value that was deliberately declared "this came from the event", so a
 * caller cannot reach for the viewer's own zone by accident — that requires
 * one unavoidable assertion, and this is where it happens instead of at each
 * call site.
 */
export function eventTimeZone(value: string): EventTimeZone {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the nominal brand exists to force this cast through one audited function rather than letting any string stand in for the event's zone (docs/16 §6).
  return value as EventTimeZone;
}

/** A BCP 47 tag, taken from the *viewer*. */
export type ViewerLocale = 'fr' | 'en';

export interface ZonedFormatOptions {
  readonly locale: ViewerLocale;
  readonly timeZone: EventTimeZone;
}

const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(
  locale: ViewerLocale,
  timeZone: EventTimeZone,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${locale}|${timeZone}|${JSON.stringify(options)}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    return hit;
  }
  const made = new Intl.DateTimeFormat(locale, { ...options, timeZone });
  cache.set(key, made);
  return made;
}

/** `14:30` — a clock reading in the event's zone, in the viewer's locale. */
export function formatTime(
  epochMilliseconds: number,
  { locale, timeZone }: ZonedFormatOptions,
): string {
  return formatter(locale, timeZone, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(epochMilliseconds);
}

/** `samedi 4 juillet 2026` / `Saturday 4 July 2026`. */
export function formatDate(
  epochMilliseconds: number,
  { locale, timeZone }: ZonedFormatOptions,
): string {
  return formatter(locale, timeZone, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(epochMilliseconds);
}

/** `samedi 5 septembre` / `Saturday 5 September` — a day of an event whose
 * year the page already states, on a phone where the year costs a line. */
export function formatDay(
  epochMilliseconds: number,
  { locale, timeZone }: ZonedFormatOptions,
): string {
  return formatter(locale, timeZone, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(epochMilliseconds);
}

/** `05.09.26` / `05/09/26` — the board's day band, where a full date would
 * not fit and the year still may not be dropped. */
export function formatDateShort(
  epochMilliseconds: number,
  { locale, timeZone }: ZonedFormatOptions,
): string {
  return formatter(locale, timeZone, {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  }).format(epochMilliseconds);
}

/**
 * The label every time-bearing field must carry, visibly, per docs/16 §5 —
 * "08:00 (heure de La Réunion)". Not a tooltip.
 */
export function timeZoneLabel(
  epochMilliseconds: number,
  { locale, timeZone }: ZonedFormatOptions,
): string {
  const parts = formatter(locale, timeZone, {
    timeZoneName: 'long',
  }).formatToParts(epochMilliseconds);
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? timeZone;
}

/**
 * Name sorting is `Intl.Collator`, never byte order, which puts «Émilie»
 * after «Zoé» (docs/16 §6).
 */
export function nameCollator(locale: ViewerLocale): Intl.Collator {
  return new Intl.Collator(locale, { sensitivity: 'base', numeric: true });
}
