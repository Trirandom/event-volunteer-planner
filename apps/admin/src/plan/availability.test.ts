// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The availability board's arithmetic.
 *
 * Two things are worth proving without a server. The **interval algebra**,
 * because "what can this volunteer work?" is a subtraction of two layers and
 * an off-by-one there tells a coordinator somebody is free on a night they are
 * not. And the **round trip**: an edit is sent as the difference between what
 * the board draws and what the volunteer submitted, so `effectiveSpans` and
 * `declaredWindows` have to be exact inverses or a saved edit reads back as a
 * different edit.
 */
import { Temporal } from '@evp/shared/time';
import { describe, expect, it } from 'vitest';

import type { Event } from '../api/events';
import type { Participation } from '../api/participations';
import {
  availabilityRows,
  createSpan,
  declaredWindows,
  effectiveSpans,
  firstFreeGap,
  middleOf,
  moveEdge,
  normalise,
  removeSpan,
  splitSpan,
  submittedBase,
  subtract,
  union,
  type Span,
} from './availability';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const OPEN = Temporal.Instant.from('2026-09-05T08:00:00Z').epochMilliseconds;
const CLOSE = OPEN + 12 * HOUR;
const DAY: Span = { startMs: OPEN, endMs: CLOSE };

function iso(ms: number): string {
  return Temporal.Instant.fromEpochMilliseconds(ms).toString();
}

function span(fromHours: number, toHours: number): Span {
  return { startMs: OPEN + fromHours * HOUR, endMs: OPEN + toHours * HOUR };
}

function participation(
  windows: readonly {
    readonly kind: 'available' | 'unavailable';
    readonly provenance: 'declared' | 'submitted';
    readonly fromHours: number;
    readonly toHours: number;
  }[],
  overrides: Partial<Participation> = {},
): Participation {
  return {
    id: 'p-1',
    volunteer_id: 'v-1',
    display_name: 'Camille',
    status: 'confirmed',
    availability: windows.map((window) => ({
      kind: window.kind,
      provenance: window.provenance,
      period: {
        start: iso(OPEN + window.fromHours * HOUR),
        end: iso(OPEN + window.toHours * HOUR),
      },
    })),
    ...overrides,
  };
}

function day(overrides: Partial<Event> = {}): Event {
  return {
    id: 'saturday',
    festival_id: 'soundclash',
    name: 'Saturday',
    slug: 'saturday',
    timezone: 'Europe/Paris',
    period: { start: iso(OPEN), end: iso(CLOSE) },
    status: 'planned',
    color: 3,
    created_at: iso(OPEN),
    updated_at: iso(OPEN),
    version: 1,
    ...overrides,
  };
}

describe('normalise', () => {
  it('folds stretches that merely touch into one', () => {
    expect(normalise([span(0, 2), span(2, 4)])).toStrictEqual([span(0, 4)]);
  });

  it('folds overlapping stretches and sorts them', () => {
    expect(normalise([span(3, 6), span(0, 4)])).toStrictEqual([span(0, 6)]);
  });

  it('drops an empty stretch rather than drawing a chip with no width', () => {
    expect(normalise([span(2, 2)])).toStrictEqual([]);
  });
});

describe('subtract', () => {
  it('cuts a hole out of the middle', () => {
    expect(subtract([span(0, 6)], [span(2, 3)])).toStrictEqual([
      span(0, 2),
      span(3, 6),
    ]);
  });

  it('trims an overlapping end', () => {
    expect(subtract([span(0, 6)], [span(4, 9)])).toStrictEqual([span(0, 4)]);
  });

  it('removes a stretch covered whole', () => {
    expect(subtract([span(1, 3)], [span(0, 6)])).toStrictEqual([]);
  });

  /** Half-open on both sides, as every period on the wire is (docs/04 §1): a
   * cut ending exactly where a stretch starts takes nothing off it. */
  it('leaves a stretch a cut only touches alone', () => {
    expect(subtract([span(2, 6)], [span(0, 2)])).toStrictEqual([span(2, 6)]);
  });

  it('is unchanged by an empty cut', () => {
    expect(subtract([span(0, 6)], [])).toStrictEqual([span(0, 6)]);
  });
});

describe('union', () => {
  it('folds the two lists together', () => {
    expect(union([span(0, 2)], [span(1, 5)])).toStrictEqual([span(0, 5)]);
  });
});

describe('the two layers', () => {
  it('reads a plain submitted answer as what the volunteer offered', () => {
    const person = participation([
      { kind: 'available', provenance: 'submitted', fromHours: 2, toHours: 8 },
    ]);

    expect(submittedBase(person)).toStrictEqual([span(2, 8)]);
    expect(effectiveSpans(person)).toStrictEqual([span(2, 8)]);
  });

  it('takes a submitted refusal out of a submitted offer', () => {
    const person = participation([
      { kind: 'available', provenance: 'submitted', fromHours: 2, toHours: 8 },
      {
        kind: 'unavailable',
        provenance: 'submitted',
        fromHours: 4,
        toHours: 5,
      },
    ]);

    expect(submittedBase(person)).toStrictEqual([span(2, 4), span(5, 8)]);
  });

  it("lets a coordinator's refusal override an overlapping offer", () => {
    const person = participation([
      { kind: 'available', provenance: 'submitted', fromHours: 2, toHours: 8 },
      { kind: 'unavailable', provenance: 'declared', fromHours: 6, toHours: 8 },
    ]);

    // The offer itself is untouched — that is the guarantee this page rests on.
    expect(submittedBase(person)).toStrictEqual([span(2, 8)]);
    expect(effectiveSpans(person)).toStrictEqual([span(2, 6)]);
  });

  it("adds a coordinator's own stretch to what was offered", () => {
    const person = participation([
      { kind: 'available', provenance: 'submitted', fromHours: 2, toHours: 4 },
      { kind: 'available', provenance: 'declared', fromHours: 6, toHours: 9 },
    ]);

    expect(effectiveSpans(person)).toStrictEqual([span(2, 4), span(6, 9)]);
  });

  it('reads a volunteer who declared nothing as offering nothing', () => {
    expect(effectiveSpans(participation([]))).toStrictEqual([]);
  });
});

describe('declaredWindows', () => {
  it('writes a refusal for the part of an offer that was struck out', () => {
    expect(declaredWindows([span(2, 8)], [span(2, 6)])).toStrictEqual([
      {
        kind: 'unavailable',
        startMs: span(6, 8).startMs,
        endMs: span(6, 8).endMs,
      },
    ]);
  });

  it('writes an offer for a stretch the volunteer never mentioned', () => {
    expect(declaredWindows([], [span(6, 9)])).toStrictEqual([
      {
        kind: 'available',
        startMs: span(6, 9).startMs,
        endMs: span(6, 9).endMs,
      },
    ]);
  });

  it('writes nothing at all when the board matches what was submitted', () => {
    expect(declaredWindows([span(2, 8)], [span(2, 8)])).toStrictEqual([]);
  });

  it('writes a refusal covering an offer removed outright', () => {
    expect(declaredWindows([span(2, 8)], [])).toStrictEqual([
      {
        kind: 'unavailable',
        startMs: span(2, 8).startMs,
        endMs: span(2, 8).endMs,
      },
    ]);
  });

  /**
   * The round trip, which is the property the page depends on: what the board
   * draws has to survive being saved and read back. Split into two halves —
   * an offer trimmed at the end, and a new stretch added elsewhere — because
   * that is one ordinary afternoon's editing.
   */
  it('reads back as exactly what the board was drawing', () => {
    const base = [span(2, 8)];
    const wanted = [span(2, 4), span(5, 6), span(9, 11)];
    const written = declaredWindows(base, wanted);

    const person = participation([
      { kind: 'available', provenance: 'submitted', fromHours: 2, toHours: 8 },
      ...written.map((window) => ({
        kind: window.kind,
        provenance: 'declared' as const,
        fromHours: (window.startMs - OPEN) / HOUR,
        toHours: (window.endMs - OPEN) / HOUR,
      })),
    ]);

    expect(effectiveSpans(person)).toStrictEqual(wanted);
  });

  /** The two halves are what the exclusion constraint forbids overlapping
   * within one provenance, so a payload that produced two overlapping windows
   * would collect a 422 rather than a save. */
  it('never writes two windows that overlap each other', () => {
    const written = declaredWindows(
      [span(0, 4), span(6, 10)],
      [span(2, 8), span(9, 12)],
    );

    written.forEach((window, index) => {
      const next = written[index + 1];
      expect(next === undefined || next.startMs >= window.endMs).toBe(true);
    });
  });
});

describe('moveEdge', () => {
  it('snaps the edge it is given to the grid', () => {
    const next = moveEdge(
      [span(0, 2)],
      0,
      'end',
      OPEN + 3 * HOUR + 4 * MINUTE,
      15,
      DAY,
    );
    expect(next).toStrictEqual([span(0, 3)]);
  });

  /** Pushed all the way onto its neighbour, the two become one chip — there
   * is no gap left to draw, and `normalise` folds what touches. */
  it('stops at the neighbour beside it, and merges when it arrives', () => {
    const next = moveEdge(
      [span(0, 2), span(4, 6)],
      0,
      'end',
      OPEN + 10 * HOUR,
      15,
      DAY,
    );
    expect(next).toStrictEqual([span(0, 6)]);
  });

  it('holds the edge inside the day', () => {
    const next = moveEdge([span(0, 2)], 0, 'end', CLOSE + 5 * HOUR, 15, DAY);
    expect(next).toStrictEqual([{ startMs: OPEN, endMs: CLOSE }]);
  });

  it('never shrinks a chip past one step', () => {
    const next = moveEdge([span(0, 2)], 0, 'end', OPEN, 15, DAY);
    expect(next).toStrictEqual([{ startMs: OPEN, endMs: OPEN + 15 * MINUTE }]);
  });

  it('does nothing for a chip that is not there', () => {
    const spans = [span(0, 2)];
    expect(moveEdge(spans, 7, 'end', OPEN + 3 * HOUR, 15, DAY)).toBe(spans);
  });
});

describe('splitSpan', () => {
  it('breaks one chip into two with a gap between them', () => {
    expect(splitSpan([span(0, 4)], 0, OPEN + 2 * HOUR, 15)).toStrictEqual([
      span(0, 2),
      { startMs: OPEN + 2 * HOUR + 15 * MINUTE, endMs: OPEN + 4 * HOUR },
    ]);
  });

  it('does nothing at or past either end', () => {
    const spans = [span(0, 4)];
    expect(splitSpan(spans, 0, OPEN, 15)).toBe(spans);
    expect(splitSpan(spans, 0, OPEN + 4 * HOUR, 15)).toBe(spans);
  });

  it('puts a split with no pointer behind it in the middle', () => {
    expect(middleOf(span(0, 4), 15)).toBe(OPEN + 2 * HOUR);
  });
});

describe('removeSpan', () => {
  it('takes one chip off the row and leaves the others', () => {
    expect(removeSpan([span(0, 2), span(4, 6)], 0)).toStrictEqual([span(4, 6)]);
  });
});

describe('createSpan', () => {
  it('draws a new chip across the stretch a drag covered', () => {
    expect(createSpan([], OPEN + HOUR, OPEN + 3 * HOUR, 15, DAY)).toStrictEqual(
      [span(1, 3)],
    );
  });

  it('reads a drag backwards the same as one forwards', () => {
    expect(createSpan([], OPEN + 3 * HOUR, OPEN + HOUR, 15, DAY)).toStrictEqual(
      [span(1, 3)],
    );
  });

  it('does nothing when the drag began inside an existing chip', () => {
    const spans = [span(0, 4)];
    expect(createSpan(spans, OPEN + HOUR, OPEN + 6 * HOUR, 15, DAY)).toBe(
      spans,
    );
  });

  it('holds the new chip out of its neighbours', () => {
    const next = createSpan(
      [span(4, 6)],
      OPEN + 7 * HOUR,
      OPEN + 30 * HOUR,
      15,
      DAY,
    );
    expect(next).toStrictEqual([
      span(4, 6),
      { startMs: OPEN + 7 * HOUR, endMs: CLOSE },
    ]);
  });

  it('drops a drag shorter than one step', () => {
    const spans: readonly Span[] = [];
    expect(createSpan(spans, OPEN, OPEN + MINUTE, 15, DAY)).toBe(spans);
  });

  it('refuses a drag that started outside the day', () => {
    const spans: readonly Span[] = [];
    expect(createSpan(spans, OPEN - HOUR, OPEN + 2 * HOUR, 15, DAY)).toBe(
      spans,
    );
  });
});

describe('firstFreeGap', () => {
  it('finds the stretch before the first chip', () => {
    expect(firstFreeGap([span(2, 6)], DAY, 60)).toStrictEqual(span(0, 2));
  });

  it('finds a stretch between two chips', () => {
    expect(firstFreeGap([span(0, 2), span(6, 12)], DAY, 60)).toStrictEqual(
      span(2, 6),
    );
  });

  it('answers with nothing once the day is full', () => {
    expect(firstFreeGap([span(0, 12)], DAY, 15)).toBeNull();
  });
});

describe('availabilityRows', () => {
  it('gives one row per volunteer, in name order, with a track per day', () => {
    const saturday = day();
    const sunday = day({
      id: 'sunday',
      name: 'Sunday',
      period: { start: iso(OPEN + 24 * HOUR), end: iso(CLOSE + 24 * HOUR) },
    });

    const rows = availabilityRows(
      new Map([
        [
          'saturday',
          [
            participation([
              {
                kind: 'available',
                provenance: 'submitted',
                fromHours: 2,
                toHours: 6,
              },
            ]),
            participation(
              [
                {
                  kind: 'available',
                  provenance: 'submitted',
                  fromHours: 0,
                  toHours: 2,
                },
              ],
              { id: 'p-2', volunteer_id: 'v-2', display_name: 'Alba' },
            ),
          ],
        ],
        [
          'sunday',
          [
            participation([], {
              id: 'p-3',
              volunteer_id: 'v-1',
              display_name: 'Camille',
            }),
          ],
        ],
      ]),
      [saturday, sunday],
    );

    expect(rows.map((row) => row.name)).toStrictEqual(['Alba', 'Camille']);
    expect(rows[1]?.tracks.map((track) => track.eventId)).toStrictEqual([
      'saturday',
      'sunday',
    ]);
    // Four hours on Saturday, nothing on Sunday.
    expect(rows[1]?.minutes).toBe(4 * 60);
  });

  it('keeps a volunteer who is enrolled and has declared nothing', () => {
    const rows = availabilityRows(
      new Map([['saturday', [participation([])]]]),
      [day()],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tracks[0]?.spans).toStrictEqual([]);
  });

  it('marks a day a coordinator has changed as overridden', () => {
    const rows = availabilityRows(
      new Map([
        [
          'saturday',
          [
            participation([
              {
                kind: 'available',
                provenance: 'submitted',
                fromHours: 2,
                toHours: 8,
              },
              {
                kind: 'unavailable',
                provenance: 'declared',
                fromHours: 6,
                toHours: 8,
              },
            ]),
          ],
        ],
      ]),
      [day()],
    );

    expect(rows[0]?.tracks[0]?.overridden).toBe(true);
    expect(rows[0]?.tracks[0]?.submitted).toStrictEqual([span(2, 8)]);
    expect(rows[0]?.tracks[0]?.spans).toStrictEqual([span(2, 6)]);
  });

  it('leaves a day nobody has touched unmarked', () => {
    const rows = availabilityRows(
      new Map([
        [
          'saturday',
          [
            participation([
              {
                kind: 'available',
                provenance: 'submitted',
                fromHours: 2,
                toHours: 8,
              },
            ]),
          ],
        ],
      ]),
      [day()],
    );

    expect(rows[0]?.tracks[0]?.overridden).toBe(false);
  });
});
