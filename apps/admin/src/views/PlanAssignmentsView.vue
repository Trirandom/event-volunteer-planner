<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * The assignation board: missions down, time across, a name in every seat.
 *
 * This is the sheet the whole spreadsheet existed for
 * (`docs/googleSheets/example_data/… - assignation.csv`): missions down the
 * side, slots across the top, and under each cell a column of dropdowns — one
 * per volunteer that post needs at that hour. A coordinator staffs a festival
 * by reading down those columns, and the thing they are looking for is the
 * empty one.
 *
 * It is drawn on the *same* axis as the shift board next door — the same
 * continuous time scale, the same coloured line per day, the same `⋯` over
 * hours nobody works (`board/useAxis.ts`) — because the two pages are one
 * task. A hole is found here and cut differently there, and an axis that
 * folded a different stretch of night on each would make them two different
 * festivals.
 *
 * **A combobox per seat, built by hand — supersedes ADR-0017.** ADR-0017
 * chose a native `select` for this exact spot, for a good reason: it is
 * reachable by keyboard and touch for free, and types-to-search six hundred
 * names without a line of code. What it does not do is share the seat with
 * anything else — once its own popup is visibly open, the browser hands that
 * popup *all* keyboard and pointer input and nothing behind it, including
 * `Ctrl`/`Cmd`+`C`/`V`, `Delete` and a drag started from the same seat, ever
 * reaches this page's own code. That is a platform limitation, not a bug
 * here, and no amount of application code closes it while a native `select`
 * is doing the choosing. So the seat is a `role="combobox"` trigger button
 * plus a `role="listbox"` this page owns outright (`onTriggerKeydown`
 * reimplements arrow/Home/End/Enter/Escape/type-ahead navigation) — every
 * key and every drag reaches this page's handlers at every moment, popup
 * open or not, because there is no browser-native popup to hand them to
 * instead. A new ADR should record this supersession; this comment is not
 * that ADR.
 *
 * **The options are ranked by what the volunteer declared** and whoever is
 * already working those hours is marked busy rather than silently offered
 * (`plan/roster.ts`). That ranking is advisory and nothing else: three hard
 * rules guard this write in PostgreSQL (docs/02 §5), the exclusion constraint
 * is the authority, and between rendering a list and clicking it another
 * coordinator may have taken the slot. A refusal is therefore a normal
 * outcome, pinned over the board (`ToastStack`) until it is dismissed rather
 * than as a toast that times out.
 *
 * **Drag a seat onto another; `Ctrl`/`Cmd`+`C`/`V` do the same by keyboard.**
 * The trigger itself is the drag handle once it holds somebody — no separate
 * grip or paste button, which was more chrome than a seat this small could
 * carry. A plain drop moves; holding `Ctrl` (or `Alt`/`Option` on macOS) at
 * the drop copies instead, the platform's own file-drag convention, and the
 * pointer's only way to duplicate now that there is no button for it
 * (`onSeatDrop`). `Delete`/`Backspace` clears a focused seat the same way the
 * "— remove —" option does. Unlike the native `select` this replaced, every
 * one of these keeps working while the list is open, because that list is
 * this page's own markup.
 *
 * **Options are built only for the seat being used.** Six hundred volunteers
 * times two hundred visible seats is a hundred and twenty thousand option
 * rows, which is not a page. A seat's list is computed only when it is
 * opened, and only one seat is open at a time.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { RouterLink } from 'vue-router';

import HelpModal from '../components/HelpModal.vue';
import ToastMessage from '../components/ToastMessage.vue';
import ToastStack from '../components/ToastStack.vue';
import type { AssignmentRejection } from '../api/assignments';
import { useApplyRosterOps, type RosterOp } from '../api/useAssignmentWrites';
import { useMissionBoard, usePlanScope } from '../api/usePlan';
import { useRoster } from '../api/useRoster';
import { missionRows, type EventWindow } from '../board/runs';
import { useAxis } from '../board/useAxis';
import { locale, t } from '../i18n';
import { narrowToEvent } from '../plan/missions';
import {
  candidatesFor,
  isChoosable,
  rosterRows,
  rowCoverage,
  slotState,
  type Candidate,
  type RosterRow,
  type Seat,
  type Slot,
} from '../plan/roster';
import { focusedEventId } from '../plan/scope';
import { useRouteParam } from '../router/params';
import { useBoardStore } from '../stores/board';
import { Temporal } from '@evp/shared/time';
import { eventColor } from '@evp/shared';

/**
 * One seat's height, in `rem` so the grid scales with the viewer's text size
 * (docs/14 §2). Tall enough for a `select` that clears the 24 px target floor.
 */
const SEAT_REM = 1.75;

/** The strip above each lane's seats, where the slot says its hours and how
 * many of them are covered. One per lane row, not one per mission: two days
 * running a post at once each need their own label. */
const LANE_LABEL_REM = 1;

const orgId = useRouteParam('orgId');
const festivalId = useRouteParam('festivalId');
const eventId = useRouteParam('eventId');

/** The sections this page sends a coordinator to when there is nothing to
 * staff, at whatever scope they are reading — the same "this section, at that
 * scope" pairing the rail makes (`PlanDetailView.vue`). */
const shiftsRoute = computed(() =>
  eventId.value === '' ? 'org-festival-shifts' : 'org-event-shifts',
);
const missionsRoute = computed(() =>
  eventId.value === '' ? 'org-festival-missions' : 'org-event-missions',
);
const scopeParams = computed(() =>
  eventId.value === ''
    ? { orgId: orgId.value, festivalId: festivalId.value }
    : { orgId: orgId.value, eventId: eventId.value },
);

const board = useBoardStore();

const { scope, isPending: scopePending } = usePlanScope(
  orgId,
  festivalId,
  eventId,
);

/** `Date.parse` is banned (docs/16 §4): it accepts strings that are not RFC
 * 3339 and answers `NaN` for the rest, which here would be a whole day
 * silently laid at the left edge of the epoch. */
function instantOf(iso: string): number {
  return Temporal.Instant.from(iso).epochMilliseconds;
}

const days = computed(() => scope.value?.days ?? []);
const focus = computed(() =>
  scope.value === null ? null : focusedEventId(scope.value),
);

/** Narrowed to one day, only that day is laid on the axis — a festival-wide
 * axis under one day of work is six days of white space. */
const visibleEvents = computed(() => {
  const only = focus.value;
  return only === null
    ? days.value
    : days.value.filter((day) => day.id === only);
});

const {
  board: missionBoard,
  bounds,
  isPending: boardPending,
  locationsFailed,
  shiftsFailed,
} = useMissionBoard(orgId, days);

const {
  participants,
  assignments,
  isPending: rosterPending,
  participantsFailed,
  assignmentsFailed,
} = useRoster(orgId, visibleEvents);

const visibleBoard = computed(() => {
  const only = focus.value;
  return only === null
    ? missionBoard.value
    : narrowToEvent(missionBoard.value, only);
});

const windows = computed<readonly EventWindow[]>(() =>
  visibleEvents.value.map((day) => ({
    id: day.id,
    name: day.name,
    timezone: day.timezone,
    startMs: instantOf(day.period.start),
    endMs: instantOf(day.period.end),
    version: day.version,
    color: day.color,
    publicStartMs:
      day.public_period === undefined
        ? null
        : instantOf(day.public_period.start),
    publicEndMs:
      day.public_period === undefined ? null : instantOf(day.public_period.end),
  })),
);

/**
 * One line, one clock. A festival spanning two zones cannot be ruled out and
 * the festival's own zone is the only single answer for a shared axis; each
 * slot still announces the zone it is genuinely worked in, which is the
 * reading docs/16 §1 cares about.
 */
const axisClock = computed(
  () =>
    scope.value?.selected?.timezone ?? scope.value?.festival?.timezone ?? 'UTC',
);

/**
 * The blank ends of the axis exist so the shift board's edge drag has
 * somewhere to reach (`AXIS_MARGIN_MINUTES`, two hours). Nothing on this page
 * drags a shift's edge, so that reach buys nothing here but scrollable dead
 * space — 15 minutes is small at every zoom this board offers and still
 * leaves the "there is time past closing" affordance the margin also draws.
 */
const ASSIGNMENTS_MARGIN_MINUTES = 15;

const {
  laneWidth,
  axisHeight,
  axisTimezone,
  bands,
  ticks,
  margins,
  foldMarks,
  openedMarks,
  publicMarks,
  strip,
  toggleFold,
  boxStyle,
  atStyle,
  eventLineStyle,
  clockAt,
} = useAxis({
  windows,
  timezone: axisClock,
  locale,
  marginMinutes: ASSIGNMENTS_MARGIN_MINUTES,
});

const allRows = computed(() =>
  rosterRows(
    missionRows(visibleBoard.value, windows.value),
    assignments.value,
    participants.value,
    bounds.value,
  ),
);

/**
 * "Show me what is not staffed yet."
 *
 * The one filter worth a control on this page, because it is the question a
 * coordinator opens it with three days out. Off by default: a board that
 * hides most of itself until you notice a checkbox is a board that has been
 * lying about how much work there is.
 */
const onlyGaps = ref(false);

function needsSomebody(row: RosterRow): boolean {
  return row.slots.some((slot) => {
    const state = slotState(slot);
    return state === 'empty' || state === 'short';
  });
}

const rows = computed(() =>
  onlyGaps.value ? allRows.value.filter(needsSomebody) : allRows.value,
);

/** How much of the whole board is covered — the sentence a coordinator reads
 * first, and the one they report upwards. */
const coverage = computed(() =>
  allRows.value.reduce(
    (total, row) => {
      const row_total = rowCoverage(row);
      return {
        required: total.required + row_total.required,
        filled: total.filled + row_total.filled,
      };
    },
    { required: 0, filled: 0 },
  ),
);

const isPending = computed(
  () => scopePending.value || boardPending.value || rosterPending.value,
);

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function laneHeight(row: RosterRow): string {
  return `${String(row.seatRows * SEAT_REM + row.laneCount * LANE_LABEL_REM)}rem`;
}

/**
 * Where a slot's box sits: its hours horizontally, and vertically the seats of
 * every lane above it plus one label strip per lane, including its own.
 */
function slotStyle(slot: Slot): Record<string, string> {
  return {
    ...boxStyle(slot.startMs, slot.endMs),
    top: `${String(slot.seatOffset * SEAT_REM + slot.laneRow * LANE_LABEL_REM)}rem`,
    height: `${String(slot.seats.length * SEAT_REM + LANE_LABEL_REM)}rem`,
    // The day's own colour, the same one its line carries on the strip above.
    // A custom property rather than a `background`, because the stylesheet
    // spends it on the left edge and on the label and only it knows which.
    '--evp-slot-color': eventColor(slot.color),
  };
}

function slotHours(slot: Slot): string {
  return `${clockAt(slot.startMs, slot.timezone)}–${clockAt(slot.endMs, slot.timezone)}`;
}

/** The count in the corner of every slot: what it has against what it asked
 * for. Never the colour alone (docs/14 §2) — this is the same fact in words. */
function slotCount(slot: Slot): string {
  return `${String(slot.filled)}/${String(slot.requiredCount)}`;
}

/** What a seat says to a screen reader. The mission, the day, the hours and
 * the zone they are worked in — never the viewer's. */
function seatLabel(row: RosterRow, slot: Slot, seat: Seat): string {
  return t('assignments.seat.label', {
    mission: row.name,
    event: slot.eventName,
    hours: slotHours(slot),
    timezone: slot.timezone,
    position: seat.index + 1,
    total: slot.seats.length,
  });
}

// ---------------------------------------------------------------------------
// The combobox
// ---------------------------------------------------------------------------

/**
 * Which seat's listbox is open, and where it's built.
 *
 * A hundred and twenty thousand option rows is not a page, so a seat's list
 * is computed only once it is opened (`seatOptions`), and only one seat is
 * ever open at a time — opening a second one silently closes the first,
 * because they share this one ref.
 */
const openSeat = ref<string | null>(null);
const activeIndex = ref(0);
const comboPosition = ref<{
  readonly top: number;
  readonly left: number;
  readonly width: number;
} | null>(null);

/** The roster of the day this slot belongs to. Per event, because enrolment is
 * (`api/participations.ts`): somebody who signed up for Saturday is not a
 * candidate for Sunday, and the server refuses it. */
function candidates(slot: Slot): readonly Candidate[] {
  return candidatesFor(
    participants.value.get(slot.eventId) ?? [],
    assignments.value,
    slot,
  );
}

/** Why a name cannot be chosen, or what it promises — in words, in the option
 * itself, because that is the only place left to put it. */
function candidateLabel(candidate: Candidate): string {
  // One message with a `select` over the state rather than a name glued to a
  // translated note: the two may need a different order in another language.
  return t('assignments.seat.candidate', {
    name: candidate.name,
    state: candidate.state,
  });
}

interface SeatOption {
  readonly value: string;
  readonly label: string;
  readonly name: string;
  readonly disabled: boolean;
}

/** Every row a seat's listbox can show, in the order they were always
 * offered in: the empty choice, whoever is already in the seat (left out of
 * `candidates` on purpose — they are on screen already), the write still
 * settling if there is one, then the ranked candidates. */
function seatOptions(slot: Slot, seat: Seat): readonly SeatOption[] {
  const options: SeatOption[] = [
    { value: '', label: emptyOptionLabel(seat), name: '', disabled: false },
  ];
  if (seat.holder !== null) {
    options.push({
      value: seat.holder.participationId,
      label: seat.holder.name,
      name: seat.holder.name,
      disabled: false,
    });
  }
  const held = settlingName(seat);
  if (held !== null) {
    options.push({
      value: seatValue(seat),
      label: t('assignments.seat.saving', { name: held }),
      name: held,
      disabled: true,
    });
  }
  for (const candidate of candidates(slot)) {
    options.push({
      value: candidate.participationId,
      label: candidateLabel(candidate),
      name: candidate.name,
      disabled: !isChoosable(candidate),
    });
  }
  return options;
}

function listboxId(seat: Seat): string {
  return `seat-${seat.key}-listbox`;
}

function optionId(seat: Seat, index: number): string {
  return `seat-${seat.key}-option-${String(index)}`;
}

/** What the trigger button shows while its listbox is closed — the same
 * three states the closed native `select` used to render. */
function seatTriggerLabel(seat: Seat): string {
  const held = settlingName(seat);
  if (held !== null) {
    return t('assignments.seat.saving', { name: held });
  }
  return seat.holder !== null ? seat.holder.name : emptyOptionLabel(seat);
}

function openCombo(slot: Slot, seat: Seat, trigger: HTMLElement): void {
  const rect = trigger.getBoundingClientRect();
  openSeat.value = seat.key;
  comboPosition.value = {
    top: rect.bottom,
    left: rect.left,
    width: rect.width,
  };
  const options = seatOptions(slot, seat);
  const current = seatValue(seat);
  const index = options.findIndex((option) => option.value === current);
  activeIndex.value = index === -1 ? 0 : index;
}

function closeCombo(seat: Seat): void {
  if (openSeat.value === seat.key) {
    openSeat.value = null;
    comboPosition.value = null;
  }
}

/** The board scrolls sideways under a fixed-position listbox that was placed
 * relative to the viewport at the moment it opened; rather than tracking that
 * drift, the listbox just closes, the same way a native popup would have
 * been torn down by the scroll that moved its anchor out from under it. */
function onBoardScroll(): void {
  openSeat.value = null;
  comboPosition.value = null;
}

/** Closes whichever seat is open when a mousedown lands outside its trigger
 * and outside its (teleported) listbox — the two are exempted because their
 * own handlers decide what a click on them means. */
function onDocumentMousedown(event: MouseEvent): void {
  if (openSeat.value === null) {
    return;
  }
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  if (
    target.closest('.evp-seat-select') !== null ||
    target.closest('.evp-seat-listbox') !== null
  ) {
    return;
  }
  comboPosition.value = null;
  openSeat.value = null;
}

onMounted(() => {
  document.addEventListener('mousedown', onDocumentMousedown);
});

onUnmounted(() => {
  document.removeEventListener('mousedown', onDocumentMousedown);
});

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const apply = useApplyRosterOps(orgId);
const isSaving = computed(() => apply.isPending.value);

/** What the last write did. docs/02 §7 is explicit that a rejection is
 * explained, not shown as a toast that scrolls away and is missed — it still
 * is, in `toasts` below, just relocated off the board's own flow so it never
 * pushes a row out from under a coordinator mid-click; it stays until it is
 * dismissed or superseded, never on a timer. */
const lastRejection = ref<AssignmentRejection | null>(null);
const partial = ref<number | null>(null);

/**
 * A seat shown holding somebody the server has not confirmed yet.
 *
 * Without it the `select` snaps back to the stored name for the length of the
 * round trip, which reads as the board refusing the choice — so the
 * coordinator picks again, against a roster that is already being changed.
 * One at a time is enough: every seat is disabled while a write is in flight.
 */
const settling = ref<{
  readonly seatKey: string;
  readonly participationId: string;
  readonly name: string;
} | null>(null);

/** What a seat's `select` is showing: the choice being written, else whoever
 * the roster says is in it, else nobody. */
function seatValue(seat: Seat): string {
  const held = settling.value;
  return held !== null && held.seatKey === seat.key
    ? held.participationId
    : (seat.holder?.participationId ?? '');
}

function settlingName(seat: Seat): string | null {
  const held = settling.value;
  return held !== null && held.seatKey === seat.key ? held.name : null;
}

/**
 * What the empty choice means for this seat.
 *
 * The same value (`''`) both clears a filled seat and leaves an empty one
 * alone, so it cannot carry one label for both without lying to whichever
 * case it is not — "add somebody" on a filled seat reads as an invitation
 * when picking it is actually the removal.
 */
function emptyOptionLabel(seat: Seat): string {
  if (seatValue(seat) !== '') {
    return t('assignments.seat.remove');
  }
  return seat.extra
    ? t('assignments.seat.addExtra')
    : t('assignments.seat.nobodyYet');
}

/**
 * The sentence a refusal is explained with.
 *
 * Only the unreachable server is this page's own to word. The hard rules all
 * arrive as one problem type (`validation-failed`) whose three cases — already
 * working, withdrawn, enrolled on another day — differ only in the server's
 * prose, so that prose is shown as it comes rather than guessed at from its
 * wording (`api/assignments.ts`).
 */
function rejectionText(rejection: AssignmentRejection): string {
  return rejection.reason === 'unavailable'
    ? t('assignments.rejection.unavailable')
    : rejection.detail;
}

async function run(ops: readonly RosterOp[]): Promise<void> {
  if (ops.length === 0) {
    return;
  }
  lastRejection.value = null;
  partial.value = null;

  const outcome = await apply.mutateAsync(ops);
  if (outcome.rejection !== null) {
    lastRejection.value = outcome.rejection;
    // A replace is a cancellation and then a placement (`useAssignmentWrites`).
    // If the second half was refused the seat really is empty now, and saying
    // so is the difference between a board that reports the truth and one a
    // coordinator finds out about on the night.
    partial.value = outcome.applied === 0 ? null : outcome.applied;
  }
}

/**
 * A seat changed: nobody → somebody, somebody → nobody, or one name for
 * another.
 *
 * The replace is a cancel *then* an assign, in that order and never in
 * parallel: the outgoing placement holds the hours the incoming one wants, so
 * sending both at once means the exclusion constraint refuses the new name for
 * clashing with the person it is replacing. Shared by the `select` itself and
 * by copy/paste and drag, which all end at the same write.
 */
async function changeSeat(
  slot: Slot,
  seat: Seat,
  chosen: string,
  chosenName: string,
): Promise<void> {
  const holder = seat.holder;
  if (holder?.participationId === chosen) {
    return;
  }

  const ops: RosterOp[] = [];
  if (holder !== null) {
    ops.push({
      kind: 'cancel',
      eventId: slot.eventId,
      assignmentId: holder.assignmentId,
      version: holder.version,
    });
  }
  if (chosen !== '') {
    ops.push({
      kind: 'assign',
      eventId: slot.eventId,
      shiftId: slot.shiftId,
      participationId: chosen,
    });
  }

  settling.value =
    chosen === ''
      ? null
      : { seatKey: seat.key, participationId: chosen, name: chosenName };
  try {
    await run(ops);
  } finally {
    settling.value = null;
  }
}

async function chooseOption(
  slot: Slot,
  seat: Seat,
  option: SeatOption,
): Promise<void> {
  if (option.disabled) {
    return;
  }
  closeCombo(seat);
  await changeSeat(slot, seat, option.value, option.name);
}

function onTriggerClick(event: MouseEvent, slot: Slot, seat: Seat): void {
  const trigger = event.currentTarget;
  if (!(trigger instanceof HTMLElement)) {
    return;
  }
  if (openSeat.value === seat.key) {
    closeCombo(seat);
  } else {
    openCombo(slot, seat, trigger);
  }
}

/** A single printable character jumps to the next option whose name starts
 * with it, cycling from just past whatever is highlighted — the same
 * quick-find a native `select` gives for free, reimplemented because this
 * listbox no longer has one to borrow it from. */
function onTypeahead(
  event: KeyboardEvent,
  options: readonly SeatOption[],
): void {
  if (
    event.key.length !== 1 ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey
  ) {
    return;
  }
  const letter = event.key.toLowerCase();
  for (let step = 1; step <= options.length; step += 1) {
    const index = (activeIndex.value + step) % options.length;
    const option = options[index];
    if (option?.label.toLowerCase().startsWith(letter) === true) {
      event.preventDefault();
      activeIndex.value = index;
      return;
    }
  }
}

/**
 * Every key a seat answers to, popup open or not — that "or not" is the
 * entire reason this is a hand-built listbox and not a `select`. `Delete`,
 * `Ctrl`/`Cmd`+`C`/`V` are handled first and unconditionally, then the rest
 * either opens the list or navigates it.
 *
 * Matched on `event.code` (the physical key) rather than `event.key`: on some
 * layouts (AZERTY, for one) a held `Ctrl` can turn `key` into a control
 * character instead of the letter, which would silently miss both shortcuts.
 */
function onTriggerKeydown(event: KeyboardEvent, slot: Slot, seat: Seat): void {
  if (event.code === 'Delete' || event.code === 'Backspace') {
    if (seat.holder === null) {
      return;
    }
    event.preventDefault();
    closeCombo(seat);
    void changeSeat(slot, seat, '', '');
    return;
  }
  if (event.ctrlKey || event.metaKey) {
    if (event.code === 'KeyC') {
      event.preventDefault();
      copySeat(seat);
      return;
    }
    if (event.code === 'KeyV') {
      event.preventDefault();
      void pasteInto(slot, seat);
      return;
    }
  }

  const isOpen = openSeat.value === seat.key;
  if (!isOpen) {
    if (
      event.code === 'ArrowDown' ||
      event.code === 'ArrowUp' ||
      event.code === 'Enter' ||
      event.code === 'Space' ||
      event.code === 'Home' ||
      event.code === 'End'
    ) {
      const trigger = event.currentTarget;
      if (trigger instanceof HTMLElement) {
        event.preventDefault();
        openCombo(slot, seat, trigger);
      }
    }
    return;
  }

  const options = seatOptions(slot, seat);
  switch (event.code) {
    case 'ArrowDown':
      event.preventDefault();
      activeIndex.value = Math.min(activeIndex.value + 1, options.length - 1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      activeIndex.value = Math.max(activeIndex.value - 1, 0);
      break;
    case 'Home':
      event.preventDefault();
      activeIndex.value = 0;
      break;
    case 'End':
      event.preventDefault();
      activeIndex.value = options.length - 1;
      break;
    case 'Enter':
    case 'Space': {
      event.preventDefault();
      const option = options[activeIndex.value];
      if (option !== undefined) {
        void chooseOption(slot, seat, option);
      }
      break;
    }
    case 'Escape':
      event.preventDefault();
      closeCombo(seat);
      break;
    case 'Tab':
      closeCombo(seat);
      break;
    default:
      onTypeahead(event, options);
  }
}

/** Closes the listbox when focus leaves the seat entirely — Tab to the next
 * seat, or anywhere else. Clicking an option never trips this: the option
 * rows aren't focusable, so a click on one never moves focus off the trigger
 * in the first place. */
function onComboFocusOut(event: FocusEvent, seat: Seat): void {
  const container = event.currentTarget;
  if (!(container instanceof HTMLElement)) {
    return;
  }
  const next = event.relatedTarget;
  if (next instanceof Node && container.contains(next)) {
    return;
  }
  closeCombo(seat);
}

// ---------------------------------------------------------------------------
// Copy, paste, drag
// ---------------------------------------------------------------------------

/** Whoever was last copied — sticky across seats, so one volunteer can be
 * pasted into several gaps without copying them again each time. Copy/paste
 * is a duplicate on purpose (docs/02 §5 lets the same volunteer hold two
 * non-overlapping seats); a drag is not — see `onSeatDrop`. */
const clipboard = ref<{
  readonly participationId: string;
  readonly name: string;
} | null>(null);

function copySeat(seat: Seat): void {
  if (seat.holder === null) {
    return;
  }
  clipboard.value = {
    participationId: seat.holder.participationId,
    name: seat.holder.name,
  };
}

function clearClipboard(): void {
  clipboard.value = null;
}

async function pasteInto(slot: Slot, seat: Seat): Promise<void> {
  const held = clipboard.value;
  if (held === null) {
    return;
  }
  await changeSeat(slot, seat, held.participationId, held.name);
}

/** What a drag carries: enough of the origin seat to cancel it on drop, so
 * the move takes the volunteer *out* of it instead of leaving a second copy
 * behind (`onSeatDrop`). */
interface DragPayload {
  readonly participationId: string;
  readonly name: string;
  readonly eventId: string;
  readonly assignmentId: string;
  readonly version: number;
  readonly seatKey: string;
}

const dragMime = 'application/x-evp-seat';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** `dataTransfer` is a plain string this page wrote a moment ago, but it is
 * still parsed as unknown data rather than cast: a drag started from a stale
 * tab, another origin, or a future shape of this payload must fail closed,
 * not be trusted as `DragPayload` because `JSON.parse` said it was one. */
function isDragPayload(value: unknown): value is DragPayload {
  return (
    isRecord(value) &&
    typeof value['participationId'] === 'string' &&
    typeof value['name'] === 'string' &&
    typeof value['eventId'] === 'string' &&
    typeof value['assignmentId'] === 'string' &&
    typeof value['version'] === 'number' &&
    typeof value['seatKey'] === 'string'
  );
}

function onSeatDragStart(event: DragEvent, slot: Slot, seat: Seat): void {
  const holder = seat.holder;
  if (holder === null || event.dataTransfer === null) {
    return;
  }
  const payload: DragPayload = {
    participationId: holder.participationId,
    name: holder.name,
    eventId: slot.eventId,
    assignmentId: holder.assignmentId,
    version: holder.version,
    seatKey: seat.key,
  };
  event.dataTransfer.setData(dragMime, JSON.stringify(payload));
  event.dataTransfer.setData('text/plain', holder.name);
  // Both allowed: which one happens is decided at the drop, from whether
  // `Ctrl`/`Alt` is held then — `effectAllowed` only bounds the choice, a
  // browser reads the modifier itself to paint the copy-vs-move cursor.
  event.dataTransfer.effectAllowed = 'copyMove';
}

/**
 * A plain drop is a move: the origin seat is cancelled in the same batch as
 * the target's, so a drag re-seats somebody rather than duplicating them.
 * `Ctrl` (Windows/Linux) or `Alt`/`Option` (macOS) held at the moment of the
 * drop copies instead — the origin stays put, the same platform convention
 * as dragging a file. That is also the pointer path to a duplicate now that
 * there is no dedicated copy button (`clipboard`/`Ctrl`+`C`/`V` remain the
 * keyboard one). The origin's own version travels with the drag so a move's
 * cancel still carries a correct `If-Match` even though this handler never
 * re-reads that seat.
 */
async function onSeatDrop(
  event: DragEvent,
  slot: Slot,
  seat: Seat,
): Promise<void> {
  const raw = event.dataTransfer?.getData(dragMime) ?? '';
  if (raw === '') {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!isDragPayload(parsed)) {
    return;
  }
  const origin = parsed;
  if (origin.seatKey === seat.key) {
    return;
  }

  const copying = event.ctrlKey || event.altKey;
  const ops: RosterOp[] = copying
    ? []
    : [
        {
          kind: 'cancel',
          eventId: origin.eventId,
          assignmentId: origin.assignmentId,
          version: origin.version,
        },
      ];
  const holder = seat.holder;
  if (holder !== null) {
    ops.push({
      kind: 'cancel',
      eventId: slot.eventId,
      assignmentId: holder.assignmentId,
      version: holder.version,
    });
  }
  ops.push({
    kind: 'assign',
    eventId: slot.eventId,
    shiftId: slot.shiftId,
    participationId: origin.participationId,
  });

  settling.value = {
    seatKey: seat.key,
    participationId: origin.participationId,
    name: origin.name,
  };
  try {
    await run(ops);
  } finally {
    settling.value = null;
  }
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

interface Toast {
  readonly key: string;
  readonly message: string;
  readonly dismissible: boolean;
}

/**
 * Every alert the page currently has to show, in one list so the panel below
 * the board is the only place any of them are drawn — never a second one
 * that reflows the page when it appears.
 */
const toasts = computed<readonly Toast[]>(() => {
  const list: Toast[] = [];
  if (locationsFailed.value) {
    list.push({
      key: 'locations',
      message: t('assignments.loadFailed.locations'),
      dismissible: false,
    });
  }
  if (shiftsFailed.value) {
    list.push({
      key: 'shifts',
      message: t('assignments.loadFailed.shifts'),
      dismissible: false,
    });
  }
  if (participantsFailed.value) {
    list.push({
      key: 'participants',
      message: t('assignments.loadFailed.participants'),
      dismissible: false,
    });
  }
  if (assignmentsFailed.value) {
    list.push({
      key: 'assignments',
      message: t('assignments.loadFailed.assignments'),
      dismissible: false,
    });
  }
  if (lastRejection.value !== null) {
    const reason = rejectionText(lastRejection.value);
    list.push({
      key: 'rejection',
      message:
        partial.value !== null
          ? t('assignments.rejection.placeEmptied', { reason })
          : reason,
      dismissible: true,
    });
  }
  return list;
});

/** A load failure is not this page's to dismiss — it is still failing, and
 * nothing here changes that. Only a rejection, which is this page's own
 * local memory of a write, is something a coordinator can clear. */
function dismissToast(key: string): void {
  if (key === 'rejection') {
    lastRejection.value = null;
    partial.value = null;
  }
}

function onZoomInput(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }
  const value = Number.parseInt(target.value, 10);
  if (!Number.isNaN(value)) {
    board.setPixelsPerHour(value);
  }
}

/** How many `px/hour` one wheel "notch" is worth — the same step the slider
 * offers, so the two controls feel like the same knob. */
const ZOOM_STEP_PER_NOTCH = 4;
/** `deltaY` per notch on an ordinary mouse wheel; a trackpad's finer deltas
 * end up as a fraction of a step, which reads as smooth rather than jumpy. */
const WHEEL_NOTCH_PIXELS = 100;

/**
 * `Ctrl`/`Cmd` + wheel zooms the board, the same modifier a browser or a map
 * already uses for "this gesture is not the page scrolling" — so it does not
 * fight the ordinary vertical scroll a coordinator uses to move down the
 * roster. Without the modifier the event is left alone.
 */
function onBoardWheel(event: WheelEvent): void {
  if (!event.ctrlKey) {
    return;
  }
  event.preventDefault();
  const notches = -event.deltaY / WHEEL_NOTCH_PIXELS;
  board.setPixelsPerHour(board.pixelsPerHour + notches * ZOOM_STEP_PER_NOTCH);
}
</script>

<template>
  <!-- One message per sentence, and the link is a whole sentence of its own,
       so no sentence is assembled around markup. The keys and the ⋯ are
       written inside the messages rather than as `kbd`s: a key cap is a word
       another language may name differently («Strg»). -->
  <HelpModal :title="t('assignments.help.title')">
    <p>
      {{ t('assignments.help.seats') }}
      {{
        t('assignments.help.pick', {
          removeOption: t('assignments.seat.remove'),
        })
      }}
      {{ t('assignments.help.ranking') }}
      {{ t('assignments.help.folds') }}
      {{ t('assignments.help.drag') }}
      {{ t('assignments.help.keyboard') }}
      {{ t('assignments.help.zoom') }}
      <RouterLink :to="{ name: shiftsRoute, params: scopeParams }">{{
        t('assignments.help.shiftsLink')
      }}</RouterLink>
    </p>
  </HelpModal>

  <div class="evp-tools">
    <p v-if="coverage.required > 0" class="evp-coverage">
      {{
        t('assignments.toolbar.coverage', {
          filled: coverage.filled,
          required: coverage.required,
        })
      }}
    </p>

    <label class="evp-tool" for="roster-zoom">
      <span class="evp-tool-label"
        >{{ t('assignments.toolbar.zoom') }}
        <span class="evp-unit">{{
          t('assignments.toolbar.zoomUnit')
        }}</span></span
      >
      <input
        id="roster-zoom"
        class="evp-zoom"
        type="range"
        :min="board.MIN_PIXELS_PER_HOUR"
        :max="board.MAX_PIXELS_PER_HOUR"
        step="4"
        :value="board.pixelsPerHour"
        @input="onZoomInput"
      />
    </label>

    <label class="evp-tool evp-toggle" for="roster-gaps">
      <input id="roster-gaps" v-model="onlyGaps" type="checkbox" />
      <span class="evp-tool-label">{{
        t('assignments.toolbar.onlyGaps')
      }}</span>
    </label>
  </div>

  <p v-if="isPending">{{ t('common.status.loading') }}</p>

  <template v-else>
    <p v-if="allRows.length === 0" class="evp-empty">
      {{ t('assignments.empty.noMissions') }}
      <RouterLink :to="{ name: missionsRoute, params: scopeParams }">{{
        t('assignments.empty.noMissionsLink')
      }}</RouterLink>
    </p>

    <p v-else-if="coverage.required === 0 && !onlyGaps" class="evp-empty">
      {{ t('assignments.empty.noShifts') }}
      <RouterLink :to="{ name: shiftsRoute, params: scopeParams }">{{
        t('assignments.empty.noShiftsLink')
      }}</RouterLink>
    </p>

    <p v-else-if="rows.length === 0" class="evp-empty">
      {{ t('assignments.empty.allStaffed') }}
    </p>

    <div v-else class="evp-board" :aria-busy="isSaving">
      <div
        class="evp-scroll"
        @wheel="onBoardWheel"
        @scroll.passive="onBoardScroll"
      >
        <div class="evp-axis">
          <!-- The gutter's twin, pinned the same way, so the ruler cannot
               slide out of step with the rows beneath it. -->
          <div
            class="evp-gutter evp-gutter--spacer"
            :style="{ height: axisHeight }"
          >
            <span class="evp-column-head">{{
              t('assignments.board.missionsHeader')
            }}</span>
          </div>
          <div
            class="evp-axis-track"
            :style="{ width: `${String(laneWidth)}px`, height: axisHeight }"
          >
            <div
              v-for="band in bands"
              :key="band.startMs"
              class="evp-band"
              :style="boxStyle(band.startMs, band.endMs)"
            >
              {{ band.label }}
            </div>
            <span
              v-for="tick in ticks"
              :key="tick.atMs"
              class="evp-tick"
              :style="atStyle(tick.atMs)"
              aria-hidden="true"
            >
              {{ tick.label }}
            </span>

            <!-- Hours no day reaches, crushed to a marker. A button, not an
                 ornament: the board has decided these are not worth the
                 screen, and a coordinator staffing a 04:00 load-out has to be
                 able to disagree — by keyboard as readily as by pointer. -->
            <button
              v-for="fold in foldMarks"
              :key="fold.key"
              type="button"
              class="evp-fold"
              :style="boxStyle(fold.startMs, fold.endMs)"
              @click="toggleFold(fold.startMs)"
            >
              <span class="evp-fold-glyph" aria-hidden="true">{{
                t('assignments.board.foldGlyph')
              }}</span>
              <span class="evp-fold-length" aria-hidden="true">{{
                fold.label
              }}</span>
              <span class="evp-visually-hidden">
                {{
                  t('assignments.board.showFold', {
                    length: fold.label,
                    start: clockAt(fold.startMs, axisTimezone),
                    end: clockAt(fold.endMs, axisTimezone),
                  })
                }}
              </span>
            </button>

            <button
              v-for="fold in openedMarks"
              :key="fold.key"
              type="button"
              class="evp-fold evp-fold--open"
              :style="atStyle(fold.startMs)"
              @click="toggleFold(fold.startMs)"
            >
              <span class="evp-fold-glyph" aria-hidden="true">{{
                t('assignments.board.foldGlyph')
              }}</span>
              <span class="evp-visually-hidden">
                {{
                  t('assignments.board.hideFold', {
                    length: fold.label,
                    start: clockAt(fold.startMs, axisTimezone),
                    end: clockAt(fold.endMs, axisTimezone),
                  })
                }}
              </span>
            </button>

            <span
              v-for="mark in publicMarks"
              :key="mark.key"
              class="evp-public-mark"
              :style="atStyle(mark.atMs)"
            >
              {{ mark.label }}
            </span>

            <!-- The days themselves, each in its own colour and carrying its
                 name in words — a strip that said "Saturday" only in pink
                 would say nothing at all to a viewer who cannot tell it from
                 the day above (docs/14 §2). -->
            <span
              v-for="lane in strip.lanes"
              :key="lane.window.id"
              class="evp-event-line"
              :style="eventLineStyle(lane)"
              :title="lane.window.name"
            >
              {{ lane.window.name }}
            </span>
          </div>
        </div>

        <div
          v-for="row in rows"
          :key="row.key"
          class="evp-row"
          role="group"
          :aria-label="row.name"
        >
          <div class="evp-gutter">
            <span class="evp-mission-name">
              {{ row.name }}
              <span v-if="row.alsoAtDays > 0" class="evp-also">
                {{
                  t('assignments.board.alsoAtDays', { count: row.alsoAtDays })
                }}
              </span>
            </span>
            <span class="evp-mission-count">
              {{
                t('assignments.board.missionCount', {
                  filled: rowCoverage(row).filled,
                  required: rowCoverage(row).required,
                })
              }}
            </span>
          </div>

          <div
            class="evp-lane"
            :style="{
              width: `${String(laneWidth)}px`,
              height: laneHeight(row),
            }"
          >
            <!-- Time that is on the board but in no day. -->
            <span
              v-for="edge in margins"
              :key="edge.key"
              class="evp-lane-outside"
              :style="boxStyle(edge.startMs, edge.endMs)"
              aria-hidden="true"
            />

            <!-- The same break, straight down the board: without it two slots
                 either side of a fold read as one continuous afternoon. -->
            <span
              v-for="fold in foldMarks"
              :key="fold.key"
              class="evp-lane-fold"
              :style="boxStyle(fold.startMs, fold.endMs)"
              aria-hidden="true"
            />

            <span
              v-for="mark in publicMarks"
              :key="mark.key"
              class="evp-public-rule"
              :style="atStyle(mark.atMs)"
              aria-hidden="true"
            />

            <span
              v-for="band in bands"
              :key="band.startMs"
              class="evp-lane-band"
              :style="atStyle(band.startMs)"
              aria-hidden="true"
            />

            <!-- One slot per shift, and inside it one dropdown per place. -->
            <div
              v-for="slot in row.slots"
              :key="slot.key"
              class="evp-slot"
              :class="`evp-slot--${slotState(slot)}`"
              :style="slotStyle(slot)"
            >
              <span class="evp-slot-head">
                <span class="evp-slot-hours">{{ slotHours(slot) }}</span>
                <span class="evp-slot-count">{{ slotCount(slot) }}</span>
              </span>

              <!-- eslint-disable-next-line vuejs-accessibility/no-static-element-interactions -- a drop target only; the keyboard path is the trigger button inside -->
              <div
                v-for="seat in slot.seats"
                :key="seat.key"
                class="evp-seat"
                :class="{
                  'evp-seat--extra': seat.extra,
                  'evp-seat--hole': !seat.extra && seat.holder === null,
                }"
                @dragover.prevent
                @drop.prevent="onSeatDrop($event, slot, seat)"
                @focusout="onComboFocusOut($event, seat)"
              >
                <!-- The combobox: a trigger button standing in for the closed
                     `select`, and a listbox this page owns — see the file-top
                     comment for why a native popup couldn't stay. Doubles as
                     the drag handle once it holds somebody, rather than a
                     separate grip: a dedicated icon per seat was more chrome
                     than a row this small can carry. Plain drag moves;
                     `Ctrl`/`Alt` held at the drop copies (`onSeatDrop`). -->
                <button
                  :id="`seat-${seat.key}`"
                  type="button"
                  class="evp-seat-select"
                  role="combobox"
                  aria-haspopup="listbox"
                  :aria-expanded="openSeat === seat.key"
                  :aria-controls="listboxId(seat)"
                  :aria-activedescendant="
                    openSeat === seat.key
                      ? optionId(seat, activeIndex)
                      : undefined
                  "
                  :disabled="isSaving"
                  :draggable="seat.holder !== null"
                  :title="
                    seat.holder !== null
                      ? t('assignments.seat.dragHint', {
                          name: seat.holder.name,
                        })
                      : undefined
                  "
                  @click="onTriggerClick($event, slot, seat)"
                  @keydown="onTriggerKeydown($event, slot, seat)"
                  @dragstart="onSeatDragStart($event, slot, seat)"
                >
                  <span class="evp-visually-hidden">
                    {{ seatLabel(row, slot, seat) }}
                  </span>
                  <span class="evp-seat-select-text">{{
                    seatTriggerLabel(seat)
                  }}</span>
                </button>

                <Teleport to="body">
                  <ul
                    v-if="openSeat === seat.key && comboPosition !== null"
                    :id="listboxId(seat)"
                    role="listbox"
                    class="evp-seat-listbox"
                    :aria-label="seatLabel(row, slot, seat)"
                    :style="{
                      top: `${String(comboPosition.top)}px`,
                      left: `${String(comboPosition.left)}px`,
                      minWidth: `${String(comboPosition.width)}px`,
                    }"
                  >
                    <!-- eslint-disable-next-line vuejs-accessibility/interactive-supports-focus, vuejs-accessibility/click-events-have-key-events, vuejs-accessibility/mouse-events-have-key-events -- ARIA 1.2 "virtual focus" combobox: the option rows are deliberately unfocusable, real focus stays on the trigger button the whole time, and `aria-activedescendant` (bound on the trigger) plus `onTriggerKeydown`'s arrow/Home/End/Enter/type-ahead navigation are the keyboard path these rules can't see -->
                    <li
                      v-for="(option, index) in seatOptions(slot, seat)"
                      :id="optionId(seat, index)"
                      :key="`${option.value}:${String(index)}`"
                      role="option"
                      class="evp-seat-option"
                      :class="{
                        'evp-seat-option--active': index === activeIndex,
                        'evp-seat-option--disabled': option.disabled,
                      }"
                      :aria-selected="index === activeIndex"
                      :aria-disabled="option.disabled"
                      @mousedown.prevent
                      @mouseenter="activeIndex = index"
                      @click="chooseOption(slot, seat, option)"
                    >
                      {{ option.label }}
                    </li>
                  </ul>
                </Teleport>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </template>

  <ToastStack>
    <ToastMessage
      v-for="toast in toasts"
      :key="toast.key"
      tone="danger"
      :dismissible="toast.dismissible"
      @dismiss="dismissToast(toast.key)"
    >
      {{ toast.message }}
    </ToastMessage>
    <ToastMessage
      v-if="clipboard !== null"
      dismissible
      :dismiss-label="t('assignments.clipboard.clear')"
      @dismiss="clearClipboard"
    >
      {{ t('assignments.clipboard.copied') }}
      <strong>{{ clipboard.name }}</strong
      >. {{ t('assignments.clipboard.pasteHint') }}
    </ToastMessage>
  </ToastStack>
</template>

<style scoped>
.evp-tools {
  align-items: flex-end;
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem 1.5rem;
  margin: 0 0 1rem;
}

h2 {
  font-size: 1.125rem;
  margin: 0 1rem 0 0;
}

.evp-coverage {
  color: var(--evp-text-muted);
  font-size: 0.9375rem;
  margin: 0;
}

.evp-tool {
  align-items: center;
  display: flex;
  gap: 0.5rem;
}

.evp-toggle {
  cursor: pointer;
}

.evp-tool-label {
  color: var(--evp-text-muted);
  font-size: 0.875rem;
  line-height: 1.2;
}

.evp-unit {
  display: block;
  font-size: 0.75rem;
}

.evp-zoom {
  width: 8rem;
}

.evp-empty {
  color: var(--evp-text-muted);
  max-width: 60ch;
}

.evp-board {
  border: 1px solid var(--evp-border);
  border-radius: 0.5rem;
  overflow: hidden;
}

/* The one place this application scrolls sideways. docs/14 §2 forbids
   horizontal scrolling for content at 320 px; a timeline is the 2-D data
   WCAG 1.4.10 exempts, and the mission names stay pinned so the rows never
   lose their labels. */
.evp-scroll {
  overflow-x: auto;
  overflow-y: hidden;
}

.evp-axis,
.evp-row {
  display: flex;
  min-width: max-content;
}

.evp-axis {
  border-bottom: 1px solid var(--evp-border);
}

.evp-gutter--spacer {
  justify-content: flex-start;
}

.evp-axis-track {
  position: relative;
}

/* The days, as colour — and as a name, because colour alone is not
   information (docs/14 §2). White on all 64 palette entries is sound: every
   one clears 4.5:1 against white by construction
   (`packages/shared/src/eventColors.ts`). */
.evp-event-line {
  border-radius: 0.25rem;
  color: #ffffff;
  font-size: 0.6875rem;
  font-weight: 600;
  height: 0.875rem;
  line-height: 0.875rem;
  overflow: hidden;
  padding: 0 0.3125rem;
  position: absolute;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.evp-column-head {
  color: var(--evp-text-muted);
  font-size: 0.8125rem;
  font-weight: 600;
}

.evp-band {
  border-left: 1px solid var(--evp-border);
  color: var(--evp-text);
  font-size: 0.8125rem;
  font-weight: 600;
  padding-left: 0.25rem;
  position: absolute;
  top: 0.125rem;
}

/* Labelled from the tick rightwards, like a ruler, rather than centred on it:
   a centred first label is half-clipped by the pinned gutter. */
.evp-tick {
  color: var(--evp-text-muted);
  font-size: 0.75rem;
  padding-left: 0.25rem;
  position: absolute;
  top: 1.5rem;
  white-space: nowrap;
}

.evp-tick::before {
  background: var(--evp-border);
  content: '';
  height: 0.3125rem;
  left: 0;
  position: absolute;
  top: -0.375rem;
  width: 1px;
}

.evp-row + .evp-row .evp-gutter,
.evp-row + .evp-row .evp-lane {
  border-top: 1px solid var(--evp-border);
}

.evp-gutter {
  align-items: flex-start;
  background: var(--evp-surface);
  display: flex;
  flex: 0 0 13.5rem;
  flex-direction: column;
  gap: 0.25rem;
  /* Pinned, so scrolling to Sunday never leaves a coordinator looking at four
     anonymous rows. */
  left: 0;
  justify-content: center;
  padding: 0.5rem 0.625rem;
  position: sticky;
  width: 13.5rem;
  border-right: 1px solid var(--evp-border);
  z-index: 2;
}

.evp-mission-name {
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.25;
  /* Wraps rather than truncating: a mission name a coordinator cannot read is
     not a row (docs/14 §2). */
  overflow-wrap: break-word;
}

.evp-also,
.evp-mission-count {
  color: var(--evp-text-muted);
  display: block;
  font-size: 0.6875rem;
  font-weight: 400;
}

.evp-mission-count {
  font-variant-numeric: tabular-nums;
}

.evp-lane {
  position: relative;
}

/* The decorations are drawn under everything and are never controls: each is
   `aria-hidden`, and a press that landed on one would be a press aimed at the
   slot behind it. */
.evp-lane-outside,
.evp-lane-band,
.evp-lane-fold,
.evp-public-rule {
  pointer-events: none;
}

.evp-lane-band {
  border-left: 1px solid var(--evp-border);
  bottom: 0;
  position: absolute;
  top: 0;
}

/* Stripes rather than a flat tint: at 3:1 a flat tint either disappears in
   the light theme or reads as a filled block in the dark one, and in forced
   colours it disappears in both. */
.evp-lane-outside {
  background: repeating-linear-gradient(
    135deg,
    transparent,
    transparent 5px,
    var(--evp-border) 5px,
    var(--evp-border) 6px
  );
  bottom: 0;
  opacity: 0.55;
  position: absolute;
  top: 0;
}

.evp-fold {
  align-items: center;
  background: repeating-linear-gradient(
    135deg,
    transparent,
    transparent 3px,
    var(--evp-border) 3px,
    var(--evp-border) 4px
  );
  border: 0;
  border-left: 1px dashed var(--evp-border);
  border-right: 1px dashed var(--evp-border);
  bottom: 0;
  color: var(--evp-text-muted);
  cursor: zoom-in;
  display: flex;
  flex-direction: column;
  font-size: 0.625rem;
  gap: 0.125rem;
  justify-content: center;
  line-height: 1;
  overflow: hidden;
  padding: 0;
  position: absolute;
  top: 0;
  z-index: 1;
}

.evp-fold:hover {
  background-color: var(--evp-surface-raised);
  color: var(--evp-text);
}

.evp-fold:focus-visible {
  outline: 2px solid var(--evp-accent);
  outline-offset: -2px;
}

.evp-fold-glyph {
  font-size: 0.875rem;
}

.evp-fold-length {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* The way back, once a stretch is open. 1.5rem is WCAG 2.2 AA 2.5.8's 24 px
   floor, and it is small precisely because what it would undo is now on
   screen and does not need selling. */
.evp-fold--open {
  background: var(--evp-surface);
  border-right: 0;
  cursor: zoom-out;
  width: 1.5rem;
}

.evp-lane-fold {
  background: repeating-linear-gradient(
    135deg,
    transparent,
    transparent 3px,
    var(--evp-border) 3px,
    var(--evp-border) 4px
  );
  border-left: 1px dashed var(--evp-border);
  border-right: 1px dashed var(--evp-border);
  bottom: 0;
  opacity: 0.4;
  position: absolute;
  top: 0;
}

.evp-public-mark {
  border-left: 2px dotted var(--evp-accent);
  color: var(--evp-accent);
  font-size: 0.6875rem;
  padding-left: 0.1875rem;
  position: absolute;
  top: 2.5rem;
  white-space: nowrap;
}

.evp-public-rule {
  border-left: 2px dotted var(--evp-accent);
  bottom: 0;
  opacity: 0.6;
  position: absolute;
  top: 0;
}

/**
 * One shift's worth of places.
 *
 * A box rather than a bar: what a coordinator does here is read *down* a
 * column of names, exactly as they did in the spreadsheet, and the box is
 * that column. It is told apart from the lane behind it by fill, not by an
 * outline — packed edge to edge across a festival day, a border on every one
 * of them is a grid of lines nobody reads. Its top edge still carries the
 * day's colour, the same colour the day's line has on the strip above — the
 * answer to "is this 03:00 slot Saturday's or Sunday's?" is a colour match
 * rather than a date sum. On top rather than down the left: two slots sitting
 * side by side on the timeline shared a left edge each, which read as one
 * continuous coloured rule running between them rather than as two separate
 * accents.
 */
.evp-slot {
  background: var(--evp-surface-raised);
  border-top: 3px solid var(--evp-slot-color);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: absolute;
}

.evp-slot-head {
  align-items: baseline;
  color: var(--evp-text-muted);
  display: flex;
  font-size: 0.625rem;
  gap: 0.25rem;
  height: 1rem;
  justify-content: space-between;
  line-height: 1rem;
  overflow: hidden;
  padding: 0 0.25rem;
  white-space: nowrap;
}

.evp-slot-count {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.evp-slot--empty .evp-slot-count,
.evp-slot--short .evp-slot-count {
  color: var(--evp-danger);
}

.evp-seat {
  align-items: stretch;
  display: flex;
  gap: 0.125rem;
  height: 1.75rem;
  padding: 0.0625rem 0.125rem;
}

/* Filled seats no longer draw a box: stacked ten deep, a border on every one
   is noise repeating the same fact ten times. The background alone is enough
   to say "this is a control"; the border comes back only where it is a
   signal, not decoration (below). */
.evp-seat-select {
  background: var(--evp-surface-raised);
  border: 1px solid transparent;
  border-radius: 0.1875rem;
  color: var(--evp-text);
  flex: 1 1 auto;
  font: inherit;
  font-size: 0.75rem;
  /* The 24 px target floor of docs/14 §2, reached with real height rather than
     with a transparent overlay a touch device cannot find. */
  height: 1.5rem;
  min-width: 0;
  overflow: hidden;
  padding: 0 0.25rem;
  text-align: left;
  /* A slot is as wide as its hours are long, which at a low zoom is narrow.
     The control fills it and truncates its label rather than overflowing into
     the slot beside it — the full name is in the listbox and in the label a
     screen reader reads. */
  width: 100%;
}

.evp-seat-select-text {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.evp-seat-select:hover {
  border-color: var(--evp-border);
}

/* Teleported to `<body>` so the slot's own `overflow: hidden` — needed to
   keep one slot's seats from bleeding into the next — never clips it, the
   same way a native popup always painted above everything regardless of any
   author CSS. Positioned in `comboPosition`, computed from the trigger's own
   rect at the moment it opens. */
.evp-seat-listbox {
  background: var(--evp-surface-raised);
  border: 1px solid var(--evp-border);
  border-radius: 0.25rem;
  box-shadow: 0 0.25rem 0.75rem rgb(0 0 0 / 20%);
  list-style: none;
  margin: 0.125rem 0 0;
  max-height: 14rem;
  overflow-y: auto;
  padding: 0.25rem 0;
  position: fixed;
  z-index: 30;
}

.evp-seat-option {
  cursor: pointer;
  font-size: 0.8125rem;
  padding: 0.375rem 0.625rem;
  white-space: nowrap;
}

.evp-seat-option--active {
  background: var(--evp-accent);
  color: #ffffff;
}

.evp-seat-option--disabled {
  color: var(--evp-text-muted);
  cursor: default;
}

.evp-seat-option--active.evp-seat-option--disabled {
  background: var(--evp-surface);
  color: var(--evp-text-muted);
}

/* An empty *required* seat is the hole the coordinator came to find, so it is
   drawn as one; an empty seat past the requirement is an invitation and stays
   quiet. The slot's own outline and its count say the same thing in words —
   this is the third signal, never the only one (docs/14 §2). */
.evp-seat--hole .evp-seat-select {
  border-color: var(--evp-danger);
}

.evp-seat--extra .evp-seat-select {
  border-color: var(--evp-border);
  border-style: dashed;
  color: var(--evp-text-muted);
}

/* The one seat a coordinator is currently in — not the whole shift, which can
   hold a dozen others nobody is touching. Not a state either (docs/14 §2's
   "never colour alone" still holds: short and empty already say so in the
   count's own colour above), just where the cursor is. `:focus-within`
   rather than a tracked ref or the trigger's own `:focus-visible`: a seat
   has exactly one focusable thing in it, so the two are equivalent, but this
   one still reaches the whole row rather than just the button's own edge. */
.evp-seat:focus-within {
  border-radius: 0.1875rem;
  box-shadow: inset 0 0 0 2px var(--evp-accent);
}

.evp-seat-select:disabled {
  cursor: progress;
  opacity: 0.7;
}

/**
 * Forced colours drop every author colour, so the day's line and the slot's
 * left edge lose the thing that pairs them. Shape is what is left: an outlined
 * box with a count in it still reads as "two of three places filled", and the
 * strip still carries its names in words.
 */
@media (forced-colors: active) {
  .evp-event-line,
  .evp-slot {
    border: 1px solid;
  }

  .evp-fold,
  .evp-lane-fold {
    border-left: 1px dashed CanvasText;
    border-right: 1px dashed CanvasText;
  }
}

.evp-visually-hidden {
  clip-path: inset(50%);
  height: 1px;
  overflow: hidden;
  position: absolute;
  white-space: nowrap;
  width: 1px;
}
</style>
