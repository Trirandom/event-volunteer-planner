// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The availability question's model (docs/09 §3, ADR-0039).
 *
 * One row per event day, answered «Oui» / «En partie» / «Non». The default
 * path is one tap per row; precision — chips, then a typed range — is only
 * asked of the volunteer who said «En partie». Every answer still becomes
 * exact `availability_windows` bounds, so nothing downstream resolves labels.
 *
 * Ranges are epoch milliseconds, half-open. Arithmetic on instants is what
 * merging and clamping need, and it survives `localStorage` as plain numbers;
 * `Temporal` is used only where a wall-clock reading in the *event's* zone is
 * involved (docs/16 §4).
 */
import { Temporal } from '@evp/shared/time';

import type {
  AvailabilityWindow,
  Localized,
  ScopeEvent,
} from '../api/publicForm';

export interface Range {
  readonly start: number;
  readonly end: number;
}

export interface DayRow {
  /** `${eventId}/${isoDate}` — stable across renders and drafts. */
  readonly key: string;
  readonly eventId: string;
  /** The day the row belongs to, in the event's zone. */
  readonly date: string;
  readonly start: number;
  readonly end: number;
}

export type DayStatus = 'unset' | 'all' | 'partial' | 'no';

export interface DayAnswer {
  readonly status: DayStatus;
  /**
   * Kept while the status is not `partial`, so a volunteer who taps «Oui»
   * and back to «En partie» finds their ranges where they left them. Only the
   * current status is ever submitted.
   */
  readonly ranges: readonly Range[];
}

export const UNSET: DayAnswer = { status: 'unset', ranges: [] };

/** Enough for any real edition, and a bound on a malformed period. */
const MAX_ROWS = 62;

const MINUTE = 60_000;

function zoned(epochMs: number, timeZone: string): Temporal.ZonedDateTime {
  return Temporal.Instant.fromEpochMilliseconds(epochMs).toZonedDateTimeISO(
    timeZone,
  );
}

export function epoch(value: string): number {
  return Temporal.Instant.from(value).epochMilliseconds;
}

/**
 * The event's days. Each row starts at the wall-clock time the event opens
 * and runs to the same time the next day, cut to the period.
 *
 * Anchoring on the opening time rather than on midnight is what makes a
 * festival night one row: Dub & 2step runs 13:00 → 08:00, and a midnight
 * boundary — or a fixed early-morning cutoff — would split it into a day and
 * a stub, asking the volunteer about "Saturday" for the last six hours of
 * Friday's party (docs/09 §3: a day that crosses midnight belongs to the day
 * it starts on).
 */
export function dayRows(event: ScopeEvent): DayRow[] {
  const start = epoch(event.period.start);
  const end = epoch(event.period.end);
  const step = event.availability_step_minutes * MINUTE;
  const first = zoned(start, event.timezone);
  const anchor = first.toPlainTime();
  const rows: DayRow[] = [];
  for (let n = 0; rows.length < MAX_ROWS; n += 1) {
    const date = first.toPlainDate().add({ days: n });
    const rowStart =
      n === 0
        ? start
        : date.toZonedDateTime({ timeZone: event.timezone, plainTime: anchor })
            .epochMilliseconds;
    if (rowStart >= end) {
      break;
    }
    const next = date.add({ days: 1 }).toZonedDateTime({
      timeZone: event.timezone,
      plainTime: anchor,
    }).epochMilliseconds;
    const rowEnd = Math.min(next, end);
    // A period that ends a few minutes after the anchor does not deserve a
    // row of its own: nothing could be declared in it.
    if (rowEnd - rowStart >= step) {
      rows.push({
        key: `${event.id}/${date.toString()}`,
        eventId: event.id,
        date: date.toString(),
        start: rowStart,
        end: rowEnd,
      });
    }
  }
  return rows;
}

// ── Range algebra ──────────────────────────────────────────────────────────

/**
 * Sorted, with overlapping *and touching* ranges merged: 08–12 plus 12–18 is
 * one 08–18 window, because `outside_availability` tests containment and an
 * 11:00–13:00 shift would otherwise fit neither half (docs/09 §3).
 */
export function normalize(ranges: readonly Range[]): Range[] {
  const sorted = ranges
    .filter((r) => r.end > r.start)
    .toSorted((a, b) => a.start - b.start || a.end - b.end);
  const out: Range[] = [];
  for (const range of sorted) {
    const last = out.at(-1);
    if (last !== undefined && range.start <= last.end) {
      out[out.length - 1] = {
        start: last.start,
        end: Math.max(last.end, range.end),
      };
    } else {
      out.push(range);
    }
  }
  return out;
}

export function subtract(ranges: readonly Range[], cut: Range): Range[] {
  const out: Range[] = [];
  for (const range of ranges) {
    if (range.end <= cut.start || range.start >= cut.end) {
      out.push(range);
      continue;
    }
    if (range.start < cut.start) {
      out.push({ start: range.start, end: cut.start });
    }
    if (range.end > cut.end) {
      out.push({ start: cut.end, end: range.end });
    }
  }
  return normalize(out);
}

/** Whether `range` lies entirely inside the union of `ranges`. */
export function covers(ranges: readonly Range[], range: Range): boolean {
  return normalize(ranges).some(
    (r) => r.start <= range.start && r.end >= range.end,
  );
}

export function clamp(range: Range, to: Range): Range | null {
  const start = Math.max(range.start, to.start);
  const end = Math.min(range.end, to.end);
  return end > start ? { start, end } : null;
}

// ── Chips ──────────────────────────────────────────────────────────────────

export type PartOfDay = 'morning' | 'afternoon' | 'evening' | 'night';

export type ChipLabel =
  | { readonly kind: 'part'; readonly part: PartOfDay }
  | { readonly kind: 'custom'; readonly label: Localized };

export interface Chip {
  readonly key: string;
  readonly label: ChipLabel;
  readonly range: Range;
}

/** Where a day's parts begin, in the event's wall clock. */
const PARTS: readonly { readonly part: PartOfDay; readonly hour: number }[] = [
  { part: 'night', hour: 0 },
  { part: 'morning', hour: 6 },
  { part: 'afternoon', hour: 12 },
  { part: 'evening', hour: 18 },
];

const MIN_PIECE = 2 * 60 * MINUTE;
const MIN_ROW_FOR_CHIPS = 4 * 60 * MINUTE;

/**
 * The row's suggested ranges: the coordinator's slot options where there are
 * any (docs/09 §3), otherwise the row cut into morning, afternoon, evening and
 * night. A fallback piece under two hours joins its neighbour — «Soir» on the
 * Open Air runs to 01:00 rather than leaving a one-hour «Nuit» nobody would
 * pick. A row under four hours is answered «Oui»/«Non» or typed; chips would
 * only restate it.
 */
export function chipsFor(event: ScopeEvent, row: DayRow): Chip[] {
  const own = event.slot_options
    .map((option, index): Chip | null => {
      const range = clamp(
        { start: epoch(option.start), end: epoch(option.end) },
        row,
      );
      return range === null
        ? null
        : {
            key: `slot-${String(index)}`,
            label: { kind: 'custom', label: option.label },
            range,
          };
    })
    .filter((chip) => chip !== null);
  if (own.length > 0) {
    return own.toSorted((a, b) => a.range.start - b.range.start);
  }
  if (row.end - row.start < MIN_ROW_FOR_CHIPS) {
    return [];
  }

  const pieces: { part: PartOfDay; start: number; end: number }[] = [];
  let cursor = row.start;
  while (cursor < row.end) {
    const local = zoned(cursor, event.timezone);
    const current = PARTS.findLast((p) => p.hour <= local.hour) ?? PARTS[0];
    const nextPart = PARTS.find((p) => p.hour > local.hour);
    const boundary = (
      nextPart === undefined
        ? local
            .toPlainDate()
            .add({ days: 1 })
            .toZonedDateTime({ timeZone: event.timezone })
        : local.toPlainDate().toZonedDateTime({
            timeZone: event.timezone,
            plainTime: Temporal.PlainTime.from({ hour: nextPart.hour }),
          })
    ).epochMilliseconds;
    const end = Math.min(boundary, row.end);
    if (current !== undefined) {
      pieces.push({ part: current.part, start: cursor, end });
    }
    cursor = end;
  }

  // Fold short pieces into the longer neighbour, first or last one inwards.
  for (let i = 0; i < pieces.length && pieces.length > 1;) {
    const piece = pieces[i];
    if (piece === undefined || piece.end - piece.start >= MIN_PIECE) {
      i += 1;
      continue;
    }
    const before = pieces[i - 1];
    const after = pieces[i + 1];
    if (
      before !== undefined &&
      (after === undefined ||
        before.end - before.start >= after.end - after.start)
    ) {
      before.end = piece.end;
    } else if (after !== undefined) {
      after.start = piece.start;
    }
    pieces.splice(i, 1);
  }

  return pieces.map((piece) => ({
    key: `${piece.part}-${String(piece.start)}`,
    label: { kind: 'part', part: piece.part },
    range: { start: piece.start, end: piece.end },
  }));
}

export function toggleChip(answer: DayAnswer, chip: Chip): DayAnswer {
  return {
    status: 'partial',
    ranges: covers(answer.ranges, chip.range)
      ? subtract(answer.ranges, chip.range)
      : normalize([...answer.ranges, chip.range]),
  };
}

// ── Typed ranges ───────────────────────────────────────────────────────────

export interface Clock {
  readonly hour: number;
  readonly minute: number;
}

/**
 * `14:30`, `14h30`, `14h`, `14`, `14.30`, `1430`, `930` — the second is what
 * French volunteers type (docs/09 §7). `24:00` is accepted and means the
 * following midnight.
 */
export function parseClock(text: string): Clock | null {
  const value = text.trim().toLowerCase().replace(/\s+/gu, '');
  const match =
    /^(\d{1,2})(?:[:h.](\d{2})?)?$/u.exec(value) ??
    /^(\d{1,2})(\d{2})$/u.exec(value);
  if (match === null) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  if (minute > 59 || hour > 24 || (hour === 24 && minute !== 0)) {
    return null;
  }
  return { hour, minute };
}

export type TypedRangeResult =
  | { readonly ok: true; readonly range: Range; readonly adjusted: boolean }
  | { readonly ok: false; readonly reason: 'unreadable' | 'outside' };

function wallMinutes({ hour, minute }: Clock): number {
  return hour * 60 + minute;
}

/**
 * The wall-clock reading `minutes` past midnight of `date`, in the event's
 * zone — a reading, not elapsed time, so «14h» is 14:00 on a DST Sunday too.
 */
function at(
  date: Temporal.PlainDate,
  minutes: number,
  timeZone: string,
): number {
  const rest = minutes % 1440;
  return date.add({ days: Math.floor(minutes / 1440) }).toZonedDateTime({
    timeZone,
    plainTime: Temporal.PlainTime.from({
      hour: Math.floor(rest / 60),
      minute: rest % 60,
    }),
  }).epochMilliseconds;
}

/**
 * «De» and «À» as typed, as an instant range inside the row.
 *
 * A clock time names two instants on a night row — 01:00 today and 01:00
 * tomorrow — so the start takes whichever falls inside the row and the end
 * takes the first one after the start: «20h → 5h» on a Friday night is
 * Saturday 05:00, as the volunteer meant. Both ends snap *inwards* to the
 * event's step and are clamped to the row; `adjusted` says so, because a
 * volunteer whose 13:45 became 14:00 should be told rather than surprised.
 */
export function typedRange(
  fromText: string,
  toText: string,
  row: DayRow,
  timeZone: string,
  stepMinutes: number,
): TypedRangeResult {
  const from = parseClock(fromText);
  const to = parseClock(toText);
  if (from === null || to === null) {
    return { ok: false, reason: 'unreadable' };
  }
  const snap = (m: number, up: boolean): number =>
    (up ? Math.ceil(m / stepMinutes) : Math.floor(m / stepMinutes)) *
    stepMinutes;
  const fromMin = snap(wallMinutes(from), true);
  const toMin = snap(wallMinutes(to), false);
  let adjusted = fromMin !== wallMinutes(from) || toMin !== wallMinutes(to);

  const day = Temporal.PlainDate.from(row.date);
  const startCandidates = [
    at(day, fromMin, timeZone),
    at(day.add({ days: 1 }), fromMin, timeZone),
  ];
  const start =
    startCandidates.find((s) => s >= row.start && s < row.end) ??
    startCandidates[0] ??
    row.start;
  const end =
    [
      at(day, toMin, timeZone),
      at(day.add({ days: 1 }), toMin, timeZone),
      at(day.add({ days: 2 }), toMin, timeZone),
    ].find((e) => e > start) ?? start;

  const clamped = clamp({ start, end }, row);
  if (clamped === null) {
    return { ok: false, reason: 'outside' };
  }
  adjusted ||= clamped.start !== start || clamped.end !== end;
  return { ok: true, range: clamped, adjusted };
}

// ── Output ─────────────────────────────────────────────────────────────────

export function windowsFor(
  row: DayRow,
  answer: DayAnswer,
): AvailabilityWindow[] {
  const iso = (ms: number): string =>
    Temporal.Instant.fromEpochMilliseconds(ms).toString();
  switch (answer.status) {
    case 'all':
      return [
        {
          event_id: row.eventId,
          kind: 'available',
          start: iso(row.start),
          end: iso(row.end),
        },
      ];
    case 'no':
      // docs/09 §3: an explicit «not available» is more useful than silence.
      return [
        {
          event_id: row.eventId,
          kind: 'unavailable',
          start: iso(row.start),
          end: iso(row.end),
        },
      ];
    case 'partial':
      return normalize(answer.ranges)
        .map((r) => clamp(r, row))
        .filter((r) => r !== null)
        .map((r) => ({
          event_id: row.eventId,
          kind: 'available',
          start: iso(r.start),
          end: iso(r.end),
        }));
    case 'unset':
      return [];
  }
}

export type AvailabilityError =
  | { readonly kind: 'partial_empty'; readonly rowKey: string }
  | { readonly kind: 'required' };

/**
 * «En partie» with nothing chosen is always an error: the volunteer started
 * to say something and did not finish. Unanswered rows are allowed — they
 * mean "nothing declared" — but a *required* question needs at least one
 * moment of availability somewhere, or it has not been answered at all.
 */
export function availabilityErrors(
  rows: readonly DayRow[],
  answers: Readonly<Record<string, DayAnswer>>,
  required: boolean,
): AvailabilityError[] {
  const errors: AvailabilityError[] = [];
  let anyAvailable = false;
  for (const row of rows) {
    const answer = answers[row.key] ?? UNSET;
    if (answer.status === 'partial' && answer.ranges.length === 0) {
      errors.push({ kind: 'partial_empty', rowKey: row.key });
    }
    if (
      answer.status === 'all' ||
      (answer.status === 'partial' && answer.ranges.length > 0)
    ) {
      anyAvailable = true;
    }
  }
  if (required && !anyAvailable) {
    errors.push({ kind: 'required' });
  }
  return errors;
}

/**
 * A previous submission, read back into row answers (docs/09 §4: a token link
 * reopens with its previous answers). A whole-row window is «Oui» or «Non»;
 * anything narrower is «En partie».
 */
export function answersFromWindows(
  rows: readonly DayRow[],
  windows: readonly AvailabilityWindow[],
): Record<string, DayAnswer> {
  const out: Record<string, DayAnswer> = {};
  for (const row of rows) {
    const mine = windows
      .filter((w) => w.event_id === row.eventId)
      .map((w) => ({
        kind: w.kind,
        range: clamp({ start: epoch(w.start), end: epoch(w.end) }, row),
      }))
      .filter(
        (w): w is { kind: typeof w.kind; range: Range } => w.range !== null,
      );
    if (mine.length === 0) {
      continue;
    }
    if (mine.some((w) => w.kind === 'unavailable')) {
      out[row.key] = { status: 'no', ranges: [] };
      continue;
    }
    const ranges = normalize(mine.map((w) => w.range));
    const whole =
      ranges.length === 1 &&
      ranges[0]?.start === row.start &&
      ranges[0].end === row.end;
    out[row.key] = whole
      ? { status: 'all', ranges: [] }
      : { status: 'partial', ranges };
  }
  return out;
}
