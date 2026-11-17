// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The assignation grid's arithmetic: how many seats a slot has, which of them
 * are holes, and who the dropdown offers in what order.
 *
 * These are the decisions the page *is*. "Is this post staffed?" is a sum over
 * seats, and "who can work 22:00–02:00?" is a comparison against declared
 * windows — neither is a thing to verify by looking at a screenshot, and both
 * are wrong in ways nobody notices until the night itself.
 */
import { Temporal } from '@evp/shared/time';
import { describe, expect, it } from 'vitest';

import type { Assignment } from '../api/assignments';
import type { Participation } from '../api/participations';
import type { BarShift, MissionRow, Run } from '../board/runs';
import {
  candidatesFor,
  isChoosable,
  rosterRows,
  rowCoverage,
  slotState,
} from './roster';

const HOUR = 3_600_000;
/** The offsets below are hours from it. `Date.UTC` is banned along with the
 * rest of `Date` (docs/16 §4), and an RFC 3339 literal is what the wire
 * carries anyway. */
const EVENING = Temporal.Instant.from('2026-09-05T18:00:00Z').epochMilliseconds;

/** `new Date` is banned (docs/16 §4) in tests as much as anywhere else: the
 * point of the ban is that this codebase has one way to name an instant. */
function iso(ms: number): string {
  return Temporal.Instant.fromEpochMilliseconds(ms).toString();
}

function barShift(overrides: Partial<BarShift> = {}): BarShift {
  return {
    id: 'shift-1',
    version: 1,
    startMs: EVENING,
    endMs: EVENING + 2 * HOUR,
    title: 'Bar',
    requiredCount: 2,
    maxCount: null,
    ...overrides,
  };
}

function run(shifts: readonly BarShift[], overrides: Partial<Run> = {}): Run {
  const first = shifts[0];
  return {
    key: 'bar:0',
    eventId: 'saturday',
    eventName: 'Saturday',
    locationId: 'bar-post',
    timezone: 'Europe/Paris',
    boundsStartMs: EVENING - 12 * HOUR,
    boundsEndMs: EVENING + 12 * HOUR,
    eventVersion: 1,
    color: 3,
    publicStartMs: null,
    publicEndMs: null,
    startMs: first?.startMs ?? EVENING,
    endMs: shifts.at(-1)?.endMs ?? EVENING,
    shifts,
    cutsMs: [],
    proposed: false,
    posts: [],
    ...overrides,
  };
}

function missionRow(runs: readonly Run[]): MissionRow {
  return { key: 'bar', name: 'Bar', runs, alsoAtDays: 0, posts: [] };
}

function assignment(overrides: Partial<Assignment> = {}): Assignment {
  return {
    id: 'assignment-1',
    event_id: 'saturday',
    shift_id: 'shift-1',
    participation_id: 'participation-1',
    volunteer_id: 'volunteer-1',
    post_id: null,
    period: { start: iso(EVENING), end: iso(EVENING + 2 * HOUR) },
    status: 'draft',
    assigned_at: iso(EVENING),
    version: 1,
    ...overrides,
  };
}

function person(overrides: Partial<Participation> = {}): Participation {
  return {
    id: 'participation-1',
    volunteer_id: 'volunteer-1',
    display_name: 'Camille',
    status: 'invited',
    availability: [],
    ...overrides,
  };
}

const NOBODY: ReadonlyMap<string, readonly Participation[]> = new Map();

describe('rosterRows', () => {
  it('gives a slot one seat per volunteer it needs, and no spare yet', () => {
    const [row] = rosterRows([missionRow([run([barShift()])])], [], NOBODY);

    const slot = row?.slots[0];
    expect(slot?.seats).toHaveLength(2);
    expect(slot?.seats.map((seat) => seat.extra)).toStrictEqual([false, false]);
    expect(slot?.filled).toBe(0);
    expect(row?.seatRows).toBe(2);
  });

  /** An "add somebody (extra)" beside a hole invites filling the extra
   * first; the spare only appears once every required seat is taken. */
  it('offers the spare seat only once every required seat is filled', () => {
    const placed = (count: number) =>
      Array.from({ length: count }, (_unused, index) =>
        assignment({
          id: `assignment-${String(index)}`,
          participation_id: `participation-${String(index)}`,
          volunteer_id: `volunteer-${String(index)}`,
        }),
      );
    const seatsWith = (count: number) =>
      rosterRows([missionRow([run([barShift()])])], placed(count), NOBODY)[0]
        ?.slots[0]?.seats;

    expect(seatsWith(1)?.map((seat) => seat.extra)).toStrictEqual([
      false,
      false,
    ]);
    expect(seatsWith(2)?.map((seat) => seat.extra)).toStrictEqual([
      false,
      false,
      true,
    ]);
    expect(seatsWith(3)?.map((seat) => seat.extra)).toStrictEqual([
      false,
      false,
      true,
      true,
    ]);
  });

  /** The shift board cuts every slot at `required_count = 1`; "Bar needs
   * four" lives on the mission's own row, and that is the number to staff. */
  it('staffs a slot against its mission’s own minimum', () => {
    const [row] = rosterRows(
      [missionRow([run([barShift({ requiredCount: 1 })])])],
      [],
      NOBODY,
      new Map([['bar-post', { min: 4, max: 8 }]]),
    );

    const slot = row?.slots[0];
    expect(slot?.requiredCount).toBe(4);
    expect(slot?.maxCount).toBe(8);
    expect(slot?.seats).toHaveLength(4);
    expect(slot?.seats.every((seat) => !seat.extra)).toBe(true);
  });

  it('falls back to the shift’s own count when the mission has said nothing', () => {
    const [row] = rosterRows(
      [missionRow([run([barShift({ requiredCount: 3, maxCount: 5 })])])],
      [],
      NOBODY,
      new Map([['bar-post', { min: null, max: null }]]),
    );

    expect(row?.slots[0]?.requiredCount).toBe(3);
    expect(row?.slots[0]?.maxCount).toBe(5);
  });

  /** A mission that needs nobody has no required seat to wait on. */
  it('offers the spare straight away on a mission with a minimum of zero', () => {
    const [row] = rosterRows(
      [missionRow([run([barShift()])])],
      [],
      NOBODY,
      new Map([['bar-post', { min: 0, max: null }]]),
    );

    expect(row?.slots[0]?.seats.map((seat) => seat.extra)).toStrictEqual([
      true,
    ]);
  });

  it('stops offering a spare at the mission’s own ceiling', () => {
    const [row] = rosterRows(
      [missionRow([run([barShift({ requiredCount: 1 })])])],
      [assignment()],
      NOBODY,
      new Map([['bar-post', { min: 1, max: 1 }]]),
    );

    expect(row?.slots[0]?.seats).toHaveLength(1);
  });

  it('seats the people already placed, and names them from the day roster', () => {
    const participants = new Map([['saturday', [person()]]]);

    const [row] = rosterRows(
      [missionRow([run([barShift()])])],
      [assignment()],
      participants,
    );

    const slot = row?.slots[0];
    expect(slot?.filled).toBe(1);
    expect(slot?.seats[0]?.holder?.name).toBe('Camille');
    expect(slot?.seats[0]?.holder?.assignmentId).toBe('assignment-1');
    // The version travels with the seat: cancelling sends it as `If-Match`.
    expect(slot?.seats[0]?.holder?.version).toBe(1);
    expect(slot?.seats[1]?.holder).toBeNull();
  });

  /** A roster that failed to load must not make a taken seat look empty. */
  it('falls back to the volunteer id when the roster is missing', () => {
    const [row] = rosterRows(
      [missionRow([run([barShift()])])],
      [assignment()],
      NOBODY,
    );

    expect(row?.slots[0]?.seats[0]?.holder?.name).toBe('volunteer-1');
  });

  it('offers no spare seat once the slot is at its ceiling', () => {
    const [row] = rosterRows(
      [missionRow([run([barShift({ requiredCount: 1, maxCount: 1 })])])],
      [assignment()],
      NOBODY,
    );

    expect(row?.slots[0]?.seats).toHaveLength(1);
  });

  it('still offers a spare below the ceiling', () => {
    const [row] = rosterRows(
      [missionRow([run([barShift({ requiredCount: 1, maxCount: 3 })])])],
      [assignment()],
      NOBODY,
    );

    expect(row?.slots[0]?.seats).toHaveLength(2);
  });

  /** One mission, two days running it at once — the club night and the after
   * that laps it. One column of names drawn over another is the board hiding
   * what it exists to show (`board/lanes.ts`). */
  it('stacks slots that overlap onto their own lane rows', () => {
    const saturday = run([barShift({ id: 'shift-1' })]);
    const after = run(
      [
        barShift({
          id: 'shift-2',
          startMs: EVENING + HOUR,
          endMs: EVENING + 3 * HOUR,
          requiredCount: 1,
        }),
      ],
      { key: 'bar:1', eventId: 'after', eventName: 'After', color: 7 },
    );

    const [row] = rosterRows([missionRow([saturday, after])], [], NOBODY);

    const first = row?.slots.find((slot) => slot.shiftId === 'shift-1');
    const second = row?.slots.find((slot) => slot.shiftId === 'shift-2');
    expect(first?.laneRow).toBe(0);
    expect(second?.laneRow).toBe(1);
    // The second lane starts below every seat of the first, so the two never
    // draw over each other.
    expect(first?.seatOffset).toBe(0);
    expect(second?.seatOffset).toBe(2);
    expect(row?.seatRows).toBe(3);
    expect(row?.laneCount).toBe(2);
  });

  /** Consecutive slots share a lane: 18:00–20:00 and 20:00–22:00 at one post
   * are one evening, and spending a second row on them would make an ordinary
   * rota look like two parallel ones. */
  it('keeps consecutive slots on one lane row', () => {
    const [row] = rosterRows(
      [
        missionRow([
          run([
            barShift({ id: 'shift-1' }),
            barShift({
              id: 'shift-2',
              startMs: EVENING + 2 * HOUR,
              endMs: EVENING + 4 * HOUR,
            }),
          ]),
        ]),
      ],
      [],
      NOBODY,
    );

    expect(row?.slots.map((slot) => slot.laneRow)).toStrictEqual([0, 0]);
    expect(row?.seatRows).toBe(2);
    expect(row?.laneCount).toBe(1);
  });

  it('reads a line left to right whatever order the days arrived in', () => {
    const later = run([
      barShift({
        id: 'shift-late',
        startMs: EVENING + 4 * HOUR,
        endMs: EVENING + 6 * HOUR,
      }),
    ]);
    const earlier = run([barShift({ id: 'shift-early' })], { key: 'bar:1' });

    const [row] = rosterRows([missionRow([later, earlier])], [], NOBODY);

    expect(row?.slots.map((slot) => slot.shiftId)).toStrictEqual([
      'shift-early',
      'shift-late',
    ]);
  });
});

/**
 * A post is a role within its zone's shift (ADR-0052): the bar manager works
 * the bar's hours and is one of the bar's people. So the zone's slot carries
 * the post's seats, and the zone's own min/max is the whole bar, posts
 * included.
 */
describe('rosterRows with posts', () => {
  const MANAGER = { id: 'manager-post', name: 'Bar manager' };
  const CASHIER = { id: 'cashier-post', name: 'Caisse' };

  function placed(
    index: number,
    postId: string | null,
    name = `Person ${String(index)}`,
  ): { assignment: Assignment; person: Participation } {
    return {
      assignment: assignment({
        id: `assignment-${String(index)}`,
        participation_id: `participation-${String(index)}`,
        volunteer_id: `volunteer-${String(index)}`,
        post_id: postId,
      }),
      person: person({
        id: `participation-${String(index)}`,
        volunteer_id: `volunteer-${String(index)}`,
        display_name: name,
      }),
    };
  }

  function slotWith(
    people: readonly { assignment: Assignment; person: Participation }[],
    bounds: ReadonlyMap<string, { min: number | null; max: number | null }>,
    posts: readonly { id: string; name: string }[] = [MANAGER, CASHIER],
  ) {
    const [row] = rosterRows(
      [missionRow([run([barShift({ requiredCount: 1 })], { posts })])],
      people.map((entry) => entry.assignment),
      new Map([['saturday', people.map((entry) => entry.person)]]),
      bounds,
    );
    return row?.slots[0];
  }

  function layout(slot: ReturnType<typeof slotWith>) {
    return slot?.seats.map((seat) => ({
      post: seat.postName,
      holder: seat.holder?.name ?? null,
      extra: seat.extra,
    }));
  }

  it('carves each post’s minimum out of the zone’s, posts first', () => {
    const slot = slotWith(
      [],
      new Map([
        ['bar-post', { min: 4, max: 8 }],
        [MANAGER.id, { min: 1, max: 1 }],
        [CASHIER.id, { min: 1, max: 2 }],
      ]),
    );

    expect(layout(slot)).toStrictEqual([
      { post: 'Bar manager', holder: null, extra: false },
      { post: 'Caisse', holder: null, extra: false },
      { post: null, holder: null, extra: false },
      { post: null, holder: null, extra: false },
    ]);
    expect(slot?.requiredCount).toBe(4);
    expect(slot?.maxCount).toBe(8);
  });

  it('counts the bar manager as one of the bar’s volunteers', () => {
    const slot = slotWith(
      [placed(0, MANAGER.id, 'Alex'), placed(1, null, 'Sam')],
      new Map([
        ['bar-post', { min: 2, max: 3 }],
        [MANAGER.id, { min: 1, max: 1 }],
      ]),
      [MANAGER],
    );

    expect(layout(slot)).toStrictEqual([
      { post: 'Bar manager', holder: 'Alex', extra: false },
      { post: null, holder: 'Sam', extra: false },
      { post: null, holder: null, extra: true },
    ]);
    expect(slot?.filled).toBe(2);
    expect(slot === undefined ? null : slotState(slot)).toBe('full');
  });

  /** A second cashier is a second bar volunteer: the zone needs one fewer
   * role-less hand, not one more. */
  it('lets a post staffed past its own minimum fill the zone’s floor', () => {
    const slot = slotWith(
      [placed(0, CASHIER.id, 'Alex'), placed(1, CASHIER.id, 'Lou')],
      new Map([
        ['bar-post', { min: 3, max: null }],
        [CASHIER.id, { min: 1, max: 2 }],
      ]),
      [CASHIER],
    );

    expect(layout(slot)).toStrictEqual([
      { post: 'Caisse', holder: 'Alex', extra: false },
      { post: 'Caisse', holder: 'Lou', extra: true },
      { post: null, holder: null, extra: false },
    ]);
    expect(slot?.requiredCount).toBe(3);
  });

  it('offers no seat past the zone’s ceiling, posts included', () => {
    const slot = slotWith(
      [placed(0, MANAGER.id), placed(1, null)],
      new Map([
        ['bar-post', { min: 1, max: 2 }],
        [MANAGER.id, { min: 1, max: 1 }],
      ]),
      [MANAGER, { id: 'runner-post', name: 'Runner' }],
    );

    expect(layout(slot)?.filter((seat) => seat.holder === null)).toStrictEqual(
      [],
    );
  });

  it('offers no spare on a post at its own ceiling', () => {
    const slot = slotWith(
      [placed(0, MANAGER.id)],
      new Map([
        ['bar-post', { min: 1, max: null }],
        [MANAGER.id, { min: 1, max: 1 }],
      ]),
      [MANAGER],
    );

    expect(layout(slot)).toStrictEqual([
      { post: 'Bar manager', holder: 'Person 0', extra: false },
      { post: null, holder: null, extra: true },
    ]);
  });

  /** A post nobody has given a floor to is still a role somebody can be
   * put in: one spare seat says so, and it is not a hole. */
  it('offers one spare seat on a post with no bounds', () => {
    const slot = slotWith([], new Map([['bar-post', { min: 1, max: null }]]), [
      MANAGER,
    ]);

    expect(layout(slot)).toStrictEqual([
      { post: 'Bar manager', holder: null, extra: true },
      { post: null, holder: null, extra: false },
    ]);
  });

  /** Four people behind the bar and nobody running it is still short. */
  it('calls a slot short while a post’s required seat is empty', () => {
    const slot = slotWith(
      [placed(0, null), placed(1, null)],
      new Map([
        ['bar-post', { min: 2, max: null }],
        [MANAGER.id, { min: 1, max: 1 }],
      ]),
      [MANAGER],
    );

    expect(slot === undefined ? null : slotState(slot)).toBe('short');
  });

  /** A post deleted since the roster was read leaves its holder on the
   * zone's shift (`ON DELETE SET NULL`), and the board says the same. */
  it('seats the holder of a post it does not know as the zone’s', () => {
    const slot = slotWith(
      [placed(0, 'gone-post', 'Alex')],
      new Map([['bar-post', { min: 1, max: 1 }]]),
      [],
    );

    expect(layout(slot)).toStrictEqual([
      { post: null, holder: 'Alex', extra: false },
    ]);
  });

  it('keys a post seat by its post, so focus survives a re-render', () => {
    const slot = slotWith(
      [],
      new Map([
        ['bar-post', { min: 2, max: null }],
        [MANAGER.id, { min: 1, max: 1 }],
      ]),
      [MANAGER],
    );

    expect(slot?.seats.map((seat) => [seat.key, seat.postId])).toStrictEqual([
      ['shift-1:manager-post:0', 'manager-post'],
      ['shift-1:zone:0', null],
    ]);
  });
});

describe('slotState', () => {
  function stateOf(requiredCount: number, placed: number): string {
    const assignments = Array.from({ length: placed }, (_unused, index) =>
      assignment({
        id: `assignment-${String(index)}`,
        participation_id: `participation-${String(index)}`,
        volunteer_id: `volunteer-${String(index)}`,
      }),
    );
    const [row] = rosterRows(
      [missionRow([run([barShift({ requiredCount })])])],
      assignments,
      NOBODY,
    );
    const slot = row?.slots[0];
    return slot === undefined ? 'missing' : slotState(slot);
  }

  it('calls an untouched slot empty and a partly staffed one short', () => {
    expect(stateOf(2, 0)).toBe('empty');
    expect(stateOf(2, 1)).toBe('short');
  });

  it('distinguishes staffed from over-staffed', () => {
    expect(stateOf(2, 2)).toBe('full');
    expect(stateOf(2, 3)).toBe('over');
  });

  /** A slot that asks for nobody is not a hole. The schema allows
   * `required_count = 0` for a post that exists on the board without being
   * staffed, and reporting it as empty would put a permanent red mark on a
   * board whose whole job is showing where the real holes are. */
  it('does not call a slot that needs nobody a hole', () => {
    expect(stateOf(0, 0)).toBe('full');
  });
});

describe('rowCoverage', () => {
  it('sums what a mission needs against what it has', () => {
    const [row] = rosterRows(
      [
        missionRow([
          run([
            barShift({ id: 'shift-1', requiredCount: 2 }),
            barShift({
              id: 'shift-2',
              startMs: EVENING + 2 * HOUR,
              endMs: EVENING + 4 * HOUR,
              requiredCount: 3,
            }),
          ]),
        ]),
      ],
      [assignment()],
      NOBODY,
    );

    expect(row === undefined ? null : rowCoverage(row)).toStrictEqual({
      required: 5,
      filled: 1,
    });
  });
});

describe('candidatesFor', () => {
  const SLOT = {
    shiftId: 'shift-1',
    startMs: EVENING,
    endMs: EVENING + 2 * HOUR,
  };

  function declaring(
    id: string,
    name: string,
    windows: readonly {
      readonly kind: 'available' | 'unavailable';
      readonly fromHours: number;
      readonly toHours: number;
      readonly provenance?: 'declared' | 'submitted';
    }[],
  ): Participation {
    return person({
      id,
      volunteer_id: `volunteer-${id}`,
      display_name: name,
      availability: windows.map((window) => ({
        kind: window.kind,
        period: {
          start: iso(EVENING + window.fromHours * HOUR),
          end: iso(EVENING + window.toHours * HOUR),
        },
        ...(window.provenance === undefined
          ? {}
          : { provenance: window.provenance }),
      })),
    });
  }

  it('ranks who declared these hours above who said nothing', () => {
    const covered = declaring('p-covered', 'Alba', [
      { kind: 'available', fromHours: -1, toHours: 4 },
    ]);
    const partly = declaring('p-partly', 'Bastien', [
      { kind: 'available', fromHours: 1, toHours: 4 },
    ]);
    const silent = declaring('p-silent', 'Chloé', []);
    const refused = declaring('p-refused', 'Delmas', [
      { kind: 'unavailable', fromHours: 0, toHours: 1 },
    ]);

    const ranked = candidatesFor([refused, silent, partly, covered], [], SLOT);

    expect(ranked.map((candidate) => candidate.state)).toStrictEqual([
      'available',
      'partial',
      'unknown',
      'unavailable',
    ]);
    expect(ranked[0]?.name).toBe('Alba');
  });

  /** The boundary a naive comparison gets wrong: a window ending exactly when
   * the slot starts covers none of it. Half-open periods everywhere
   * (docs/04 §1). */
  it('does not count a window that only touches the slot', () => {
    const touching = declaring('p-touch', 'Enora', [
      { kind: 'available', fromHours: -2, toHours: 0 },
    ]);

    const [candidate] = candidatesFor([touching], [], SLOT);

    expect(candidate?.state).toBe('unknown');
  });

  /** A coordinator's own edit overrides an overlapping submitted window
   * rather than being read alongside it (`plan/roster.ts`'s `declaredState`,
   * following the exclusion constraint that now allows the two to overlap in
   * time — `evp-api`'s `WindowResponse` doc comment). */
  it('lets a declared window override an overlapping submitted one', () => {
    const overridden = declaring('p-overridden', 'Hoang', [
      { kind: 'available', fromHours: -1, toHours: 4, provenance: 'submitted' },
      { kind: 'unavailable', fromHours: 0, toHours: 1, provenance: 'declared' },
    ]);

    const [candidate] = candidatesFor([overridden], [], SLOT);

    expect(candidate?.state).toBe('unavailable');
  });

  /** Where the coordinator has not touched a stretch, what the volunteer
   * submitted still applies. */
  it('falls back to a submitted window outside anything declared', () => {
    const untouched = declaring('p-untouched', 'Idris', [
      { kind: 'available', fromHours: -1, toHours: 4, provenance: 'submitted' },
    ]);

    const [candidate] = candidatesFor([untouched], [], SLOT);

    expect(candidate?.state).toBe('available');
  });

  it('marks somebody already working overlapping hours as busy', () => {
    const elsewhere = assignment({
      id: 'assignment-elsewhere',
      shift_id: 'shift-other',
      participation_id: 'p-busy',
      volunteer_id: 'volunteer-p-busy',
      period: { start: iso(EVENING + HOUR), end: iso(EVENING + 3 * HOUR) },
    });
    const busy = declaring('p-busy', 'Fabien', [
      { kind: 'available', fromHours: -1, toHours: 6 },
    ]);

    const [candidate] = candidatesFor([busy], [elsewhere], SLOT);

    expect(candidate?.state).toBe('busy');
    expect(candidate === undefined ? true : isChoosable(candidate)).toBe(false);
  });

  /** Two consecutive shifts are the ordinary double shift, not a clash — the
   * same half-open rule the exclusion constraint applies. */
  it('does not call somebody busy for the shift that ends when this one starts', () => {
    const before = assignment({
      id: 'assignment-before',
      shift_id: 'shift-other',
      participation_id: 'p-free',
      volunteer_id: 'volunteer-p-free',
      period: { start: iso(EVENING - 2 * HOUR), end: iso(EVENING) },
    });
    const free = declaring('p-free', 'Gibson', []);

    const [candidate] = candidatesFor([free], [before], SLOT);

    expect(candidate?.state).toBe('unknown');
  });

  it("leaves out whoever is already in one of this slot's seats", () => {
    const seated = declaring('participation-1', 'Camille', []);
    const other = declaring('p-other', 'Irène', []);

    const ranked = candidatesFor([seated, other], [assignment()], SLOT);

    expect(ranked.map((candidate) => candidate.participationId)).toStrictEqual([
      'p-other',
    ]);
  });

  it('shows a withdrawn volunteer, and refuses to let them be chosen', () => {
    const gone = person({
      id: 'p-gone',
      volunteer_id: 'volunteer-gone',
      display_name: 'Jon',
      status: 'withdrawn',
      availability: [],
    });

    const [candidate] = candidatesFor([gone], [], SLOT);

    expect(candidate?.state).toBe('ineligible');
    expect(candidate === undefined ? true : isChoosable(candidate)).toBe(false);
  });

  it('orders equal states by name so a list does not reshuffle under a click', () => {
    const zoe = declaring('p-z', 'Zwickel Pauline', []);
    const amelie = declaring('p-a', 'Perret Amélie', []);

    const ranked = candidatesFor([zoe, amelie], [], SLOT);

    expect(ranked.map((candidate) => candidate.name)).toStrictEqual([
      'Perret Amélie',
      'Zwickel Pauline',
    ]);
  });
});
