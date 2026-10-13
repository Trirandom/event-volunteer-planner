<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * The shift board: missions down, time across, shifts as bars you can drag.
 *
 * This section is *when* the work happens. What the work is — the missions
 * themselves, their briefings and their addresses — is the missions section
 * next door (`PlanMissionsView.vue`), and the two were one page until the
 * rows down the left-hand gutter grew fields that a timeline has nowhere to
 * put. The gutter still names every mission, because a board is unreadable
 * without it; it is no longer where they are declared.
 *
 * The board answers the question a coordinator actually opens it with —
 * *where is the hole?* — which a list cannot, because a hole is a shape and a
 * shape has to be seen. docs/01 §S8 says the UI is a timeline and docs/02 §7
 * says how: a continuous time scale with bars positioned on it, not a table,
 * because the axis granularity cannot be assumed uniform (ADR-0029).
 *
 * **A bar is a run of shifts and nothing else.** There is no mission-window
 * row behind it. Dragging an edge creates, patches and deletes shifts; merging
 * two bars is filling the gap between them, after which they are one bar
 * because they touch. ADR-0029 rejected every layer that would keep shifts
 * aligned to something, and a board that invented one in the client would be
 * that rejected design with a nicer surface.
 *
 * **A mission nobody has cut yet is drawn dashed, across its whole event.**
 * That is the honest default — the post exists, it is simply not divided yet —
 * and it stores nothing until the first edit.
 *
 * **Every drag has a keyboard equivalent**, which is WCAG 2.2 AA 2.5.7 and a
 * CI gate, not a nicety (docs/14 §1, ADR-0017). The two edges of each bar are
 * a slider pair — the same idiom docs/09 chose for the volunteer form's day
 * track — so arrow keys move an edge by one step, `Shift` by one slot, and
 * `Home`/`End` run it to the edge of its own day. The pointer path is the
 * enhancement, built on the Pointer Events API directly because the drop
 * target is computed from the same time scale the layout uses and no generic
 * library can know about it (docs/02 §7).
 *
 * The board is not yet the ARIA grid of docs/14 §3. That grid is the
 * *assignment* surface — cells are (location, time-bucket) and `Enter` opens a
 * roster — and it arrives with assignments in M3. Here the editable things are
 * the shifts themselves, so they are what carries the semantics.
 */
import { eventColor } from '@evp/shared';
import { Temporal } from '@evp/shared/time';
import { computed, ref, type Ref } from 'vue';
import { RouterLink } from 'vue-router';

import HelpModal from '../components/HelpModal.vue';
import ToastMessage from '../components/ToastMessage.vue';
import ToastStack from '../components/ToastStack.vue';
import { useApplyShiftOps } from '../api/useShiftWrites';
import { useMissionBoard, usePlanScope } from '../api/usePlan';
import { runLanes, type Lane } from '../board/lanes';
import {
  middleOf,
  planCutMove,
  planDeleteRun,
  planEdgeMove,
  planNewRun,
  planRecut,
  planSplitRun,
  settledCut,
  settledEdge,
  settledNewRun,
  type BoardOp,
  type Edge,
  type EdgeStop,
  type Period,
  type SettledCut,
  type SettledEdge,
} from '../board/edit';
import {
  missionRows,
  type EventWindow,
  type MissionRow,
  type Run,
} from '../board/runs';
import { msAt, snapMs } from '../board/scale';
import { AXIS_MARGIN_MINUTES, useAxis } from '../board/useAxis';
import { locale, t } from '../i18n';
import { narrowToEvent } from '../plan/missions';
import { focusedEventId } from '../plan/scope';
import { useRouteParam } from '../router/params';
import { useBoardStore } from '../stores/board';

/** ADR-0029's floor: nothing finer than a quarter of an hour is offered,
 * because nothing finer can be declared against on the volunteer form. */
const STEP_MINUTES = 15;
const MS_PER_MINUTE = 60_000;

/** How close a pointer has to land to an hour line before it snaps to it — a
 * screen distance, not a time one, so it feels the same at every zoom. Wide
 * enough to catch a hand that was aiming for the hour without a laser, narrow
 * enough that two hour lines never both claim the same drag. */
const STICKY_PIXELS = 8;

const orgId = useRouteParam('orgId');
const festivalId = useRouteParam('festivalId');
const eventId = useRouteParam('eventId');

/** The details section at whatever scope this board is being read at — the
 * same "this section, at that scope" pairing the rail makes
 * (`PlanDetailView.vue`), so the hint's link does not drop a coordinator out
 * of the day they are looking at. */
const detailsRoute = computed(() =>
  eventId.value === '' ? 'org-festival-details' : 'org-event-details',
);
/** Same pairing for the missions section, which is where a board with no rows
 * sends a coordinator: there is nothing to cut until a mission exists. */
const missionsRoute = computed(() =>
  eventId.value === '' ? 'org-festival-missions' : 'org-event-missions',
);
const detailsParams = computed(() =>
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

/** `Date.parse` is banned (docs/16 §4): it accepts strings that are not
 * RFC 3339 and answers `NaN` for the rest, which here would be a whole day
 * silently laid at the left edge of the epoch. */
function instantOf(iso: string): number {
  return Temporal.Instant.from(iso).epochMilliseconds;
}

const days = computed(() => scope.value?.days ?? []);
const focus = computed(() =>
  scope.value === null ? null : focusedEventId(scope.value),
);

const {
  board: missionBoard,
  isPending: boardPending,
  locationsFailed,
  shiftsFailed,
} = useMissionBoard(orgId, days);

/**
 * Every day is still *fetched* at either scope — that is what lets a festival
 * answer "is the bar staffed?" at all (`usePlan.ts`) — but only the days in
 * view are laid on the axis. Narrowed to Saturday, a festival-wide axis would
 * be six days of white space with one day of work in it.
 */
const visibleEvents = computed(() => {
  const only = focus.value;
  return only === null
    ? days.value
    : days.value.filter((day) => day.id === only);
});

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

const rows = computed(() => missionRows(visibleBoard.value, windows.value));

/**
 * The same rows, with each one's bars stacked where they overlap.
 *
 * One mission is one line, and on the festival-wide axis that line carries
 * every day at once. Two days that genuinely run at the same time — a club
 * night and the after that laps it — put two bars on the same pixels, and one
 * drawn over the other is the board hiding exactly what it exists to show. So
 * a row is as many sub-rows deep as its deepest overlap, which for the
 * ordinary mission is one and costs nothing (`lanes.ts`).
 */
interface LaidRow extends MissionRow {
  readonly lanes: readonly Lane<Run>[];
  /** At least one: an empty row is still a row, and a mission with no bar at
   * all still needs a lane to draw a new series on. */
  readonly rowCount: number;
}

const laidRows = computed<readonly LaidRow[]>(() =>
  rows.value.map((row): LaidRow => {
    const packed = runLanes(row.runs);
    return {
      ...row,
      lanes: packed.lanes,
      rowCount: Math.max(packed.rowCount, 1),
    };
  }),
);

/** One sub-row's worth of height, in `rem` so the board scales with the
 * viewer's text size (docs/14 §2). Wide enough for the 24 px chip, the label
 * above it and the controls that share that line. */
const LANE_ROW_REM = 3;

function laneHeight(row: LaidRow): string {
  return `${String(row.rowCount * LANE_ROW_REM)}rem`;
}

function laneRowOf(row: LaidRow, subject: Run): number {
  return row.lanes.find((lane) => lane.item.key === subject.key)?.row ?? 0;
}

/** The instant a bar's top edge sits at, in `rem`: its sub-row, plus the
 * offset that centres a 1.5 rem chip in a 3 rem lane. */
function laneTopRem(laneRow: number): number {
  return laneRow * LANE_ROW_REM + (LANE_ROW_REM - 1.5) / 2;
}

/**
 * One line, one clock. A festival spanning two zones cannot be ruled out and
 * the festival's own zone is the only single answer for a shared axis; each
 * bar still announces the zone it is genuinely worked in, which is the reading
 * docs/16 §1 cares about.
 */
const axisClock = computed(
  () =>
    scope.value?.selected?.timezone ?? scope.value?.festival?.timezone ?? 'UTC',
);

/**
 * The ruler, the elisions and the coloured strip of days — one composable,
 * shared with the assignation board (`board/useAxis.ts`).
 *
 * Shared rather than duplicated because the two pages are read together: a
 * coordinator finds a hole here and fills it there, and an axis that folded a
 * different stretch of night on each would make the second page a different
 * festival.
 */
const {
  scale,
  laneWidth,
  axisHeight,
  axisTimezone,
  reach,
  bands,
  ticks,
  hourMarks,
  margins,
  foldMarks,
  openedMarks,
  publicMarks,
  strip,
  toggleFold,
  leftPx,
  boxStyle,
  atStyle,
  offsetStyle,
  eventLineStyle,
  clockAt,
} = useAxis({ windows, timezone: axisClock, locale });

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

const apply = useApplyShiftOps(orgId);

/**
 * A sentence kept on screen, held as the way to say it rather than as the
 * words: the toasts below outlive the gesture that raised them, and one built
 * at render time follows a language switch instead of staying in the language
 * it was raised in.
 */
type Said = () => string;

/** What the last plan did, kept on screen until dismissed rather than shown as
 * a toast that times out — docs/02 §7 is explicit that a rejection is
 * explained. Drawn in the `ToastStack` so it never reflows the board. */
const lastRejection = ref<Said | null>(null);
const partial = ref<number | null>(null);

/**
 * What the board itself did or would not do, as opposed to what the server
 * refused.
 *
 * Separate from `lastRejection` because `run` clears that one the moment a
 * plan is sent, and these two outlive the plan on purpose: a drag can both
 * write something *and* have been cut short, and the sentence explaining that
 * it stopped is the whole difference between a board that clamped and a board
 * that lost the gesture.
 */
const lastStop = ref<Said | null>(null);
const lastNotice = ref<Said | null>(null);

function dismissRejection(): void {
  lastRejection.value = null;
  partial.value = null;
}

async function run(ops: readonly BoardOp[]): Promise<void> {
  if (ops.length === 0) {
    return;
  }
  lastRejection.value = null;
  partial.value = null;

  const outcome = await apply.mutateAsync(ops);
  const { rejection } = outcome;
  if (rejection !== null) {
    // The server's own `detail` is shown as it came: it names which hard rule
    // refused the write, and only the server knows that.
    lastRejection.value =
      rejection.reason === 'unavailable'
        ? () => t('shifts.rejection.unavailable')
        : () => rejection.detail;
    partial.value = outcome.applied === 0 ? null : outcome.applied;
  }
}

/**
 * Why an outward pull produced nothing.
 *
 * Two walls are left now that the end of the day is not one of them: another
 * bar at the same post, and the end of the axis. Both are silent refusals
 * otherwise — the ghost simply stops — and a silent refusal on this board is
 * indistinguishable from a gesture it lost.
 */
function stopReason(stop: EdgeStop, edge: Edge): string {
  if (stop === 'neighbour') {
    return edge === 'end'
      ? t('shifts.stop.neighbourEnd')
      : t('shifts.stop.neighbourStart');
  }
  return t('shifts.stop.axis', { hours: AXIS_MARGIN_MINUTES / 60 });
}

/**
 * What a drag is about to do to the day it is on, said before it happens.
 *
 * Only the operational window is mentioned, because only it moves. This
 * notice used to add "19:00 is kept as the day's public closing time", back
 * when the first widening wrote `public_period`; the doors are typed in on
 * the event details page now, and a drag says nothing about them.
 */
function widenNotice(
  widens: { readonly startMs: number; readonly endMs: number },
  subject: Run,
  edge: Edge,
): string {
  const values = {
    day: subject.eventName,
    time: clockAt(
      edge === 'end' ? widens.endMs : widens.startMs,
      subject.timezone,
    ),
  };

  return edge === 'end'
    ? t('shifts.notice.widenEnd', values)
    : t('shifts.notice.widenStart', values);
}

/** Explain an edge that could not go the whole way, and clear the explanation
 * on the next gesture that could. */
function reportStop(settled: SettledEdge | null, edge: Edge): void {
  const stop = settled?.stoppedBy ?? null;
  lastStop.value = stop === null ? null : () => stopReason(stop, edge);
}

/** One edge, shown somewhere other than where the stored shifts put it. */
interface HeldEdge {
  readonly missionKey: string;
  readonly runKey: string;
  readonly edge: Edge;
  readonly ms: number;
}

interface Drag extends HeldEdge {
  /** Where the lane's left edge is on screen, read once at pointer-down: a
   * re-read per move would fight the board's own scrolling. */
  readonly laneLeft: number;
  readonly originMs: number;
  /** What the last move found in the way, if the pointer had already gone
   * past what this edge is allowed to reach. */
  readonly stoppedBy: EdgeStop | null;
  /** The event period this drop will need, if the pointer has gone past the
   * end of the day the bar is on. */
  readonly widensEvent: {
    readonly startMs: number;
    readonly endMs: number;
  } | null;
}

const drag = ref<Drag | null>(null);

/**
 * An edge held at its target while the writes that put it there land.
 *
 * Releasing at `pointerup` is what a board must not do. One drag is a *plan*
 * of several writes, sent one at a time and on purpose (`useShiftWrites.ts`),
 * followed by a re-read; letting the geometry fall back to the stored shifts
 * the moment the pointer lifts puts the bar at its old length for that whole
 * round trip. What a coordinator sees is a bar that springs back — the board
 * refusing the edit — so they drag again, against a bar that is already being
 * lengthened, and the second gesture is planned against shifts the first one
 * has already changed.
 *
 * Optimistic only between the drop and the answer: a refusal still re-reads
 * the board and says so inline, which is the honest order (docs/02 §7).
 */
const settling = ref<HeldEdge | null>(null);

/** The pointer outranks an edit still landing: a coordinator who has grabbed
 * the edge again is saying where it goes next, not where it went. */
const heldEdge = computed<HeldEdge | null>(() => drag.value ?? settling.value);

function runsOf(missionKey: string): readonly Run[] {
  return rows.value.find((row) => row.key === missionKey)?.runs ?? [];
}

function runOf(missionKey: string, runKey: string): Run | undefined {
  return runsOf(missionKey).find((subject) => subject.key === runKey);
}

function heldMsOf(row: MissionRow, subject: Run, edge: Edge): number | null {
  const held = heldEdge.value;
  return held !== null &&
    held.runKey === subject.key &&
    held.missionKey === row.key &&
    held.edge === edge
    ? held.ms
    : null;
}

/** The geometry a bar is drawn with: the edge being moved is where the
 * coordinator put it, the other stays put. */
function runStartMs(row: MissionRow, subject: Run): number {
  return heldMsOf(row, subject, 'start') ?? subject.startMs;
}

function runEndMs(row: MissionRow, subject: Run): number {
  return heldMsOf(row, subject, 'end') ?? subject.endMs;
}

/** Whether this bar is drawn at a shape the server has not confirmed yet —
 * an edge held at its target, or a break held at the instant it was dropped
 * on. Both are the same promise to the coordinator and both are labelled. */
function isSettling(row: MissionRow, subject: Run): boolean {
  return [settling.value, settlingCut.value].some(
    (held) =>
      held !== null &&
      held.runKey === subject.key &&
      held.missionKey === row.key,
  );
}

/**
 * Carry out a plan with whatever it moved held where the coordinator put it,
 * until the board has been re-read.
 *
 * The token is not ceremony: a coordinator can drop a second drag before the
 * first one's writes are in, and only the hold that is still the current one
 * may clear the geometry — otherwise the older request releases the newer
 * drag's bar and it springs back after all.
 *
 * Generic over what is held because there are now three of them — an edge, a
 * break inside a bar, and a series being drawn on empty lane — and three
 * copies of this counter would be three chances to get the stale case wrong in
 * a way that only shows up under a fast second gesture.
 */
function heldRunner<T>(
  state: Ref<T | null>,
): (hold: T, ops: readonly BoardOp[]) => Promise<void> {
  let generation = 0;

  return async (hold, ops) => {
    generation += 1;
    const mine = generation;
    state.value = hold;
    try {
      await run(ops);
    } finally {
      if (mine === generation) {
        state.value = null;
      }
    }
  };
}

/**
 * Pull a snapped instant onto the nearest hour line, unless the coordinator
 * is holding it off.
 *
 * On by default because the hour lines exist to be landed on — a coordinator
 * dragging an edge "to the hour" should not also have to hit the exact pixel.
 * `Shift` is the escape hatch for the times that is wrong: a 10-minute break
 * or a slot that genuinely starts at :50 would otherwise be unreachable near
 * an hour line, magnetised past every quarter-hour step in between.
 *
 * Distance is measured in screen pixels rather than minutes so the magnet
 * feels the same at every zoom — at the widest zoom a minute is most of a
 * pixel already and a time-based radius would swallow the whole hour.
 */
function stickyMs(candidateMs: number, x: number, shiftKey: boolean): number {
  if (shiftKey) {
    return candidateMs;
  }
  let nearestMs = candidateMs;
  let nearestDistance = Infinity;
  for (const mark of hourMarks.value) {
    const distance = Math.abs(leftPx(mark.atMs) - x);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestMs = mark.atMs;
    }
  }
  return nearestDistance <= STICKY_PIXELS ? nearestMs : candidateMs;
}

const runHeld = heldRunner(settling);

function onPointerDown(
  event: PointerEvent,
  row: MissionRow,
  subject: Run,
  edge: Edge,
): void {
  // Primary button only: a right-click that began a drag would leave the board
  // following a pointer through a context menu.
  if (event.button !== 0) {
    return;
  }
  const handle = event.currentTarget;
  if (!(handle instanceof HTMLElement)) {
    return;
  }
  const lane = handle.closest('.evp-lane');
  if (!(lane instanceof HTMLElement)) {
    return;
  }

  handle.setPointerCapture(event.pointerId);
  drag.value = {
    missionKey: row.key,
    runKey: subject.key,
    edge,
    laneLeft: lane.getBoundingClientRect().left,
    originMs: subject.boundsStartMs,
    ms: edge === 'end' ? subject.endMs : subject.startMs,
    stoppedBy: null,
    widensEvent: null,
  };
  event.preventDefault();
}

function onPointerMove(event: PointerEvent): void {
  const current = drag.value;
  const current_scale = scale.value;
  if (current === null || current_scale === null) {
    return;
  }

  const x = event.clientX - current.laneLeft;
  const raw = msAt(current_scale, x);
  const snapped = stickyMs(
    snapMs(raw, STEP_MINUTES, current.originMs),
    x,
    event.shiftKey,
  );

  // Settled through the same function the plan uses, so the ghost is never
  // somewhere the drop cannot put it.
  const settled = settledEdge(
    runsOf(current.missionKey),
    current.runKey,
    current.edge,
    snapped,
    STEP_MINUTES,
    reach.value,
  );
  // Remembered from the move rather than recomputed at the drop, because by
  // then the only instant left is the settled one and "asked for more than it
  // could have" is no longer a question that can be put to it.
  drag.value = {
    ...current,
    ms: settled?.ms ?? snapped,
    stoppedBy: settled?.stoppedBy ?? null,
    widensEvent: settled?.widensEvent ?? null,
  };
}

async function onPointerUp(): Promise<void> {
  const current = drag.value;
  drag.value = null;
  if (current === null) {
    return;
  }
  const runs = runsOf(current.missionKey);
  reportStop(current, current.edge);
  announceWidening(runs, current.runKey, current.edge, current.widensEvent);

  // The ghost is already settled through `settledEdge`, so handing the same
  // instant to the hold cannot show the bar anywhere the plan will not put it.
  await runHeld(
    {
      missionKey: current.missionKey,
      runKey: current.runKey,
      edge: current.edge,
      ms: current.ms,
    },
    planEdgeMove({
      runs,
      runKey: current.runKey,
      edge: current.edge,
      toMs: current.ms,
      cutMinutes: board.cutMinutesFor(current.missionKey),
      stepMinutes: STEP_MINUTES,
      reach: reach.value,
    }),
  );
}

/**
 * Say that the day moved, because nothing else on screen would.
 *
 * A widened event redraws the axis under every row, and a coordinator who
 * dragged one bar is owed the sentence explaining why the whole board just
 * got longer — including, the first time, that the closing time they were
 * looking at has become the day's published one rather than being lost.
 */
function announceWidening(
  runs: readonly Run[],
  runKey: string,
  edge: Edge,
  widens: { readonly startMs: number; readonly endMs: number } | null,
): void {
  const subject = runs.find((candidate) => candidate.key === runKey);
  lastNotice.value =
    widens === null || subject === undefined
      ? null
      : () => widenNotice(widens, subject, edge);
}

function onPointerCancel(): void {
  drag.value = null;
}

/**
 * The keyboard's equivalent of a drop, and it is held for the same reason: an
 * arrow key whose edge only moves once the writes are in reads as a key that
 * did nothing, and invites the press again that a pointer invites the redrag.
 */
async function moveEdgeTo(
  row: MissionRow,
  subject: Run,
  edge: Edge,
  toMs: number,
): Promise<void> {
  const runs = runsOf(row.key);
  const plan = planEdgeMove({
    runs,
    runKey: subject.key,
    edge,
    toMs,
    cutMinutes: board.cutMinutesFor(row.key),
    stepMinutes: STEP_MINUTES,
    reach: reach.value,
  });
  const settled = settledEdge(
    runs,
    subject.key,
    edge,
    toMs,
    STEP_MINUTES,
    reach.value,
  );
  reportStop(settled, edge);
  announceWidening(runs, subject.key, edge, settled?.widensEvent ?? null);
  if (settled === null) {
    await run(plan);
    return;
  }
  await runHeld(
    { missionKey: row.key, runKey: subject.key, edge, ms: settled.ms },
    plan,
  );
}

/**
 * The non-drag path, and the one that is specified rather than felt.
 *
 * `Shift` moves by a whole slot because that is the unit a coordinator thinks
 * in — "one more two-hour slot" — and a quarter-hour nudge would need eight
 * presses to say it.
 */
function onHandleKeydown(
  event: KeyboardEvent,
  row: MissionRow,
  subject: Run,
  edge: Edge,
): void {
  const from = edge === 'end' ? subject.endMs : subject.startMs;
  const stepMinutes = event.shiftKey
    ? board.cutMinutesFor(row.key)
    : STEP_MINUTES;
  const deltaMs = stepMinutes * MS_PER_MINUTE;

  if (event.key === 'ArrowLeft') {
    void moveEdgeTo(row, subject, edge, from - deltaMs);
  } else if (event.key === 'ArrowRight') {
    void moveEdgeTo(row, subject, edge, from + deltaMs);
  } else if (event.key === 'Home') {
    void moveEdgeTo(row, subject, edge, subject.boundsStartMs);
  } else if (event.key === 'End') {
    void moveEdgeTo(row, subject, edge, subject.boundsEndMs);
  } else {
    return;
  }
  event.preventDefault();
}

/**
 * Cut **one bar** at its mission's current slot length — the "divide this into
 * parts" action, and the one that turns a dashed proposal into rows.
 *
 * Per bar, not per mission. The button used to sit in the gutter and re-cut
 * every bar on the row, which on the festival-wide axis is every day at once:
 * a coordinator who wanted Saturday's bar in 90-minute slots re-cut Friday,
 * Sunday and the after as well, silently, and got no way at all to say
 * "Saturday only". A row is several days' work laid on one line (`runs.ts`),
 * and every other control on this board — the edges, the breaks, the removal —
 * acts on the one bar under the pointer. This one was the exception and the
 * exception was the bug.
 */
async function recutRun(row: MissionRow, subject: Run): Promise<void> {
  // Cutting cannot widen a day, so a notice left over from a drag that did
  // would be describing the wrong edit.
  lastStop.value = null;
  lastNotice.value = null;
  await run(planRecut(subject, board.cutMinutesFor(row.key)));
}

/**
 * Removing a bar is two clicks, not a dialog and not one.
 *
 * Server-side undo exists on the wire (ADR-0024) and has no surface in this
 * app yet, so a single click would be an unrecoverable delete of a
 * coordinator's afternoon. The second click is the recovery.
 */
const armedRemoval = ref<string | null>(null);

async function removeRun(row: MissionRow, subject: Run): Promise<void> {
  const token = `${row.key}/${subject.key}`;
  if (armedRemoval.value !== token) {
    armedRemoval.value = token;
    return;
  }
  armedRemoval.value = null;
  lastStop.value = null;
  lastNotice.value = null;
  await run(planDeleteRun(subject));
}

function isArmed(row: MissionRow, subject: Run): boolean {
  return armedRemoval.value === `${row.key}/${subject.key}`;
}

// ---------------------------------------------------------------------------
// The breaks inside a bar
// ---------------------------------------------------------------------------

/**
 * One join between two shifts, shown somewhere other than where they put it.
 *
 * Identified by its index rather than by its instant: a join being dragged is
 * by definition at an instant no shift starts at, so a key made of the instant
 * would stop matching the moment the gesture began.
 */
interface HeldCut {
  readonly missionKey: string;
  readonly runKey: string;
  readonly cutIndex: number;
  readonly ms: number;
}

interface CutDrag extends HeldCut {
  readonly laneLeft: number;
  readonly originMs: number;
  /** Which neighbouring shift this drop would swallow, if it has already been
   * pushed that far. */
  readonly merges: SettledCut['merges'];
}

const cutDrag = ref<CutDrag | null>(null);
const settlingCut = ref<HeldCut | null>(null);
const runHeldCut = heldRunner(settlingCut);

const heldCut = computed<HeldCut | null>(
  () => cutDrag.value ?? settlingCut.value,
);

/** Where a join is drawn: where the coordinator is holding it, or where the
 * shifts behind it say it is. */
function cutMsOf(row: MissionRow, subject: Run, cutIndex: number): number {
  const held = heldCut.value;
  return held !== null &&
    held.runKey === subject.key &&
    held.missionKey === row.key &&
    held.cutIndex === cutIndex
    ? held.ms
    : (subject.cutsMs[cutIndex] ?? subject.startMs);
}

/** How far a join may travel: the start of the shift before it and the end of
 * the shift after it, which are the two joins it merges into. */
function cutRangeOf(subject: Run, cutIndex: number): Period {
  const before = subject.shifts[cutIndex];
  const after = subject.shifts[cutIndex + 1];
  return before === undefined || after === undefined
    ? { startMs: subject.startMs, endMs: subject.endMs }
    : { startMs: before.startMs, endMs: Math.max(before.endMs, after.endMs) };
}

/** A merge is a deletion, so it is said out loud. Two joins that meet leave
 * one shift where there were two, and a board that did that silently would
 * read as one that lost a shift. */
function reportMerge(merges: SettledCut['merges']): void {
  lastStop.value = null;
  lastNotice.value = merges === null ? null : () => t('shifts.notice.merged');
}

function onCutPointerDown(
  event: PointerEvent,
  row: MissionRow,
  subject: Run,
  cutIndex: number,
): void {
  if (event.button !== 0) {
    return;
  }
  const handle = event.currentTarget;
  if (!(handle instanceof HTMLElement)) {
    return;
  }
  const lane = handle.closest('.evp-lane');
  if (!(lane instanceof HTMLElement)) {
    return;
  }

  handle.setPointerCapture(event.pointerId);
  cutDrag.value = {
    missionKey: row.key,
    runKey: subject.key,
    cutIndex,
    laneLeft: lane.getBoundingClientRect().left,
    originMs: subject.boundsStartMs,
    ms: subject.cutsMs[cutIndex] ?? subject.startMs,
    merges: null,
  };
  event.preventDefault();
}

function onCutPointerMove(event: PointerEvent): void {
  const current = cutDrag.value;
  const currentScale = scale.value;
  if (current === null || currentScale === null) {
    return;
  }
  const subject = runOf(current.missionKey, current.runKey);
  if (subject === undefined) {
    return;
  }

  const x = event.clientX - current.laneLeft;
  const raw = msAt(currentScale, x);
  const snapped = stickyMs(
    snapMs(raw, STEP_MINUTES, current.originMs),
    x,
    event.shiftKey,
  );
  // Settled through the same function the plan uses, so a join is never drawn
  // somewhere the drop will not put it.
  const settled = settledCut(subject, current.cutIndex, snapped);

  cutDrag.value = {
    ...current,
    ms: settled?.ms ?? snapped,
    merges: settled?.merges ?? null,
  };
}

async function onCutPointerUp(): Promise<void> {
  const current = cutDrag.value;
  cutDrag.value = null;
  if (current === null) {
    return;
  }
  const subject = runOf(current.missionKey, current.runKey);
  if (subject === undefined) {
    return;
  }

  reportMerge(current.merges);
  await runHeldCut(
    {
      missionKey: current.missionKey,
      runKey: current.runKey,
      cutIndex: current.cutIndex,
      ms: current.ms,
    },
    planCutMove(subject, current.cutIndex, current.ms),
  );
}

function onCutPointerCancel(): void {
  cutDrag.value = null;
}

/** The keyboard's equivalent of dragging a join, held for the same reason the
 * edges are: a key whose effect only appears once the writes are in reads as a
 * key that did nothing. */
async function moveCutTo(
  row: MissionRow,
  subject: Run,
  cutIndex: number,
  toMs: number,
): Promise<void> {
  const settled = settledCut(subject, cutIndex, toMs);
  if (settled === null) {
    return;
  }
  reportMerge(settled.merges);
  await runHeldCut(
    {
      missionKey: row.key,
      runKey: subject.key,
      cutIndex,
      ms: settled.ms,
    },
    planCutMove(subject, cutIndex, toMs),
  );
}

/**
 * `Home` and `End` merge rather than run to the ends of the day.
 *
 * On an edge those keys mean "fill this day", which is the action a
 * coordinator wants a key for. On a join the ends of the day are meaningless —
 * a join cannot leave the two shifts it divides — and the two instants that
 * *are* worth one keystroke are the ones the pointer reaches by shoving this
 * join into the next: the merges.
 */
function onCutKeydown(
  event: KeyboardEvent,
  row: MissionRow,
  subject: Run,
  cutIndex: number,
): void {
  const from = subject.cutsMs[cutIndex];
  const range = cutRangeOf(subject, cutIndex);
  if (from === undefined) {
    return;
  }
  const stepMinutes = event.shiftKey
    ? board.cutMinutesFor(row.key)
    : STEP_MINUTES;
  const deltaMs = stepMinutes * MS_PER_MINUTE;

  if (event.key === 'ArrowLeft') {
    void moveCutTo(row, subject, cutIndex, from - deltaMs);
  } else if (event.key === 'ArrowRight') {
    void moveCutTo(row, subject, cutIndex, from + deltaMs);
  } else if (event.key === 'Home') {
    void moveCutTo(row, subject, cutIndex, range.startMs);
  } else if (event.key === 'End') {
    void moveCutTo(row, subject, cutIndex, range.endMs);
  } else {
    return;
  }
  event.preventDefault();
}

// ---------------------------------------------------------------------------
// Two series in one day
// ---------------------------------------------------------------------------

/**
 * Break one bar in two, so a post can be staffed for the afternoon and again
 * for the night without being staffed for the six hours in between.
 *
 * The gap it opens is one step wide, which is a real fifteen minutes taken off
 * the board rather than a boundary: two bars that touch are one bar on the
 * next render (`runs.ts`), so a split that cost nothing would not be a split.
 * The coordinator's next gesture is to drag the new edges to where the break
 * really is, which is why the board says so rather than leaving them to find
 * fifteen minutes missing.
 */
async function splitRun(
  row: MissionRow,
  subject: Run,
  atMs: number,
): Promise<void> {
  const plan = planSplitRun(subject, atMs, STEP_MINUTES);
  lastStop.value = null;

  if (plan.length === 0) {
    lastNotice.value = subject.proposed
      ? () =>
          t('shifts.notice.splitUncut', {
            mission: row.name,
            day: subject.eventName,
          })
      : () => t('shifts.notice.splitNoRoom');
    return;
  }

  lastNotice.value = () =>
    t('shifts.notice.split', {
      mission: row.name,
      day: subject.eventName,
      minutes: STEP_MINUTES,
    });
  await run(plan);
}

/** The pointer path: split where the coordinator pointed. */
function onRunDoubleClick(
  event: MouseEvent,
  row: MissionRow,
  subject: Run,
): void {
  const target = event.target;
  // The handles and the chip's own controls are their own gestures; a double
  // click that lands on one of them is two clicks of that control, not a
  // request to divide the bar under it.
  if (
    target instanceof Element &&
    target.closest('.evp-handle, .evp-cut-mark, button') !== null
  ) {
    return;
  }
  const chip = event.currentTarget;
  if (!(chip instanceof HTMLElement)) {
    return;
  }
  const lane = chip.closest('.evp-lane');
  const currentScale = scale.value;
  if (!(lane instanceof HTMLElement) || currentScale === null) {
    return;
  }

  const raw = msAt(
    currentScale,
    event.clientX - lane.getBoundingClientRect().left,
  );
  void splitRun(row, subject, snapMs(raw, STEP_MINUTES, subject.boundsStartMs));
}

/** And the non-pointer path (WCAG 2.2 AA 2.5.7, a CI gate): split at the join
 * nearest the middle, which is the one place a bar can be divided without an
 * instant to point at. */
function splitAtMiddle(row: MissionRow, subject: Run): void {
  void splitRun(row, subject, middleOf(subject, STEP_MINUTES));
}

// ---------------------------------------------------------------------------
// Drawing a new series on empty lane
// ---------------------------------------------------------------------------

/** A series being drawn, or one drawn and not yet confirmed. */
interface PendingRun {
  readonly missionKey: string;
  readonly laneRow: number;
  readonly color: number;
  readonly range: Period;
}

interface NewRunDrag {
  readonly missionKey: string;
  readonly eventId: string;
  readonly locationId: string;
  readonly laneRow: number;
  readonly color: number;
  readonly laneLeft: number;
  readonly anchorMs: number;
  readonly window: Period;
  /** What the drop would fill, settled through the same function the plan
   * uses. `null` while the gesture is still shorter than one step. */
  readonly range: Period | null;
}

const newRunDrag = ref<NewRunDrag | null>(null);
const settlingNew = ref<PendingRun | null>(null);
const runHeldNew = heldRunner(settlingNew);

/** The day an instant falls in, which is the day a new series would belong
 * to. Shifts live inside one event and a constraint trigger enforces it
 * (docs/02 §5), so empty axis between the days is not somewhere to draw. */
function windowAt(ms: number): EventWindow | null {
  return (
    windows.value.find((window) => ms >= window.startMs && ms < window.endMs) ??
    null
  );
}

/**
 * Start drawing a series on a stretch of empty lane.
 *
 * Only on the lane itself: the chips, their handles and their controls are all
 * children of it, so a press that landed on one of those would start a second
 * gesture underneath the one the coordinator meant. The decorations — the
 * hatched margins, the day rules, the fold marks — are `pointer-events: none`
 * for the same reason, and that is what makes this one test enough.
 */
function onLanePointerDown(event: PointerEvent, row: LaidRow): void {
  if (event.button !== 0 || event.target !== event.currentTarget) {
    return;
  }
  const lane = event.currentTarget;
  const currentScale = scale.value;
  if (!(lane instanceof HTMLElement) || currentScale === null) {
    return;
  }

  const box = lane.getBoundingClientRect();
  const pressX = event.clientX - box.left;
  const raw = msAt(currentScale, pressX);
  const window = windowAt(raw);
  if (window === null) {
    lastStop.value = null;
    lastNotice.value = () => t('shifts.notice.noDay');
    return;
  }

  // Which sub-row was pressed decides which of the mission's posts is meant
  // when a festival-wide row carries several; the day decides the rest.
  const laneRow =
    row.rowCount <= 1
      ? 0
      : Math.min(
          row.rowCount - 1,
          Math.max(
            0,
            Math.floor(((event.clientY - box.top) / box.height) * row.rowCount),
          ),
        );
  const sibling =
    row.lanes.find(
      (placed) => placed.row === laneRow && placed.item.eventId === window.id,
    )?.item ?? row.runs.find((subject) => subject.eventId === window.id);

  if (sibling === undefined) {
    lastStop.value = null;
    lastNotice.value = () =>
      t('shifts.notice.notAPost', { mission: row.name, day: window.name });
    return;
  }

  lane.setPointerCapture(event.pointerId);
  newRunDrag.value = {
    missionKey: row.key,
    eventId: window.id,
    locationId: sibling.locationId,
    laneRow,
    color: window.color,
    laneLeft: box.left,
    anchorMs: stickyMs(
      snapMs(raw, STEP_MINUTES, window.startMs),
      pressX,
      event.shiftKey,
    ),
    window: { startMs: window.startMs, endMs: window.endMs },
    range: null,
  };
  event.preventDefault();
}

function onLanePointerMove(event: PointerEvent): void {
  const current = newRunDrag.value;
  const currentScale = scale.value;
  if (current === null || currentScale === null) {
    return;
  }

  const x = event.clientX - current.laneLeft;
  const raw = msAt(currentScale, x);
  newRunDrag.value = {
    ...current,
    range: settledNewRun({
      runs: runsOf(current.missionKey),
      locationId: current.locationId,
      window: current.window,
      anchorMs: current.anchorMs,
      toMs: stickyMs(
        snapMs(raw, STEP_MINUTES, current.window.startMs),
        x,
        event.shiftKey,
      ),
      stepMinutes: STEP_MINUTES,
    }),
  };
}

async function onLanePointerUp(): Promise<void> {
  const current = newRunDrag.value;
  newRunDrag.value = null;
  if (current?.range == null) {
    return;
  }

  lastStop.value = null;
  lastNotice.value = null;
  // Held like every other drop: the shifts are written one at a time and the
  // board re-read afterwards, and a stretch that vanished for that round trip
  // would read as a gesture the board refused.
  await runHeldNew(
    {
      missionKey: current.missionKey,
      laneRow: current.laneRow,
      color: current.color,
      range: current.range,
    },
    planNewRun(
      current.eventId,
      current.locationId,
      current.range,
      board.cutMinutesFor(current.missionKey),
    ),
  );
}

function onLanePointerCancel(): void {
  newRunDrag.value = null;
}

/**
 * The outline of a series being drawn, or one drawn and still landing — as a
 * list of none or one.
 *
 * A list rather than a nullable, because a template has no way to name the
 * result of a call: `v-if` followed by a second call would compute it twice,
 * and the second call happens after a `pointermove` may have changed it.
 */
function ghostsOf(row: MissionRow): readonly PendingRun[] {
  const ghost = ghostOf(row);
  return ghost === null ? [] : [ghost];
}

function ghostOf(row: MissionRow): PendingRun | null {
  const drawing = newRunDrag.value;
  if (
    drawing !== null &&
    drawing.missionKey === row.key &&
    drawing.range !== null
  ) {
    return {
      missionKey: drawing.missionKey,
      laneRow: drawing.laneRow,
      color: drawing.color,
      range: drawing.range,
    };
  }
  const pending = settlingNew.value;
  return pending !== null && pending.missionKey === row.key ? pending : null;
}

function ghostStyle(ghost: PendingRun): Record<string, string> {
  return {
    ...boxStyle(ghost.range.startMs, ghost.range.endMs),
    top: `${String(laneTopRem(ghost.laneRow))}rem`,
    '--evp-run-color': eventColor(ghost.color),
  };
}

// ---------------------------------------------------------------------------
// Tool settings
// ---------------------------------------------------------------------------

function numberFrom(target: EventTarget | null): number | null {
  if (!(target instanceof HTMLInputElement)) {
    return null;
  }
  const value = Number.parseInt(target.value, 10);
  return Number.isNaN(value) ? null : value;
}

function onDefaultCutInput(event: Event): void {
  const value = numberFrom(event.target);
  if (value !== null) {
    board.setDefaultCutMinutes(value);
  }
}

function onMissionCutInput(event: Event, row: MissionRow): void {
  const value = numberFrom(event.target);
  if (value !== null) {
    board.setCutMinutes(row.key, value);
  }
}

function onZoomInput(event: Event): void {
  const value = numberFrom(event.target);
  if (value !== null) {
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
 * mission list. Without the modifier the event is left alone.
 */
function onBoardWheel(event: WheelEvent): void {
  if (!event.ctrlKey) {
    return;
  }
  event.preventDefault();
  const notches = -event.deltaY / WHEEL_NOTCH_PIXELS;
  board.setPixelsPerHour(board.pixelsPerHour + notches * ZOOM_STEP_PER_NOTCH);
}

const isPending = computed(() => scopePending.value || boardPending.value);
const isSaving = computed(() => apply.isPending.value);

function shiftCountOf(subject: Run): number {
  return subject.shifts.length;
}

/** The word above a bar. "saving…" outranks "not cut yet": a proposal whose
 * first slots are already in flight is no longer uncut. */
function metaLabelOf(row: MissionRow, subject: Run): string {
  if (isSettling(row, subject)) {
    return t('shifts.run.saving');
  }
  return shiftCountOf(subject) === 0 ? t('shifts.run.notCut') : '';
}

/**
 * Where a chip sits, and what colour it is.
 *
 * The colour is passed as a custom property rather than as `background`
 * because the chip is not a flat fill: the stylesheet spends it on the fill,
 * on the dashed outline of a proposal, and on the tint under the shift
 * dividers, and three rules reading one property is what keeps a chip and its
 * line on the strip provably the same colour.
 */
function runStyle(row: LaidRow, subject: Run): Record<string, string> {
  return {
    ...boxStyle(runStartMs(row, subject), runEndMs(row, subject)),
    // Which sub-row of its mission this bar sits on. Inline rather than in the
    // stylesheet because the depth is data: a mission run by two days at once
    // is two bars deep and one run by six days in a row is still one.
    top: `${String(laneTopRem(laneRowOf(row, subject)))}rem`,
    '--evp-run-color': eventColor(subject.color),
  };
}

/** What a bar says to a screen reader: the mission, the day, the clock, and
 * the zone it is worked in — never the viewer's. */
function runLabel(row: MissionRow, subject: Run): string {
  return t('shifts.run.label', {
    mission: row.name,
    day: subject.eventName,
    start: clockAt(runStartMs(row, subject), subject.timezone),
    end: clockAt(runEndMs(row, subject), subject.timezone),
  });
}
</script>

<template>
  <!-- Keys and buttons at the start of a line, each followed by what it
       does: a sentence with the key in the middle of it cannot be one
       message, and word order is the translator's to choose. -->
  <HelpModal :title="t('shifts.title')">
    <p>{{ t('shifts.help.edges') }}</p>
    <p>{{ t('shifts.help.draw') }}</p>
    <p>{{ t('shifts.help.hours') }}</p>
    <ul class="evp-help-keys">
      <li>
        <kbd>{{ t('shifts.run.cut') }}</kbd>
        <kbd>{{ t('shifts.run.split') }}</kbd> <kbd>×</kbd>
        {{ t('shifts.help.does.barControls') }}
      </li>
      <li>
        <kbd>{{ t('shifts.help.keys.shift') }}</kbd>
        {{ t('shifts.help.does.shift') }}
      </li>
      <li>
        <kbd>←</kbd> <kbd>→</kbd>
        {{ t('shifts.help.does.arrows', { minutes: STEP_MINUTES }) }}
      </li>
      <li>
        <kbd>{{ t('shifts.help.keys.home') }}</kbd>
        <kbd>{{ t('shifts.help.keys.end') }}</kbd>
        {{ t('shifts.help.does.homeEnd') }}
      </li>
      <li>
        <kbd>{{ t('board.fold.glyph') }}</kbd> {{ t('shifts.help.does.fold') }}
      </li>
      <li>
        <kbd>{{ t('shifts.help.keys.ctrl') }}</kbd>
        {{ t('shifts.help.keys.wheel') }} {{ t('shifts.help.does.wheel') }}
      </li>
    </ul>
    <p>{{ t('shifts.help.outside') }}</p>
    <p>
      {{ t('shifts.help.doors') }}
      <RouterLink :to="{ name: detailsRoute, params: detailsParams }">{{
        t('shifts.help.doorsLink')
      }}</RouterLink>
    </p>
  </HelpModal>

  <div class="evp-tools">
    <label class="evp-tool" for="board-cut">
      <span class="evp-tool-label"
        >{{ t('shifts.tools.cutLength') }}
        <span class="evp-unit">{{ t('shifts.tools.cutUnit') }}</span></span
      >
      <input
        id="board-cut"
        class="evp-number"
        type="number"
        inputmode="numeric"
        :min="board.MIN_CUT_MINUTES"
        :max="board.MAX_CUT_MINUTES"
        :step="board.MIN_CUT_MINUTES"
        :value="board.defaultCutMinutes"
        @change="onDefaultCutInput"
      />
    </label>

    <label class="evp-tool" for="board-zoom">
      <span class="evp-tool-label"
        >{{ t('shifts.tools.zoom') }}
        <span class="evp-unit">{{ t('shifts.tools.zoomUnit') }}</span></span
      >
      <input
        id="board-zoom"
        class="evp-zoom"
        type="range"
        :min="board.MIN_PIXELS_PER_HOUR"
        :max="board.MAX_PIXELS_PER_HOUR"
        step="4"
        :value="board.pixelsPerHour"
        @input="onZoomInput"
      />
    </label>
  </div>

  <p v-if="isPending">{{ t('common.status.loading') }}</p>

  <template v-else>
    <p v-if="rows.length === 0" class="evp-empty">
      {{ t('shifts.empty.lead') }}
      <RouterLink :to="{ name: missionsRoute, params: detailsParams }">{{
        t('shifts.empty.link')
      }}</RouterLink>
    </p>

    <div v-else class="evp-board" :aria-busy="isSaving">
      <div class="evp-scroll" @wheel="onBoardWheel">
        <div class="evp-axis">
          <!-- The gutter's twin, pinned the same way, so the ruler cannot
               slide out of step with the rows beneath it. It carries the
               column's name rather than sitting empty. -->
          <div
            class="evp-gutter evp-gutter--spacer"
            :style="{ height: axisHeight }"
          >
            <span class="evp-column-head">{{ t('shifts.columnHead') }}</span>
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
                 screen, and a coordinator staffing a 04:00 load-out on a
                 night nothing else runs has to be able to disagree — with the
                 keyboard as readily as the pointer (docs/14 §1). -->
            <button
              v-for="fold in foldMarks"
              :key="fold.key"
              type="button"
              class="evp-fold"
              :style="boxStyle(fold.startMs, fold.endMs)"
              @click="toggleFold(fold.startMs)"
            >
              <span class="evp-fold-glyph" aria-hidden="true">{{
                t('board.fold.glyph')
              }}</span>
              <span class="evp-fold-length" aria-hidden="true">{{
                fold.label
              }}</span>
              <span class="evp-visually-hidden">
                {{
                  t('shifts.fold.show', {
                    length: fold.label,
                    start: clockAt(fold.startMs, axisTimezone),
                    end: clockAt(fold.endMs, axisTimezone),
                  })
                }}
              </span>
            </button>

            <!-- And the way back. Pinned to the start of the stretch it
                 opened rather than centred in it: at this zoom that stretch
                 is most of a screen, and a control in the middle of it is a
                 control nobody scrolls to. -->
            <button
              v-for="fold in openedMarks"
              :key="fold.key"
              type="button"
              class="evp-fold evp-fold--open"
              :style="atStyle(fold.startMs)"
              @click="toggleFold(fold.startMs)"
            >
              <span class="evp-fold-glyph" aria-hidden="true">{{
                t('board.fold.glyph')
              }}</span>
              <span class="evp-visually-hidden">
                {{
                  t('shifts.fold.hide', {
                    length: fold.label,
                    start: clockAt(fold.startMs, axisTimezone),
                    end: clockAt(fold.endMs, axisTimezone),
                  })
                }}
              </span>
            </button>

            <!-- Where the published hours were, on a day that has since been
                 worked around them. The bar staff moved; the doors did not. -->
            <span
              v-for="mark in publicMarks"
              :key="mark.key"
              class="evp-public-mark"
              :style="atStyle(mark.atMs)"
            >
              {{ mark.label }}
            </span>

            <!-- The days themselves, each in its own colour and carrying its
                 name. Real text, not a legend keyed by colour: the name is
                 what a coordinator reads, and a strip that said "Saturday"
                 only in pink would say nothing at all to a viewer who cannot
                 tell it from the day above (docs/14 §2). -->
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
          v-for="(row, index) in laidRows"
          :key="row.key"
          class="evp-row"
          role="group"
          :aria-label="row.name"
        >
          <div class="evp-gutter">
            <span class="evp-mission-name">
              {{ row.name }}
              <!-- Narrowed to one day, this is the fact the day cannot show
                   for itself: the mission is the festival's, not the day's. -->
              <span v-if="row.alsoAtDays > 0" class="evp-also">
                {{ t('shifts.row.alsoAtDays', { count: row.alsoAtDays }) }}
              </span>
            </span>
            <!-- The length, here; the cutting, on the bars. This input is a
                 property of the *mission* — "Bar runs in 90-minute slots" is
                 true of Bar, not of Saturday — and it decides what every
                 gesture on the row's bars writes. Which bar gets cut is a
                 different question, and it is answered by the bar. -->
            <span class="evp-gutter-controls">
              <!-- Identified by index rather than by mission key: the key is a
                   name a coordinator typed, and a name with a space or a
                   quote in it is not an `id` a `for` can reach. -->
              <label
                class="evp-gutter-cut"
                :for="`mission-cut-${String(index)}`"
              >
                <span class="evp-visually-hidden">
                  {{ t('shifts.row.cutLengthLabel', { mission: row.name }) }}
                </span>
                <input
                  :id="`mission-cut-${String(index)}`"
                  class="evp-number evp-number--small"
                  type="number"
                  inputmode="numeric"
                  :min="board.MIN_CUT_MINUTES"
                  :max="board.MAX_CUT_MINUTES"
                  :step="board.MIN_CUT_MINUTES"
                  :value="board.cutMinutesFor(row.key)"
                  @change="onMissionCutInput($event, row)"
                />
              </label>
            </span>
          </div>

          <!-- Pressing the lane itself — never a chip, a handle or one of the
               decorations, which are all `pointer-events: none` — draws a new
               series on the empty stretch under the pointer. -->
          <div
            class="evp-lane"
            :style="{
              width: `${String(laneWidth)}px`,
              height: laneHeight(row),
            }"
            @pointerdown="onLanePointerDown($event, row)"
            @pointermove="onLanePointerMove"
            @pointerup="onLanePointerUp"
            @pointercancel="onLanePointerCancel"
          >
            <!-- Time that is on the board but in no day. Shaded so that
                 "drag a bar out here and the day grows to meet it" is
                 something the board shows rather than something a
                 coordinator has to be told. -->
            <span
              v-for="edge in margins"
              :key="edge.key"
              class="evp-lane-outside"
              :style="boxStyle(edge.startMs, edge.endMs)"
              aria-hidden="true"
            />

            <!-- The same break, straight down the board. Without it a chip
                 either side of a fold reads as one continuous afternoon, and
                 the whole point of the marker is that those two chips are not
                 next to each other in time. The label lives once, on the
                 ruler. -->
            <span
              v-for="fold in foldMarks"
              :key="fold.key"
              class="evp-lane-fold"
              :style="boxStyle(fold.startMs, fold.endMs)"
              aria-hidden="true"
            />

            <!-- Doors open and doors close, straight down the board. The
                 label lives once on the ruler; what every row needs is the
                 line, so that "this shift starts before we open" is a thing
                 you see rather than a sum you do. -->
            <span
              v-for="mark in publicMarks"
              :key="mark.key"
              class="evp-public-rule"
              :style="atStyle(mark.atMs)"
              aria-hidden="true"
            />

            <!-- One band per day behind the bars, so a bar that crosses
                 midnight reads as one stretch of work rather than as two. -->
            <span
              v-for="band in bands"
              :key="band.startMs"
              class="evp-lane-band"
              :style="atStyle(band.startMs)"
              aria-hidden="true"
            />

            <!-- Every civil hour, straight down the board, so a bar starting
                 on the hour is something you see rather than something you
                 read the clock to check. The same grid a drag is sticky
                 to. -->
            <span
              v-for="mark in hourMarks"
              :key="mark.key"
              class="evp-hour-line"
              :style="atStyle(mark.atMs)"
              aria-hidden="true"
            />

            <!-- The stretch a drag is drawing, or one drawn and still being
                 written. Outlined rather than filled: nothing backs it yet,
                 which is the same thing an uncut proposal says. -->
            <div
              v-for="ghost in ghostsOf(row)"
              :key="ghost.range.startMs"
              class="evp-run evp-run--ghost"
              :style="ghostStyle(ghost)"
              aria-hidden="true"
            />

            <!-- A group, because that is what a bar is: two edge sliders, a
                 break slider per join, and the three buttons that act on the
                 whole of it. The double click is an enhancement on top of the
                 `split` button inside it, never the only way to divide a bar
                 (WCAG 2.2 AA 2.5.7, ADR-0017). -->
            <!-- eslint-disable-next-line vuejs-accessibility/no-static-element-interactions -- the bar is a group of controls, not a control; `dblclick` here is a pointer shortcut for the `split` button inside it, which is the keyboard path the rule exists to protect (WCAG 2.2 AA 2.5.7). Making the group itself focusable would put a stop between every edge slider and its own breaks. -->
            <div
              v-for="subject in row.runs"
              :key="subject.key"
              class="evp-run"
              :class="{ 'evp-run--proposed': subject.proposed }"
              :style="runStyle(row, subject)"
              role="group"
              :aria-label="runLabel(row, subject)"
              @dblclick="onRunDoubleClick($event, row, subject)"
            >
              <!-- The range is the *axis*, not the day. An edge may now be
                   put past the end of its event — that is what lengthens the
                   event — so a range of the day's own period would be a
                   slider reporting `aria-valuenow` outside its own bounds for
                   the length of every such drag. `Home`/`End` still run to
                   the day's edges rather than the axis's, because "fill the
                   day" is the action a coordinator wants a key for and
                   "stretch the day by two hours" is not. -->
              <span
                class="evp-handle evp-handle--start"
                role="slider"
                tabindex="0"
                :aria-label="
                  t('shifts.run.start', { bar: runLabel(row, subject) })
                "
                :aria-valuemin="reach.startMs"
                :aria-valuemax="reach.endMs"
                :aria-valuenow="runStartMs(row, subject)"
                :aria-valuetext="
                  clockAt(runStartMs(row, subject), subject.timezone)
                "
                @pointerdown="onPointerDown($event, row, subject, 'start')"
                @pointermove="onPointerMove"
                @pointerup="onPointerUp"
                @pointercancel="onPointerCancel"
                @keydown="onHandleKeydown($event, row, subject, 'start')"
              />

              <!-- The breaks: the joins between adjacent shifts, and the only
                   thing a "default cut" ever is. They are what makes one chip
                   readable as four shifts rather than as one long one — and
                   they are draggable, because where one shift hands over to
                   the next is the single most-edited fact on a real plan. A
                   slider like the edges, and bounded by its own two
                   neighbours: pushed onto one of them, the shift in between
                   has no minutes left and the two become one. -->
              <span
                v-for="(cut, cutIndex) in subject.cutsMs"
                :key="cut"
                class="evp-cut-mark"
                role="slider"
                tabindex="0"
                :aria-label="
                  t('shifts.run.break', {
                    index: cutIndex + 1,
                    bar: runLabel(row, subject),
                  })
                "
                :aria-valuemin="cutRangeOf(subject, cutIndex).startMs"
                :aria-valuemax="cutRangeOf(subject, cutIndex).endMs"
                :aria-valuenow="cutMsOf(row, subject, cutIndex)"
                :aria-valuetext="
                  clockAt(cutMsOf(row, subject, cutIndex), subject.timezone)
                "
                :style="
                  offsetStyle(
                    runStartMs(row, subject),
                    cutMsOf(row, subject, cutIndex),
                  )
                "
                @pointerdown="onCutPointerDown($event, row, subject, cutIndex)"
                @pointermove="onCutPointerMove"
                @pointerup="onCutPointerUp"
                @pointercancel="onCutPointerCancel"
                @keydown="onCutKeydown($event, row, subject, cutIndex)"
              />

              <!-- A bar held at a length nothing has confirmed says so, in
                   words: it is drawn as though the edit landed, and a board
                   that shows an unsaved length silently is a board that will
                   be believed when the write is refused. -->
              <span class="evp-run-meta" aria-hidden="true">
                {{ metaLabelOf(row, subject) }}
              </span>

              <!-- One bar's own controls, and every one of them acts on this
                   bar alone. The row is several days laid on one line, so a
                   control that meant "the whole row" — as Cut used to — is a
                   control that edits days the coordinator is not looking
                   at. -->
              <span class="evp-run-controls">
                <button
                  class="evp-cut-button"
                  type="button"
                  :disabled="isSaving"
                  :aria-label="
                    t('shifts.run.cutLabel', {
                      bar: runLabel(row, subject),
                      minutes: board.cutMinutesFor(row.key),
                    })
                  "
                  @click="recutRun(row, subject)"
                >
                  {{ t('shifts.run.cut') }}
                </button>

                <!-- The keyboard's way to the double click. A proposal has no
                     shifts to divide, so it is offered a cut and nothing
                     else. -->
                <button
                  v-if="!subject.proposed"
                  class="evp-split-button"
                  type="button"
                  :disabled="isSaving"
                  :aria-label="
                    t('shifts.run.splitLabel', { bar: runLabel(row, subject) })
                  "
                  @click="splitAtMiddle(row, subject)"
                >
                  {{ t('shifts.run.split') }}
                </button>

                <button
                  v-if="!subject.proposed"
                  class="evp-remove"
                  :class="{ 'evp-remove--armed': isArmed(row, subject) }"
                  type="button"
                  :disabled="isSaving"
                  :aria-label="
                    isArmed(row, subject)
                      ? t('shifts.run.removeConfirmLabel', {
                          count: shiftCountOf(subject),
                          bar: runLabel(row, subject),
                        })
                      : t('shifts.run.removeLabel', {
                          bar: runLabel(row, subject),
                        })
                  "
                  @click="removeRun(row, subject)"
                  @blur="armedRemoval = null"
                >
                  {{
                    isArmed(row, subject) ? t('shifts.run.removeConfirm') : '×'
                  }}
                </button>
              </span>

              <span
                class="evp-handle evp-handle--end"
                role="slider"
                tabindex="0"
                :aria-label="
                  t('shifts.run.end', { bar: runLabel(row, subject) })
                "
                :aria-valuemin="reach.startMs"
                :aria-valuemax="reach.endMs"
                :aria-valuenow="runEndMs(row, subject)"
                :aria-valuetext="
                  clockAt(runEndMs(row, subject), subject.timezone)
                "
                @pointerdown="onPointerDown($event, row, subject, 'end')"
                @pointermove="onPointerMove"
                @pointerup="onPointerUp"
                @pointercancel="onPointerCancel"
                @keydown="onHandleKeydown($event, row, subject, 'end')"
              />
            </div>
          </div>
        </div>
      </div>
    </div>

    <section
      v-if="visibleBoard.unplacedShifts.length > 0"
      aria-labelledby="unplaced-heading"
      class="evp-unplaced"
    >
      <h3 id="unplaced-heading">{{ t('shifts.unplaced.heading') }}</h3>
      <p class="evp-muted">{{ t('shifts.unplaced.body') }}</p>
      <ul>
        <li v-for="shift in visibleBoard.unplacedShifts" :key="shift.id">
          {{
            t('shifts.unplaced.item', {
              title: shift.title,
              start: clockAt(instantOf(shift.period.start), shift.timezone),
              end: clockAt(instantOf(shift.period.end), shift.timezone),
            })
          }}
        </li>
      </ul>
    </section>
  </template>
  <ToastStack>
    <template v-if="!isPending">
      <ToastMessage v-if="locationsFailed" tone="danger">
        {{ t('shifts.failed.locations') }}
      </ToastMessage>
      <ToastMessage v-if="shiftsFailed" tone="danger">
        {{ t('shifts.failed.shifts') }}
      </ToastMessage>
    </template>
    <ToastMessage
      v-if="lastRejection !== null"
      tone="danger"
      dismissible
      @dismiss="dismissRejection"
    >
      {{ lastRejection() }}
      <span v-if="partial !== null">
        {{ t('shifts.rejection.partial', { count: partial }) }}
      </span>
    </ToastMessage>
    <!-- `info` (a status, not an alert): the day moved, or stopped moving,
         because the coordinator asked it to. This is the board reporting what
         it did with the gesture, not interrupting them over something that
         went wrong. -->
    <ToastMessage
      v-if="lastNotice !== null"
      dismissible
      @dismiss="lastNotice = null"
    >
      {{ lastNotice() }}
    </ToastMessage>
    <ToastMessage
      v-if="lastStop !== null"
      dismissible
      @dismiss="lastStop = null"
    >
      {{ lastStop() }}
    </ToastMessage>
  </ToastStack>
</template>

<style scoped>
.evp-help-keys {
  display: grid;
  gap: 0.375rem;
  list-style: none;
  margin: 0 0 1rem;
  padding: 0;
}

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

h3 {
  font-size: 1rem;
  margin: 0 0 0.5rem;
}

.evp-tool {
  align-items: center;
  display: flex;
  gap: 0.5rem;
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

.evp-number {
  background: var(--evp-surface);
  border: 1px solid var(--evp-border);
  border-radius: 0.375rem;
  color: var(--evp-text);
  /* 24 px floor from docs/14 §2, reached with real height rather than with a
     transparent overlay that a touch device cannot find. */
  min-height: 1.75rem;
  padding: 0.25rem 0.375rem;
  width: 4.5rem;
}

.evp-number--small {
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--evp-border);
  border-radius: 0;
  font-size: 0.6875rem;
  min-height: 1.25rem;
  padding: 0 0.125rem;
  text-align: right;
  width: 2.25rem;
}

.evp-number--small:focus-visible {
  border-bottom-color: var(--evp-accent);
}

.evp-zoom {
  width: 8rem;
}

kbd {
  background: var(--evp-surface-raised);
  border: 1px solid var(--evp-border);
  border-radius: 0.25rem;
  font-size: 0.75rem;
  padding: 0 0.25rem;
}

.evp-empty,
.evp-muted {
  color: var(--evp-text-muted);
  max-width: 60ch;
}

.evp-board {
  border: 1px solid var(--evp-border);
  border-radius: 0.5rem;
  overflow: hidden;
}

/**
 * The one place this application scrolls sideways.
 *
 * docs/14 §2 forbids horizontal scrolling for content at 320 px; a timeline is
 * the 2-D data WCAG 1.4.10 exempts, and the mission names stay pinned so the
 * rows never lose their labels.
 */
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

/* Height is set inline, not here: the ruler is three rows — the date, the
   clock, and the published hours of a day that has been worked around them —
   plus one row per row of the event strip, and how many of those there are is
   a property of the festival. The gutter's spacer is given the same value from
   the same computed, so the two cannot drift. */
.evp-axis-track {
  position: relative;
}

/**
 * The days, as colour.
 *
 * A labelled line rather than a bare rule: the name is what a coordinator
 * reads and the colour is what ties it to the chips below, and a strip that
 * carried only the colour would be information conveyed by colour alone
 * (docs/14 §2). White text on all 64 entries is sound because every one of
 * them clears 4.5:1 against white — that is the property the palette is
 * generated for and tested on (`packages/shared/src/eventColors.ts`), and the
 * swatch grid on the event details page leans on the same fact.
 */
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
   a centred first label is half-clipped by the pinned gutter, and a centred
   last one overhangs the end of the axis. */
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
  /* A column, not a row: at 12 rem the name and its two controls competed for
     the same line and "Prévention VHSS" came out as "Préventi / on VHSS". */
  flex-direction: column;
  gap: 0.25rem;
  /* Pinned, so scrolling to Sunday never leaves a coordinator looking at four
     anonymous rows. */
  left: 0;
  justify-content: center;
  /* Bottom-right corner is reserved for .evp-gutter-controls, which is
     positioned absolutely against this box rather than sharing the flow with
     the mission name — the slot-length input is a quiet corner note, not a
     second line competing with the name for width. */
  padding: 0.5rem 2.75rem 0.5rem 0.625rem;
  position: sticky;
  width: 13.5rem;
  border-right: 1px solid var(--evp-border);
  z-index: 2;
}

.evp-also {
  color: var(--evp-text-muted);
  display: block;
  font-size: 0.6875rem;
  font-weight: 400;
}

.evp-mission-name {
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.25;
  /* Wraps rather than truncating: a mission name a coordinator cannot read is
     not a row (docs/14 §2). `break-word`, not `anywhere` — the latter breaks
     inside a word that would have fitted on its own line. */
  overflow-wrap: break-word;
}

.evp-gutter-controls {
  align-items: center;
  bottom: 0.375rem;
  display: flex;
  position: absolute;
  right: 0.375rem;
}

.evp-cut-button {
  background: var(--evp-surface-raised);
  border: 1px solid var(--evp-border);
  border-radius: 0.375rem;
  color: var(--evp-text);
  cursor: pointer;
  font-size: 0.75rem;
  min-height: 1.75rem;
  padding: 0.125rem 0.5rem;
}

.evp-cut-button:hover:not(:disabled) {
  background: var(--evp-accent);
  border-color: var(--evp-accent);
  color: var(--evp-on-accent);
}

.evp-cut-button:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.evp-lane {
  /* Height is set inline: a mission run by two days at once is two bars deep
     (`lanes.ts`), and the fallback here is the one-bar case. */
  height: 3rem;
  position: relative;
  /* A press on the lane draws a new series, and a drag that started on it must
     not be interrupted by the browser selecting the row's text. */
  touch-action: none;
}

/* The decorations are drawn *under* the gesture, not in it: every one of them
   is `aria-hidden` and none is a control, so a press that landed on one would
   be a press the coordinator aimed at the empty lane behind it. */
.evp-lane-outside,
.evp-lane-band,
.evp-lane-fold,
.evp-public-rule,
.evp-hour-line {
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
   colours it disappears in both. A texture survives all three, and it is the
   convention for "nothing here yet" rather than "something greyed out". */
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

/**
 * The ellipsis: hours with no day on them, crushed to a marker.
 *
 * Full height of the ruler, and dashed on both sides, because what it marks is
 * a *discontinuity* — the tick to its left and the tick to its right are
 * thirteen hours apart on a board where every other pair of ticks is an hour.
 * A gap in the ruler is the only drawing of that which cannot be read as more
 * ruler.
 *
 * It carries its length in words as well as the glyph. An ellipsis alone says
 * "something is missing" and makes the coordinator open it to find out what,
 * which is the scrolling the fold exists to save (docs/14 §2).
 */
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

/* The way back, once a stretch is open. Positioned from its left edge alone,
   so it needs its own width — 1.5rem is WCAG 2.2 AA 2.5.8's 24 px floor, and
   this control is small precisely because the thing it would undo is now on
   screen and does not need selling. */
.evp-fold--open {
  background: var(--evp-surface);
  border-right: 0;
  cursor: zoom-out;
  width: 1.5rem;
}

/* Down every row, so two chips either side of a fold cannot read as one
   continuous afternoon. Softer than the ruler's marker: this one is a
   reminder, and repeating it at full strength on twenty rows would make the
   break louder than the work. */
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

/* Its own row under the clock, rather than sharing one with the date: at the
   default zoom a day band and a doors label land within a few pixels of each
   other, and two labels fighting for the same line is how a ruler stops being
   readable. */
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

/* The grid a start time is read against, and a drag is sticky to. Fainter
   than the day bands it sits alongside — the day boundary is a fact about the
   festival, this is a ruler a coordinator can take or leave, and it must not
   outweigh the bar drawn on top of it. */
.evp-hour-line {
  border-left: 1px solid var(--evp-border);
  bottom: 0;
  opacity: 0.35;
  position: absolute;
  top: 0;
}

/* Tall enough to be pointed at. A bar drawn as a bare 2 px rule would have a
   2 px hover target, and the controls that appear on hover would be
   unreachable by pointer in practice. */
.evp-run {
  height: 1.5rem;
  position: absolute;
}

/**
 * The chip: a filled block in its event's colour, not a rule.
 *
 * This used to be a 2 px line, on the reasoning that the board reads as a
 * ruler with ticks on it. What that lost is the thing a coordinator scanning
 * a six-day festival needs first — *whose* work this is. A run at 03:00 sits
 * under a date band that says Sunday and belongs to Saturday's club night,
 * and one glance at a colour answers that where a line never could.
 *
 * Inset rather than filling the whole element, because the element is the
 * 24 px hit area the handles are hung on (docs/14 §2) and the chip is what is
 * drawn inside it.
 */
.evp-run::before {
  background: var(--evp-run-color);
  border-radius: 0.3125rem;
  content: '';
  inset: 0.125rem 0;
  position: absolute;
}

/* A proposal is outlined *and* labelled — never colour or style alone
   (docs/14 §2). Nothing is stored for it until the first edit, and an empty
   outline is the shape of that: the post is declared, the hours are not.
   A series being drawn is outlined for the same reason and says it in the same
   way: it is not on the board until the writes land. */
.evp-run--proposed::before,
.evp-run--ghost::before {
  background: none;
  border: 2px dashed var(--evp-run-color);
}

/* Nothing on it is a control, and it must not become one: the gesture that
   draws it is a drag on the lane, and a ghost that swallowed the pointer would
   end that drag the moment the outline reached the cursor. */
.evp-run--ghost {
  pointer-events: none;
}

.evp-run--proposed .evp-handle::before {
  background: var(--evp-text-muted);
}

.evp-run-meta {
  color: var(--evp-text-muted);
  font-size: 0.6875rem;
  left: 50%;
  position: absolute;
  top: -0.875rem;
  transform: translateX(-50%);
  white-space: nowrap;
}

/**
 * The divider between two shifts, cut clean through the chip.
 *
 * White, and no longer the `mark` token. A tick drawn *beside* a black rule
 * needed a colour of its own; a divider drawn *in* a chip needs only to be
 * unmistakably not-the-chip, and white is the one value guaranteed to manage
 * that on all 64 palette entries — each clears 4.5:1 against it, far above the
 * 3:1 a graphical object owes (WCAG 1.4.11). Full height, because a divider
 * that stops short of the edges reads as a mark on the chip rather than as the
 * boundary between two shifts.
 */
.evp-cut-mark {
  /* 24 px of hit area around the 2 px line — the target-size floor of
     docs/14 §2, which the bare rule this used to be would fail on every touch
     device. The line itself is the `::before`; the element is the target, and
     it is pulled half its own width left so that the instant it reports is the
     pixel the line is drawn on. */
  bottom: 0;
  cursor: ew-resize;
  margin-left: -0.75rem;
  position: absolute;
  top: 0;
  touch-action: none;
  width: 1.5rem;
}

.evp-cut-mark::before {
  background: #ffffff;
  bottom: 0.125rem;
  content: '';
  left: 50%;
  position: absolute;
  top: 0.125rem;
  transform: translateX(-50%);
  width: 2px;
}

/* Wider and in the accent under the pointer or the focus ring, the same
   promotion the edge handles get: a break being moved has to be visible past
   the finger that is moving it. */
.evp-cut-mark:hover::before,
.evp-cut-mark:focus-visible::before {
  background: var(--evp-accent);
  width: 4px;
}

.evp-cut-mark:focus-visible {
  border-radius: 0.25rem;
  outline: 2px solid var(--evp-accent);
  outline-offset: 1px;
}

/* 24 px of hit area around a 2 px line — the target size floor of docs/14 §2,
   which a 2 px grab handle would fail on every touch device. */
.evp-handle {
  cursor: ew-resize;
  height: 1.5rem;
  position: absolute;
  top: 0;
  touch-action: none;
  width: 1.5rem;
}

.evp-handle--start {
  left: -0.75rem;
}

.evp-handle--end {
  right: -0.75rem;
}

/* Half of this grip lies on the chip and half on the lane beside it, and
   `--evp-text` is legible on both in both themes: it is near-black on a light
   lane and near-white on a dark one, and every palette entry clears 4.5:1
   against black *and* white, so whichever end of that the theme is at, the
   half over the chip holds up too. */
.evp-handle::before {
  background: var(--evp-text);
  border-radius: 1px;
  content: '';
  /* Taller than the chip, and deliberately: a grip that fitted inside it would
     be a second vertical rule on a filled block, indistinguishable from the
     dividers between shifts — which in the dark theme it very nearly was, both
     being near-white. Overhanging says "edge of the chip" rather than "cut in
     the chip", which is the difference between the two controls. */
  height: 1.75rem;
  left: 50%;
  position: absolute;
  top: -0.125rem;
  transform: translateX(-50%);
  width: 2px;
}

.evp-handle:hover::before,
.evp-handle:focus-visible::before {
  background: var(--evp-accent);
  width: 4px;
}

.evp-handle:focus-visible {
  border-radius: 0.25rem;
  outline: 2px solid var(--evp-accent);
  outline-offset: 1px;
}

/**
 * One bar's controls, hung off its top-right corner.
 *
 * Above the chip rather than inside it, because a chip is as narrow as the
 * work it stands for and a fifteen-minute slot has no room for three buttons.
 * They overhang the lane instead, which is free space until the next bar and
 * is hidden again the moment the pointer leaves.
 */
.evp-run-controls {
  display: flex;
  gap: 0.1875rem;
  position: absolute;
  right: 0;
  top: -0.75rem;
  z-index: 1;
}

.evp-run-controls button {
  background: var(--evp-surface);
  border: 1px solid var(--evp-border);
  border-radius: 999px;
  color: var(--evp-text-muted);
  cursor: pointer;
  font-size: 0.6875rem;
  line-height: 1;
  opacity: 0;
  padding: 0.1875rem 0.375rem;
}

.evp-run-controls button:hover:not(:disabled) {
  background: var(--evp-accent);
  border-color: var(--evp-accent);
  color: var(--evp-on-accent);
}

.evp-run-controls button:disabled {
  cursor: not-allowed;
}

/* Revealed on hover *or* focus: an action only a pointer can find is an action
   a keyboard cannot reach. */
.evp-run:hover .evp-run-controls button,
.evp-run-controls button:focus-visible {
  opacity: 1;
}

/* Armed, and therefore always visible: the second click is the recovery, and
   a control that disappeared between the two clicks would be a control that
   armed itself and then hid. */
.evp-remove--armed {
  border-color: var(--evp-danger);
  color: var(--evp-danger);
  opacity: 1;
}

.evp-unplaced {
  margin-top: 1.5rem;
}

.evp-unplaced ul {
  color: var(--evp-text-muted);
  font-size: 0.875rem;
}

/**
 * Forced colours drop every author colour, so the strip and the chips lose the
 * one thing that pairs them. Shape is what is left: an outlined block with
 * ruled dividers still reads as "one post, cut into four", and the strip's
 * lines still carry their names in words. Nothing that was only a colour is
 * load-bearing, which is why this is three rules and not a second design.
 */
@media (forced-colors: active) {
  .evp-event-line,
  .evp-run::before {
    border: 1px solid;
  }

  .evp-cut-mark::before {
    background: CanvasText;
  }

  /* The hatch is an author background and is dropped; the two dashed edges
     are the whole marker here, so they are drawn from a system colour and the
     ruler still reads as broken rather than merely as empty. */
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
