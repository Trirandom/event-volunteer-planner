// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The submissions page read as a table: which columns it has, and which rows
 * survive the filters typed above them.
 *
 * **The columns come from the answers, not from a schema.** Answers are
 * interpreted against the form version they were given to (docs/09 §2), so
 * two volunteers can have answered different questions. The table therefore
 * has one column per question *anyone* answered, in the order they were first
 * met — a later form version's new question lands on the right rather than
 * reshuffling the columns a coordinator has already learned — and a
 * volunteer who was never asked it shows an empty cell, not a missing column.
 *
 * **A column's filter follows the shape of its answers.** A question with a
 * handful of distinct answers ("Avez-vous le permis ?", an experience level)
 * is a list to pick from; one whose answers are free text or a combination of
 * choices ("Bar, Entrées") is a box to type into, matched as a substring so
 * that "bar" finds every volunteer who ticked Bar among others. Matching folds
 * case and diacritics: a coordinator typing "entrees" on a phone keyboard
 * means "Entrées".
 *
 * Every filter narrows; none widens. The day strip has already narrowed the
 * rows to a day when one is selected (`submissions.ts`), and these narrow
 * what is left — so the count beside the table is always "this many of the
 * rows the day strip left you".
 *
 * Pure, and over rows that are already formatted: the view renders each
 * instant once and hands the strings here, so a filter on "Submitted" matches
 * what is on screen rather than an ISO timestamp nobody can see.
 */

/** At or below this many distinct answers, a column is filtered by picking
 * one of them rather than by typing. Eight is what a `<select>` shows without
 * scrolling on most platforms, and more than that is no longer a short list. */
export const CHOICE_LIMIT = 8;

export interface AnswerColumn {
  /** Stable within one response; used for element ids and filter state. */
  readonly key: string;
  readonly question: string;
  readonly kind: 'choice' | 'text';
  /** The distinct non-empty answers, sorted for the picker. Empty for a text
   * column, whose filter is a free substring. */
  readonly options: readonly string[];
}

/** What a row has to expose for the filters to read it. */
export interface FilterableRow {
  /** The name as printed: display name and surname together. */
  readonly name: string;
  readonly submitted: string;
  /** The days this row offered time on, within scope. */
  readonly eventIds: readonly string[];
  readonly answers: ReadonlyMap<string, string>;
}

/** Availability filter: any row, rows offering time on one day, or rows
 * that declared nothing usable — the ones to chase. */
export type AvailabilityFilter =
  | { readonly kind: 'any' }
  | { readonly kind: 'none' }
  | { readonly kind: 'day'; readonly eventId: string };

export interface SubmissionFilters {
  readonly name: string;
  readonly submitted: string;
  readonly availability: AvailabilityFilter;
  /** By column key. An absent or empty entry does not filter. */
  readonly answers: Readonly<Record<string, string>>;
}

export const NO_FILTERS: SubmissionFilters = {
  name: '',
  submitted: '',
  availability: { kind: 'any' },
  answers: {},
};

/**
 * Lower-cased with diacritics folded, and whitespace collapsed, so that
 * "Équipe  VSS" and "equipe vss" are the same needle.
 */
export function foldForSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

/** One column per question anyone answered, first-met order. */
export function answerColumns(
  rows: readonly { readonly answers: ReadonlyMap<string, string> }[],
): readonly AnswerColumn[] {
  const order: string[] = [];
  const values = new Map<string, Set<string>>();

  for (const row of rows) {
    for (const [question, value] of row.answers) {
      let seen = values.get(question);
      if (seen === undefined) {
        seen = new Set();
        values.set(question, seen);
        order.push(question);
      }
      if (value.trim() !== '') {
        seen.add(value);
      }
    }
  }

  return order.map((question, index) => {
    const distinct = [...(values.get(question) ?? [])];
    const kind = distinct.length <= CHOICE_LIMIT ? 'choice' : 'text';
    return {
      key: `q${String(index)}`,
      question,
      kind,
      options:
        kind === 'choice' ? distinct.sort((a, b) => a.localeCompare(b)) : [],
    };
  });
}

/** Whether any filter is set — what enables "clear filters". */
export function hasActiveFilters(filters: SubmissionFilters): boolean {
  return (
    filters.name.trim() !== '' ||
    filters.submitted.trim() !== '' ||
    filters.availability.kind !== 'any' ||
    Object.values(filters.answers).some((value) => value.trim() !== '')
  );
}

function matchesText(haystack: string, needle: string): boolean {
  const folded = foldForSearch(needle);
  return folded === '' || foldForSearch(haystack).includes(folded);
}

function matchesAvailability(
  row: FilterableRow,
  filter: AvailabilityFilter,
): boolean {
  switch (filter.kind) {
    case 'any':
      return true;
    case 'none':
      return row.eventIds.length === 0;
    case 'day':
      return row.eventIds.includes(filter.eventId);
  }
}

/** The rows every set filter lets through, in their original order. */
export function filterSubmissionRows<Row extends FilterableRow>(
  rows: readonly Row[],
  columns: readonly AnswerColumn[],
  filters: SubmissionFilters,
): readonly Row[] {
  const answerFilters = columns.flatMap((column) => {
    const wanted = filters.answers[column.key] ?? '';
    return wanted.trim() === '' ? [] : [{ column, wanted }];
  });

  return rows.filter(
    (row) =>
      matchesText(row.name, filters.name) &&
      matchesText(row.submitted, filters.submitted) &&
      matchesAvailability(row, filters.availability) &&
      answerFilters.every(({ column, wanted }) => {
        const answer = row.answers.get(column.question) ?? '';
        // A picked choice is an exact answer: "Oui" must not also match a
        // hypothetical "Oui, mais pas le dimanche".
        return column.kind === 'choice'
          ? answer === wanted
          : matchesText(answer, wanted);
      }),
  );
}
