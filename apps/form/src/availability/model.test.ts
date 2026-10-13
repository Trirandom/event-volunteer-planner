// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { Temporal } from '@evp/shared/time';
import { describe, expect, it } from 'vitest';

import type { ScopeEvent } from '../api/publicForm';
import {
  answersFromWindows,
  availabilityErrors,
  chipsFor,
  covers,
  dayRows,
  epoch,
  normalize,
  parseClock,
  subtract,
  toggleChip,
  typedRange,
  UNSET,
  windowsFor,
  type DayRow,
} from './model';

const PARIS = 'Europe/Paris';

function event(
  start: string,
  end: string,
  extra: Partial<ScopeEvent> = {},
): ScopeEvent {
  return {
    id: 'ev',
    name: 'Dub & 2step',
    timezone: PARIS,
    period: { start, end },
    public_period: null,
    availability_step_minutes: 30,
    slot_options: [],
    ...extra,
  };
}

const ms = epoch;
const hhmm = (at: number): string =>
  Temporal.Instant.fromEpochMilliseconds(at).toString().slice(11, 16);

// Soundclash 26, as the worked example has it.
const dub = event('2026-09-11T13:00:00+02:00', '2026-09-12T08:00:00+02:00');
const openAir = event('2026-09-05T10:00:00+02:00', '2026-09-06T01:00:00+02:00');

function onlyRow(e: ScopeEvent): DayRow {
  const [row, ...rest] = dayRows(e);
  expect(rest).toEqual([]);
  if (row === undefined) {
    throw new Error('no row');
  }
  return row;
}

describe('dayRows', () => {
  it('keeps a night that ends after dawn as one row of the day it starts', () => {
    const row = onlyRow(dub);
    expect(row.date).toBe('2026-09-11');
    expect(row.start).toBe(ms('2026-09-11T13:00:00+02:00'));
    expect(row.end).toBe(ms('2026-09-12T08:00:00+02:00'));
  });

  it('cuts a multi-day event at the opening time, and ends with the period', () => {
    const rows = dayRows(
      event('2026-09-07T08:00:00+02:00', '2026-09-09T18:00:00+02:00'),
    );
    expect(rows.map((r) => r.date)).toEqual([
      '2026-09-07',
      '2026-09-08',
      '2026-09-09',
    ]);
    expect(rows[1]?.start).toBe(ms('2026-09-08T08:00:00+02:00'));
    expect(rows[2]?.end).toBe(ms('2026-09-09T18:00:00+02:00'));
  });

  it('drops a tail shorter than one step', () => {
    const rows = dayRows(
      event('2026-09-07T08:00:00+02:00', '2026-09-08T08:15:00+02:00'),
    );
    expect(rows.map((r) => r.date)).toEqual(['2026-09-07']);
  });

  it('gives a DST-ending day its 25 hours', () => {
    const rows = dayRows(
      event('2026-10-24T12:00:00+02:00', '2026-10-26T12:00:00+01:00'),
    );
    expect(rows).toHaveLength(2);
    const first = rows[0];
    expect(first === undefined ? 0 : first.end - first.start).toBe(
      25 * 3_600_000,
    );
  });
});

describe('range algebra', () => {
  const r = (a: string, b: string) => ({
    start: ms(`2026-09-11T${a}:00Z`),
    end: ms(`2026-09-11T${b}:00Z`),
  });

  it('merges overlapping and touching ranges (docs/09 §3)', () => {
    expect(
      normalize([
        r('12:00', '18:00'),
        r('08:00', '12:00'),
        r('17:00', '19:00'),
      ]),
    ).toEqual([r('08:00', '19:00')]);
  });

  it('keeps ranges with a gap apart', () => {
    expect(normalize([r('08:00', '10:00'), r('11:00', '12:00')])).toHaveLength(
      2,
    );
  });

  it('subtracts from the middle by splitting', () => {
    expect(subtract([r('08:00', '18:00')], r('12:00', '14:00'))).toEqual([
      r('08:00', '12:00'),
      r('14:00', '18:00'),
    ]);
  });

  it('covers across a merged union, not per range', () => {
    expect(
      covers([r('08:00', '12:00'), r('12:00', '18:00')], r('11:00', '13:00')),
    ).toBe(true);
    expect(covers([r('08:00', '12:00')], r('11:00', '13:00'))).toBe(false);
  });
});

describe('chipsFor', () => {
  it('folds a one-hour tail into the evening: Open Air is 10–12, 12–18, 18→01', () => {
    const chips = chipsFor(openAir, onlyRow(openAir));
    expect(chips.map((c) => c.label)).toEqual([
      { kind: 'part', part: 'morning' },
      { kind: 'part', part: 'afternoon' },
      { kind: 'part', part: 'evening' },
    ]);
    expect(
      chips.map((c) => `${hhmm(c.range.start)}-${hhmm(c.range.end)}`),
    ).toEqual(['08:00-10:00', '10:00-16:00', '16:00-23:00']);
  });

  it('offers the night on a festival night', () => {
    const parts = chipsFor(dub, onlyRow(dub)).map((c) =>
      c.label.kind === 'part' ? c.label.part : '',
    );
    expect(parts).toEqual(['afternoon', 'evening', 'night', 'morning']);
  });

  it('offers nothing on a short day', () => {
    const short = event(
      '2026-09-10T13:00:00+02:00',
      '2026-09-10T16:30:00+02:00',
    );
    expect(chipsFor(short, onlyRow(short))).toEqual([]);
  });

  it('prefers the coordinator’s slot options, clipped to the row', () => {
    const withSlots = event(
      '2026-09-11T13:00:00+02:00',
      '2026-09-12T08:00:00+02:00',
      {
        slot_options: [
          {
            label: { fr: 'Nuit' },
            start: '2026-09-12T00:00:00+02:00',
            end: '2026-09-12T09:00:00+02:00',
          },
          {
            label: { fr: 'Ailleurs' },
            start: '2026-09-20T00:00:00+02:00',
            end: '2026-09-20T09:00:00+02:00',
          },
        ],
      },
    );
    const chips = chipsFor(withSlots, onlyRow(withSlots));
    expect(chips).toHaveLength(1);
    expect(chips[0]?.range.end).toBe(ms('2026-09-12T08:00:00+02:00'));
  });

  it('toggles a chip on and back off, splitting a wider range', () => {
    const row = onlyRow(dub);
    const [afternoon, evening] = chipsFor(dub, row);
    if (afternoon === undefined || evening === undefined) {
      throw new Error('chips');
    }
    const both = toggleChip(toggleChip(UNSET, afternoon), evening);
    expect(both.ranges).toEqual([
      { start: afternoon.range.start, end: evening.range.end },
    ]);
    expect(toggleChip(both, afternoon).ranges).toEqual([evening.range]);
  });
});

describe('parseClock', () => {
  it.each([
    ['14:30', { hour: 14, minute: 30 }],
    ['14h30', { hour: 14, minute: 30 }],
    ['14H', { hour: 14, minute: 0 }],
    ['9', { hour: 9, minute: 0 }],
    ['14.30', { hour: 14, minute: 30 }],
    ['1430', { hour: 14, minute: 30 }],
    ['930', { hour: 9, minute: 30 }],
    [' 24h ', { hour: 24, minute: 0 }],
  ])('reads %j', (text, clock) => {
    expect(parseClock(text)).toEqual(clock);
  });

  it.each(['', 'midi', '25:00', '14:60', '24:30', '14h3'])(
    'refuses %j',
    (text) => {
      expect(parseClock(text)).toBeNull();
    },
  );
});

describe('typedRange', () => {
  const row = onlyRow(dub);

  it('reads «20h → 5h» on a Friday night as Saturday 05:00', () => {
    const got = typedRange('20h', '5h', row, PARIS, 30);
    expect(got).toEqual({
      ok: true,
      range: {
        start: ms('2026-09-11T20:00:00+02:00'),
        end: ms('2026-09-12T05:00:00+02:00'),
      },
      adjusted: false,
    });
  });

  it('places an after-midnight start on the next morning', () => {
    const got = typedRange('1h', '4h', row, PARIS, 30);
    expect(got.ok && got.range.start).toBe(ms('2026-09-12T01:00:00+02:00'));
  });

  it('snaps inwards to the step and says so', () => {
    const got = typedRange('14h10', '18h50', row, PARIS, 30);
    expect(got).toEqual({
      ok: true,
      range: {
        start: ms('2026-09-11T14:30:00+02:00'),
        end: ms('2026-09-11T18:30:00+02:00'),
      },
      adjusted: true,
    });
  });

  it('clamps to the row and says so', () => {
    const got = typedRange('10h', '15h', row, PARIS, 30);
    expect(got).toEqual({
      ok: true,
      range: { start: row.start, end: ms('2026-09-11T15:00:00+02:00') },
      adjusted: true,
    });
  });

  it('refuses a range wholly outside the row, and an unreadable time', () => {
    expect(typedRange('9h', '11h', row, PARIS, 30)).toEqual({
      ok: false,
      reason: 'outside',
    });
    expect(typedRange('midi', '14h', row, PARIS, 30)).toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });

  it('reads a wall clock on the DST night, not elapsed minutes', () => {
    const night = event(
      '2026-10-24T20:00:00+02:00',
      '2026-10-25T06:00:00+01:00',
    );
    const got = typedRange('22h', '4h', onlyRow(night), PARIS, 30);
    expect(got.ok && got.range.end).toBe(ms('2026-10-25T04:00:00+01:00'));
  });
});

describe('windowsFor and back', () => {
  const row = onlyRow(dub);

  it('writes «Oui» as the whole row and «Non» as an explicit unavailable window', () => {
    expect(windowsFor(row, { status: 'all', ranges: [] })).toEqual([
      {
        event_id: 'ev',
        kind: 'available',
        start: '2026-09-11T11:00:00Z',
        end: '2026-09-12T06:00:00Z',
      },
    ]);
    expect(
      windowsFor(row, {
        status: 'no',
        ranges: [{ start: row.start, end: row.end }],
      })[0]?.kind,
    ).toBe('unavailable');
    expect(windowsFor(row, UNSET)).toEqual([]);
  });

  it('never submits ranges kept from a status the volunteer left', () => {
    const kept = [{ start: row.start, end: row.start + 3_600_000 }];
    expect(windowsFor(row, { status: 'all', ranges: kept })).toHaveLength(1);
    expect(windowsFor(row, { status: 'all', ranges: kept })[0]?.end).toBe(
      '2026-09-12T06:00:00Z',
    );
  });

  it('reads a previous submission back into the same answers', () => {
    const partial = {
      status: 'partial' as const,
      ranges: [{ start: row.start, end: row.start + 7_200_000 }],
    };
    for (const answer of [
      { status: 'all' as const, ranges: [] },
      { status: 'no' as const, ranges: [] },
      partial,
    ]) {
      expect(
        answersFromWindows([row], windowsFor(row, answer))[row.key],
      ).toEqual(answer);
    }
  });
});

describe('availabilityErrors', () => {
  const row = onlyRow(dub);

  it('flags «En partie» with nothing chosen', () => {
    expect(
      availabilityErrors(
        [row],
        { [row.key]: { status: 'partial', ranges: [] } },
        false,
      ),
    ).toEqual([{ kind: 'partial_empty', rowKey: row.key }]);
  });

  it('needs one moment of availability when required, and nothing when optional', () => {
    expect(
      availabilityErrors(
        [row],
        { [row.key]: { status: 'no', ranges: [] } },
        true,
      ),
    ).toEqual([{ kind: 'required' }]);
    expect(availabilityErrors([row], {}, false)).toEqual([]);
    expect(
      availabilityErrors(
        [row],
        { [row.key]: { status: 'all', ranges: [] } },
        true,
      ),
    ).toEqual([]);
  });
});
