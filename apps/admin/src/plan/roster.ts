// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The assignation grid: every shift as a stack of seats, and who may sit in
 * one.
 *
 * This is the spreadsheet's *assignation* sheet, which is where the real
 * planning happened: missions down the side, slots across the top, and a
 * column of names under each cell — one row per volunteer the post needs
 * (`docs/googleSheets/example_data`). The board draws that on the same
 * continuous time axis the shift board uses, so a slot's width is its length
 * and a coordinator can see that the 04:00 hole is four hours wide.
 *
 * Two things the spreadsheet could not do are the reason for this module
 * rather than a `v-for` in the view.
 *
 * **A seat knows whether it is a hole.** The mission's `min_volunteers` (or,
 * where it has said nothing, the shift's `required_count`) is what the post
 * needs; the seats beyond it are extra help, not a gap, and a board that drew
 * them the same way would report every fully-staffed bar as understaffed.
 *
 * **A candidate knows whether they can work.** The dropdown is ranked by what
 * the volunteer declared — availability windows are the whole reason the form
 * asks (docs/09 §3) — and anybody already working those hours is marked as
 * such rather than silently offered and then refused by the database. That is
 * advisory and says so: the exclusion constraint is the authority (docs/02
 * §5), and between rendering this list and clicking it another coordinator may
 * have taken the slot.
 *
 * Pure, over the board's own vocabulary (`board/runs.ts`) rather than over API
 * rows, and test-first: "which names does a coordinator see, in what order" is
 * the decision this page *is*, and it is not a thing to check by looking.
 */
import { Temporal } from '@evp/shared/time';

import type { Assignment } from '../api/assignments';
import type { Participation } from '../api/participations';
import { packLanes } from '../board/lanes';
import type { MissionRow } from '../board/runs';
import type { VolunteerBounds } from './missions';

/** `Date.parse` is banned (docs/16 §4): it accepts strings that are not RFC
 * 3339 and answers `NaN` for the rest, which here would be a window silently
 * covering nothing. */
function msOf(iso: string): number {
  return Temporal.Instant.from(iso).epochMilliseconds;
}

/** One volunteer in one seat. */
export interface SeatHolder {
  readonly assignmentId: string;
  readonly participationId: string;
  readonly volunteerId: string;
  /** The roster label as stored, or the volunteer's id when the roster for
   * that day could not be loaded — a name nobody can read is still better
   * than a seat that looks empty when it is not. */
  readonly name: string;
  /** The row version, for the `If-Match` a cancellation carries. */
  readonly version: number;
}

export interface Seat {
  /** Stable across a re-render, so focus survives one: the shift and the
   * position, never the assignment id — the id changes when somebody is
   * replaced, and the seat under the coordinator's cursor does not. */
  readonly key: string;
  readonly index: number;
  readonly holder: SeatHolder | null;
  /**
   * This seat is beyond what the slot requires.
   *
   * Drawn differently because it means something different: an empty extra
   * seat is an invitation, an empty *required* seat is a hole in the plan and
   * the thing the coordinator opened this page to find.
   */
  readonly extra: boolean;
}

export interface Slot {
  readonly key: string;
  readonly shiftId: string;
  readonly eventId: string;
  readonly eventName: string;
  readonly timezone: string;
  /** The event's palette index — the same colour its line has on the strip
   * above and its bar has on the shift board. */
  readonly color: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly requiredCount: number;
  readonly maxCount: number | null;
  readonly seats: readonly Seat[];
  readonly filled: number;
  /** Which sub-row of its mission this slot sits on — two days that run at the
   * same time do not share one. */
  readonly laneRow: number;
  /** How many seats are stacked above this slot's first one, counting every
   * lane row before it. The view's vertical offset, in seats. */
  readonly seatOffset: number;
}

export interface RosterRow {
  readonly key: string;
  readonly name: string;
  readonly alsoAtDays: number;
  readonly slots: readonly Slot[];
  /** How many seats tall this mission's line is, all lane rows together. */
  readonly seatRows: number;
  /** How many lane rows it took. One for the ordinary mission; more only
   * where two days run the post at the same time. The view needs it because
   * each lane carries its own label strip above its seats. */
  readonly laneCount: number;
}

/** How a slot stands against what it asked for. Never colour alone in the
 * view: each of these is also a word (docs/14 §2). */
export type SlotState = 'empty' | 'short' | 'full' | 'over';

export function slotState(slot: Slot): SlotState {
  if (slot.filled === 0 && slot.requiredCount > 0) {
    return 'empty';
  }
  if (slot.filled < slot.requiredCount) {
    return 'short';
  }
  return slot.filled > slot.requiredCount ? 'over' : 'full';
}

/**
 * Whether a slot may take one more name.
 *
 * `max_count` is the post's ceiling and `null` means there is none — six
 * people on a bar that asked for four is a real Saturday, and the schema
 * permits it. A slot at its ceiling offers no empty seat, because offering one
 * would be offering a click the database refuses.
 */
function roomFor(
  filled: number,
  requiredCount: number,
  maxCount: number | null,
): number {
  // No spare seat while a required one is still empty: an "add somebody
  // (extra)" beside a hole invites filling the extra first, and a slot that
  // reads 3/4 with a spare on offer looks optional when it is short.
  if (filled < requiredCount) {
    return requiredCount;
  }
  if (maxCount !== null && filled >= maxCount) {
    return filled;
  }
  // One spare seat past the requirement, never more: the page is a grid, and
  // a column of empty dropdowns under every full slot would triple its height
  // to say "you could add somebody".
  return filled + 1;
}

function seatsOf(
  shiftId: string,
  holders: readonly SeatHolder[],
  requiredCount: number,
  maxCount: number | null,
): readonly Seat[] {
  const total = roomFor(holders.length, requiredCount, maxCount);
  return Array.from({ length: total }, (_unused, index): Seat => {
    const holder = holders[index] ?? null;
    return {
      key: `${shiftId}:${String(index)}`,
      index,
      holder,
      extra: index >= requiredCount,
    };
  });
}

/** The display name for a placement, from the day's own roster. */
function nameOf(
  participants: ReadonlyMap<string, readonly Participation[]>,
  assignment: Assignment,
): string {
  const found = participants
    .get(assignment.event_id)
    ?.find((person) => person.id === assignment.participation_id);
  return found?.display_name ?? assignment.volunteer_id;
}

/**
 * Every mission as a line of slots, laid on the shared axis.
 *
 * Built from the *shifts* rather than from the bars the shift board draws: a
 * bar is a run of touching shifts (`board/runs.ts`) and staffing is decided
 * per shift — 18:00–20:00 and 20:00–22:00 at one post are two different
 * people's evenings, which is the whole reason the schedule is cut up at all.
 */
export function rosterRows(
  rows: readonly MissionRow[],
  assignments: readonly Assignment[],
  participants: ReadonlyMap<string, readonly Participation[]>,
  bounds: ReadonlyMap<string, VolunteerBounds> = new Map(),
): readonly RosterRow[] {
  const byShift = new Map<string, SeatHolder[]>();
  for (const assignment of assignments) {
    const holders = byShift.get(assignment.shift_id) ?? [];
    holders.push({
      assignmentId: assignment.id,
      participationId: assignment.participation_id,
      volunteerId: assignment.volunteer_id,
      name: nameOf(participants, assignment),
      version: assignment.version,
    });
    byShift.set(assignment.shift_id, holders);
  }

  return rows.map((row): RosterRow => {
    const flat = row.runs.flatMap((run) =>
      run.shifts.map((shift) => {
        // Sorted by name so that a slot's names do not reshuffle when the
        // roster is re-read: `assigned_at` order would be stable too, but a
        // column of six names a coordinator reads down is a column they expect
        // to find alphabetised.
        const holders = [...(byShift.get(shift.id) ?? [])].sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
        );
        // The mission's own min/max win over the shift's count where they
        // are set: the shift board cuts every new slot at `required_count =
        // 1`, so that number is usually a default nobody chose, while "Bar
        // needs four" is the coordinator's actual answer. The shift's count
        // is what is left when the mission has said nothing.
        const own = bounds.get(run.locationId);
        return {
          shiftId: shift.id,
          eventId: run.eventId,
          eventName: run.eventName,
          timezone: run.timezone,
          color: run.color,
          startMs: shift.startMs,
          endMs: shift.endMs,
          requiredCount: own?.min ?? shift.requiredCount,
          maxCount: own?.max ?? shift.maxCount,
          holders,
        };
      }),
    );

    // Same packing the shift board uses, and for the same reason: two days of
    // one festival may genuinely run a post at the same time, and one column
    // of names drawn over another is the board hiding what it exists to show.
    const packed = packLanes(flat, (slot) => ({
      startMs: slot.startMs,
      endMs: slot.endMs,
      key: slot.shiftId,
    }));

    const seatsPerSlot = new Map<string, number>();
    for (const lane of packed.lanes) {
      seatsPerSlot.set(
        lane.item.shiftId,
        roomFor(
          lane.item.holders.length,
          lane.item.requiredCount,
          lane.item.maxCount,
        ),
      );
    }

    // A lane row is as tall as its tallest slot, not as the row's tallest
    // anywhere: a mission with one eight-person night would otherwise be eight
    // seats tall on every other day of the festival.
    const laneHeights: number[] = Array.from(
      { length: Math.max(packed.rowCount, 1) },
      () => 1,
    );
    for (const lane of packed.lanes) {
      laneHeights[lane.row] = Math.max(
        laneHeights[lane.row] ?? 1,
        seatsPerSlot.get(lane.item.shiftId) ?? 1,
      );
    }
    const laneOffsets = laneHeights.map((_height, index) =>
      laneHeights.slice(0, index).reduce((total, height) => total + height, 0),
    );

    const slots = packed.lanes.map(({ item, row }): Slot => {
      const seats = seatsOf(
        item.shiftId,
        item.holders,
        item.requiredCount,
        item.maxCount,
      );
      return {
        key: item.shiftId,
        shiftId: item.shiftId,
        eventId: item.eventId,
        eventName: item.eventName,
        timezone: item.timezone,
        color: item.color,
        startMs: item.startMs,
        endMs: item.endMs,
        requiredCount: item.requiredCount,
        maxCount: item.maxCount,
        seats,
        filled: item.holders.length,
        laneRow: row,
        seatOffset: laneOffsets[row] ?? 0,
      };
    });

    return {
      key: row.key,
      name: row.name,
      alsoAtDays: row.alsoAtDays,
      // Chronological: the line reads left to right whatever order the days
      // were fetched in.
      slots: [...slots].sort((a, b) => a.startMs - b.startMs),
      seatRows: laneHeights.reduce((total, height) => total + height, 0),
      laneCount: laneHeights.length,
    };
  });
}

// ---------------------------------------------------------------------------
// Who may sit in a seat
// ---------------------------------------------------------------------------

/**
 * What the board knows about a candidate for one slot.
 *
 * `busy` and `ineligible` are the two that cannot be chosen. Both are shown
 * anyway: "why is Chloé not in the list?" is a question a coordinator
 * otherwise answers by opening the spreadsheet this application replaced.
 */
export type CandidateState =
  /** Declared a window covering the whole slot. */
  | 'available'
  /** Declared a window covering part of it — they can do some of these hours,
   * which is a conversation, not a refusal. */
  | 'partial'
  /** Said nothing about these hours. Not the same as free (docs/03 §3.5). */
  | 'unknown'
  /** Declared themselves unavailable across some of it. */
  | 'unavailable'
  /** Already working something that overlaps. The database will refuse this,
   * and saying so before the click is the difference between a board and a
   * form that argues back. */
  | 'busy'
  /** Declined or withdrew from this edition. A constraint trigger refuses it. */
  | 'ineligible';

export interface Candidate {
  readonly participationId: string;
  readonly name: string;
  readonly state: CandidateState;
}

/** The order the dropdown lists them in: who can work these hours, then who
 * has not said, then who cannot. */
const STATE_ORDER: readonly CandidateState[] = [
  'available',
  'partial',
  'unknown',
  'unavailable',
  'busy',
  'ineligible',
];

function overlaps(
  a: { readonly startMs: number; readonly endMs: number },
  b: { readonly startMs: number; readonly endMs: number },
): boolean {
  // Half-open on both sides, as every period on the wire is (docs/04 §1): a
  // window ending exactly when the slot starts does not cover any of it, and
  // two consecutive shifts are not a double-booking.
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

function covers(
  outer: { readonly startMs: number; readonly endMs: number },
  inner: { readonly startMs: number; readonly endMs: number },
): boolean {
  return outer.startMs <= inner.startMs && outer.endMs >= inner.endMs;
}

function declaredState(
  person: Participation,
  slot: { readonly startMs: number; readonly endMs: number },
): CandidateState {
  const windows = person.availability.map((window) => ({
    kind: window.kind,
    // Windows built before `provenance` existed mean what they always did: a
    // coordinator's own declaration (`api/participations.ts`'s `windowSchema`
    // doc comment).
    provenance: window.provenance ?? 'declared',
    startMs: msOf(window.period.start),
    endMs: msOf(window.period.end),
  }));

  // A coordinator's declared window may now overlap a submitted one in time —
  // that is an override, not a contradiction (`evp-api`'s `WindowResponse`
  // doc comment) — so where a declared window touches this slot at all, it is
  // the whole answer for the slot and the submitted windows are set aside.
  // Only when the coordinator has said nothing about this stretch does what
  // the volunteer submitted apply.
  const touching = windows.filter((window) => overlaps(window, slot));
  const relevant = touching.some((window) => window.provenance === 'declared')
    ? touching.filter((window) => window.provenance === 'declared')
    : touching;

  // An `unavailable` window wins over an `available` one it overlaps. Two
  // windows of the *same* provenance can never both match here — the schema
  // forbids overlap within one provenance — so the two can only both match by
  // covering different parts of the slot, and "I cannot do the first two
  // hours" is the answer that matters.
  if (relevant.some((window) => window.kind === 'unavailable')) {
    return 'unavailable';
  }
  const free = relevant.filter((window) => window.kind === 'available');
  if (free.some((window) => covers(window, slot))) {
    return 'available';
  }
  return free.length > 0 ? 'partial' : 'unknown';
}

/**
 * Who a coordinator may put in this slot, best first.
 *
 * `assignments` is every live placement in view, not only this day's: nobody
 * is in two places at once *across the deployment* (docs/03 §3.6), so an
 * afterparty that laps the club night has to see the club night's roster to
 * mark the right people busy.
 *
 * Whoever is already in one of this slot's seats is left out — they are on
 * screen already, in their own seat, and a dropdown that offered them again
 * would be offering the duplicate the database refuses.
 */
export function candidatesFor(
  people: readonly Participation[],
  assignments: readonly Assignment[],
  slot: {
    readonly shiftId: string;
    readonly startMs: number;
    readonly endMs: number;
  },
): readonly Candidate[] {
  const here = new Set(
    assignments
      .filter((assignment) => assignment.shift_id === slot.shiftId)
      .map((assignment) => assignment.participation_id),
  );

  const busy = new Set(
    assignments
      .filter(
        (assignment) =>
          assignment.shift_id !== slot.shiftId &&
          overlaps(
            {
              startMs: msOf(assignment.period.start),
              endMs: msOf(assignment.period.end),
            },
            slot,
          ),
      )
      .map((assignment) => assignment.volunteer_id),
  );

  const candidates = people
    .filter((person) => !here.has(person.id))
    .map((person): Candidate => {
      const state: CandidateState =
        person.status === 'declined' || person.status === 'withdrawn'
          ? 'ineligible'
          : busy.has(person.volunteer_id)
            ? 'busy'
            : declaredState(person, slot);
      return { participationId: person.id, name: person.display_name, state };
    });

  // Sorted by state, then by name — and by id under equal names, because six
  // hundred volunteers contain two Camilles and a list that reordered them
  // between renders would move the one a coordinator was about to click.
  return [...candidates].sort(
    (a, b) =>
      STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
      (a.participationId < b.participationId ? -1 : 1),
  );
}

/** Whether a candidate can actually be chosen. The two refused states are
 * rendered as disabled options rather than hidden ones. */
export function isChoosable(candidate: Candidate): boolean {
  return candidate.state !== 'busy' && candidate.state !== 'ineligible';
}

/** How many of a row's seats are required and how many are filled — the count
 * the gutter shows, which is the answer to "is this mission staffed?". */
export function rowCoverage(row: RosterRow): {
  readonly required: number;
  readonly filled: number;
} {
  return row.slots.reduce(
    (total, slot) => ({
      required: total.required + slot.requiredCount,
      filled: total.filled + slot.filled,
    }),
    { required: 0, filled: 0 },
  );
}
