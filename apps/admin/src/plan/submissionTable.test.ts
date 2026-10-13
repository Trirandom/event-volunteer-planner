// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The columns have to follow the answers rather than a fixed schema, and the
 * filters have to narrow the way a coordinator reads them: substring and
 * accent-blind for free text, exact for a picked choice, and "nothing
 * declared" as a first-class answer to the availability question.
 */
import { describe, expect, it } from 'vitest';

import {
  answerColumns,
  CHOICE_LIMIT,
  filterSubmissionRows,
  foldForSearch,
  hasActiveFilters,
  NO_FILTERS,
  type FilterableRow,
} from './submissionTable';

function row(
  name: string,
  answers: Record<string, string>,
  eventIds: readonly string[] = [],
): FilterableRow {
  return {
    name,
    submitted: 'Submitted August 4, 2026, 15:09',
    eventIds,
    answers: new Map(Object.entries(answers)),
  };
}

const CAMILLE = row('Camille', { Postes: 'Bar, Entrées', Permis: 'Oui' }, [
  'open-air',
]);
const AUREL = row(
  'MARCHAND Aurel · Marchand',
  { Postes: 'Montage / Démontage', Permis: 'Non', Expérience: 'Débutant' },
  ['dub'],
);
const NOBODY = row('Sam', { Permis: 'Oui' });

const ROWS = [CAMILLE, AUREL, NOBODY];

describe('answerColumns', () => {
  it('has one column per question anyone answered, first-met order', () => {
    expect(answerColumns(ROWS).map((column) => column.question)).toEqual([
      'Postes',
      'Permis',
      'Expérience',
    ]);
  });

  it('offers a short list of answers as choices, sorted', () => {
    const permis = answerColumns(ROWS).find((c) => c.question === 'Permis');
    expect(permis?.kind).toBe('choice');
    expect(permis?.options).toEqual(['Non', 'Oui']);
  });

  it('falls back to free text past the choice limit', () => {
    const many = Array.from({ length: CHOICE_LIMIT + 1 }, (_, index) =>
      row(`V${String(index)}`, { Notes: `note ${String(index)}` }),
    );
    const [notes] = answerColumns(many);
    expect(notes?.kind).toBe('text');
    expect(notes?.options).toEqual([]);
  });
});

describe('filterSubmissionRows', () => {
  const columns = answerColumns(ROWS);
  const key = (question: string): string =>
    columns.find((column) => column.question === question)?.key ?? '';

  it('lets everything through with no filter set', () => {
    expect(filterSubmissionRows(ROWS, columns, NO_FILTERS)).toEqual(ROWS);
    expect(hasActiveFilters(NO_FILTERS)).toBe(false);
  });

  it('matches the name as a case- and accent-blind substring', () => {
    const filters = { ...NO_FILTERS, name: 'marchand' };
    expect(filterSubmissionRows(ROWS, columns, filters)).toEqual([AUREL]);
    expect(hasActiveFilters(filters)).toBe(true);
  });

  it('matches one choice among several in a free-text answer', () => {
    // Enough distinct combinations to push "Postes" past the choice limit,
    // which is what the worked example's thirteen combinations do.
    const padding = Array.from({ length: CHOICE_LIMIT }, (_, index) =>
      row(`V${String(index)}`, { Postes: `Poste ${String(index)}` }),
    );
    const rows = [...ROWS, ...padding];
    const wide = answerColumns(rows);
    const postes = wide.find((column) => column.question === 'Postes');
    expect(postes?.kind).toBe('text');

    // "entrees" typed without its accent still finds "Bar, Entrées".
    const filters = {
      ...NO_FILTERS,
      answers: { [postes?.key ?? '']: 'entrees' },
    };
    expect(filterSubmissionRows(rows, wide, filters)).toEqual([CAMILLE]);
  });

  it('matches a picked choice exactly', () => {
    const filters = { ...NO_FILTERS, answers: { [key('Permis')]: 'Oui' } };
    expect(filterSubmissionRows(ROWS, columns, filters)).toEqual([
      CAMILLE,
      NOBODY,
    ]);
  });

  it('narrows to one day, or to the volunteers who declared nothing', () => {
    expect(
      filterSubmissionRows(ROWS, columns, {
        ...NO_FILTERS,
        availability: { kind: 'day', eventId: 'dub' },
      }),
    ).toEqual([AUREL]);
    expect(
      filterSubmissionRows(ROWS, columns, {
        ...NO_FILTERS,
        availability: { kind: 'none' },
      }),
    ).toEqual([NOBODY]);
  });

  it('combines filters as AND', () => {
    const filters = {
      ...NO_FILTERS,
      availability: { kind: 'day', eventId: 'open-air' },
      answers: { [key('Permis')]: 'Non' },
    } as const;
    expect(filterSubmissionRows(ROWS, columns, filters)).toEqual([]);
  });

  it('treats an unanswered question as an empty answer', () => {
    const filters = {
      ...NO_FILTERS,
      answers: { [key('Expérience')]: 'Débutant' },
    };
    expect(filterSubmissionRows(ROWS, columns, filters)).toEqual([AUREL]);
  });
});

describe('foldForSearch', () => {
  it('folds case, diacritics and runs of whitespace', () => {
    expect(foldForSearch('  Équipe   de prévention VSS ')).toBe(
      'equipe de prevention vss',
    );
  });
});
