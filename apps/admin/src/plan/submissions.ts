// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The festival's form submissions, read one day at a time.
 *
 * A volunteer fills the form once and declares windows across the whole
 * production (docs/09 §3), so there is exactly one list and the day strip is
 * a *filter* on it, not a second query. That asymmetry is the whole module:
 * "who applied?" is a festival question, "who can work Saturday night?" is
 * the same rows with the windows that fall outside Saturday dropped — and
 * dropping a window may drop the volunteer entirely, which is the answer to
 * the question a coordinator actually opens the day for.
 *
 * Windows naming an event the page does not have are discarded rather than
 * rendered nameless. That happens whenever the two queries are momentarily
 * out of step — a day added in another tab — and `scope.ts` resolves the
 * same race the same way. A window with no day to belong to cannot be placed
 * on the strip, and a chip reading "unknown day, 22:00–05:00" is worse than
 * no chip.
 *
 * Pure, and over rows that are already loaded: which windows are in scope and
 * how much time they add up to is the part worth proving without a server
 * (docs/13 §8).
 */
import { Temporal } from '@evp/shared/time';

import type { Event } from '../api/events';
import type { Submission, SubmissionAnswer } from '../api/submissions';
import { t } from '../i18n';

/** One declared window, resolved against the day it was declared for. */
export interface DeclaredWindow {
  readonly eventId: string;
  readonly eventName: string;
  /**
   * The event's own IANA zone. An availability row carries none, and the
   * viewer's browser zone is the one zone this application must never render
   * in (docs/16 §1), so it is carried here rather than looked up later.
   */
  readonly timezone: string;
  /** Palette index, so a window reads in the same colour its day does on the
   * board — the pairing `eventLanes.ts` exists to establish. */
  readonly color: number;
  readonly period: { readonly start: string; readonly end: string };
  /**
   * Whole minutes, not hours as a fraction. A declared window is an exact
   * instant range (docs/09 §3) and the slots in the worked example are
   * deliberately uneven, so a 04:00–05:00 hour and a 22:00–05:00 night both
   * have to add up exactly rather than to 0.9999 of something.
   */
  readonly minutes: number;
}

export interface SubmissionRow {
  readonly id: string;
  readonly displayName: string;
  /** The surname, when one was given: what tells two Camilles apart
   * (docs/09 §"Why the name is two questions"). `null` for a mononym. */
  readonly lastName: string | null;
  readonly submittedAt: string;
  readonly answers: readonly SubmissionAnswer[];
  /** In scope, soonest first. Empty only at festival scope, where a
   * submission with no usable window is still a submission. */
  readonly windows: readonly DeclaredWindow[];
  readonly minutes: number;
  /** Distinct days this volunteer offered time on, within scope. */
  readonly dayCount: number;
}

export interface SubmissionBoard {
  readonly rows: readonly SubmissionRow[];
  /** Everything the festival received, whatever the current scope — the
   * denominator the narrowed count is only meaningful against. */
  readonly total: number;
  /** Submissions the selected day removed. Always 0 at festival scope. */
  readonly hiddenByScope: number;
}

function minutesBetween(start: string, end: string): number {
  const from = Temporal.Instant.from(start).epochMilliseconds;
  const to = Temporal.Instant.from(end).epochMilliseconds;
  // Rounded rather than truncated: no boundary in this product is specified
  // below the minute, so a stored instant carrying seconds is noise, not a
  // shorter shift.
  return Math.max(0, Math.round((to - from) / 60_000));
}

function startsAt(window: DeclaredWindow): number {
  return Temporal.Instant.from(window.period.start).epochMilliseconds;
}

/**
 * Folds the festival's submissions into the rows one page shows.
 *
 * `days` is every event in scope and `focusedEventId` is the one the
 * coordinator narrowed to, if any — the pair `scope.ts` already resolves, so
 * this function never has to know which of the two URLs was taken.
 */
export function buildSubmissionBoard(
  submissions: readonly Submission[],
  days: readonly Event[],
  focusedEventId: string | null,
): SubmissionBoard {
  const byId = new Map(days.map((day) => [day.id, day]));

  const rows: SubmissionRow[] = [];

  for (const submission of submissions) {
    const windows: DeclaredWindow[] = [];

    for (const declared of submission.availability) {
      if (focusedEventId !== null && declared.event_id !== focusedEventId) {
        continue;
      }
      const day = byId.get(declared.event_id);
      if (day === undefined) {
        continue;
      }
      windows.push({
        eventId: day.id,
        eventName: day.name,
        timezone: day.timezone,
        color: day.color,
        period: { start: declared.start, end: declared.end },
        minutes: minutesBetween(declared.start, declared.end),
      });
    }

    // A day in front of you is a question about that day: someone who
    // offered nothing on it is not an answer to it, and listing them would
    // bury the ones who did. At festival scope there is no such question, so
    // everyone who applied is shown — including whoever declared nothing
    // usable, who is precisely the person to chase.
    if (focusedEventId !== null && windows.length === 0) {
      continue;
    }

    windows.sort((a, b) => startsAt(a) - startsAt(b));

    rows.push({
      id: submission.id,
      displayName: submission.display_name,
      // `?? null` because the server omits the key entirely when there is no
      // surname (`api/submissions.ts`), and "absent" and "given as empty" are
      // the same thing to a card that just prints it.
      lastName: submission.last_name ?? null,
      submittedAt: submission.submitted_at,
      answers: submission.answers,
      windows,
      minutes: windows.reduce((total, window) => total + window.minutes, 0),
      dayCount: new Set(windows.map((window) => window.eventId)).size,
    });
  }

  return {
    rows,
    total: submissions.length,
    hiddenByScope: submissions.length - rows.length,
  };
}

/**
 * `12 h 30`, `7 h`, `45 min`.
 *
 * Hours and minutes rather than a decimal: the answer is read against a
 * shift, and "7.75" is not a thing anyone has ever said about a bar rota.
 * Digits and the unit read the same in both locales this application renders
 * today, but the shape comes from the catalogue so a third one is not bound
 * to it; the day and clock readings beside it carry the locale (docs/16 §1).
 */
export function durationLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;

  if (hours === 0) {
    return t('submissions.duration.minutes', { minutes: rest });
  }
  return rest === 0
    ? t('submissions.duration.hours', { hours })
    : t('submissions.duration.hoursMinutes', { hours, minutes: rest });
}
