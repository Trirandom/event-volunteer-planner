<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Tristan Grunert and contributors -->
<script setup lang="ts">
/**
 * Availability: who can work when, on the same axis the rest of the plan is
 * read on, with one row per volunteer.
 *
 * The section exists because a plan does not stop moving once it is made. A
 * volunteer says yes in March and loses their Saturday evening in June, and
 * until now the only record of that was the form answer they filled in months
 * ago. This is where a coordinator writes down what they have since been told,
 * without pretending the volunteer changed their own submission.
 *
 * **It is the shift board, with volunteers instead of missions.** Same ruler,
 * same folds, same zoom (`board/useAxis.ts` is shared, deliberately, so that
 * an ellipsis swallows the same stretch of night on both), and the same
 * grammar in the lane: drag an edge, split a chip, remove one, draw a new one
 * on empty track. A coordinator who has learned one board has learned this
 * one. What it does *not* borrow is the slot length: availability is not cut
 * into bookable pieces, so there is no tiling and no `cut` button — a chip is
 * one continuous stretch and nothing else.
 *
 * **A chip is a reading of two layers, and editing one never rewrites what the
 * volunteer submitted.** `plan/availability.ts` holds that arithmetic and the
 * reasoning behind it; the short version is that what a coordinator drags is
 * the *effective* availability, and what gets saved is the difference between
 * that and the form answer — as a coordinator's own window, beside the
 * submission rather than over it. The submissions page keeps showing exactly
 * what arrived, for the rest of the production.
 *
 * Saving happens per gesture, like the shift board's, rather than behind a
 * "save" button: the endpoint replaces one participation's declared windows in
 * one transaction, so there is nothing to batch, and a board with unsaved
 * state is a board that loses an afternoon to a closed tab.
 */
import { eventColor } from '@evp/shared';
import { Temporal } from '@evp/shared/time';
import { computed, ref } from 'vue';

import type { ReplaceAvailabilityRejection } from '../api/availability';
import HelpModal from '../components/HelpModal.vue';
import ToastMessage from '../components/ToastMessage.vue';
import ToastStack from '../components/ToastStack.vue';
import { useReplaceAvailability } from '../api/useAvailabilityWrites';
import { usePlanScope } from '../api/usePlan';
import { useRoster } from '../api/useRoster';
import type { EventWindow } from '../board/runs';
import { msAt, snapMs } from '../board/scale';
import { useAxis } from '../board/useAxis';
import { locale, t } from '../i18n';
import {
  availabilityRows,
  createSpan,
  declaredWindows,
  middleOf,
  moveEdge,
  removeSpan,
  splitSpan,
  type AvailabilityRow,
  type AvailabilityTrack,
  type Span,
} from '../plan/availability';
import { focusedEventId } from '../plan/scope';
import { durationLabel } from '../plan/submissions';
import { useRouteParam } from '../router/params';
import { useBoardStore } from '../stores/board';

/**
 * ADR-0029's floor, and the same step the shift board snaps to: nothing finer
 * can be declared against on the volunteer form either, so offering it here
 * would be offering a precision the rest of the product cannot carry.
 */
const STEP_MINUTES = 15;

/** What a split takes out of a chip, for the reason `board/edit.ts` gives at
 * length: two stretches that touch are one stretch on the next render. */
const SPLIT_GAP_MINUTES = STEP_MINUTES;

/** One volunteer's lane, in `rem` so the board scales with the viewer's text
 * size (docs/14 §2). */
const LANE_ROW_REM = 3;

/**
 * The blank ends of the axis.
 *
 * The shift board reserves two hours there because its bars are born spanning
 * the whole event and their edges would otherwise sit on the last pixel of the
 * board. Chips are held inside their own day and never grow past it, so all
 * this has to buy is room to *grab* a handle sitting on the day's boundary —
 * half of one, at any zoom this board offers.
 */
const AVAILABILITY_MARGIN_MINUTES = 30;

const orgId = useRouteParam('orgId');
const festivalId = useRouteParam('festivalId');
const eventId = useRouteParam('eventId');

const submissionsRoute = computed(() =>
  eventId.value === '' ? 'org-festival-submissions' : 'org-event-submissions',
);
const scopeParams = computed(() =>
  eventId.value === ''
    ? { orgId: orgId.value, festivalId: festivalId.value }
    : { orgId: orgId.value, eventId: eventId.value },
);

const { scope, isPending: scopePending } = usePlanScope(
  orgId,
  festivalId,
  eventId,
);

/** `Date.parse` is banned (docs/16 §4): it accepts what is not RFC 3339 and
 * answers `NaN` for the rest, which here would be a whole day laid silently at
 * the left edge of the epoch. */
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
  participants,
  isPending: rosterPending,
  participantsFailed,
} = useRoster(orgId, visibleEvents);

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

/** One line, one clock — see `PlanShiftsView.vue`; each chip still announces
 * the zone its day is genuinely worked in. */
const axisClock = computed(
  () =>
    scope.value?.selected?.timezone ?? scope.value?.festival?.timezone ?? 'UTC',
);

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
  boxStyle,
  atStyle,
  eventLineStyle,
  clockAt,
} = useAxis({
  windows,
  timezone: axisClock,
  locale,
  marginMinutes: AVAILABILITY_MARGIN_MINUTES,
});

// ---------------------------------------------------------------------------
// Zoom — the same knob the shift board turns, because it is the same axis
// (`board/useAxis.ts` holds one shared `pixelsPerHour`, deliberately).
// ---------------------------------------------------------------------------

const board = useBoardStore();

function numberFrom(target: EventTarget | null): number | null {
  if (!(target instanceof HTMLInputElement)) {
    return null;
  }
  const value = Number.parseInt(target.value, 10);
  return Number.isNaN(value) ? null : value;
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
 * fight the ordinary horizontal scroll a coordinator uses to move along the
 * timeline.
 */
function onBoardWheel(event: WheelEvent): void {
  if (!event.ctrlKey) {
    return;
  }
  event.preventDefault();
  const notches = -event.deltaY / WHEEL_NOTCH_PIXELS;
  board.setPixelsPerHour(board.pixelsPerHour + notches * ZOOM_STEP_PER_NOTCH);
}

const rows = computed<readonly AvailabilityRow[]>(() =>
  availabilityRows(participants.value, visibleEvents.value),
);

const isPending = computed(() => scopePending.value || rosterPending.value);

// ---------------------------------------------------------------------------
// What the board is holding that the server has not confirmed yet
// ---------------------------------------------------------------------------

/**
 * Chips as the coordinator currently has them, by participation.
 *
 * One map for two jobs, because they are the same job: it is the live preview
 * while a pointer is down, and it is what keeps the chip where it was dropped
 * until the roster has been re-read. Entries are dropped the moment the save
 * resolves — `useAvailabilityWrites.ts` awaits the refetch, so by then the
 * query holds the same shape and there is no frame showing the old one.
 */
const pending = ref<ReadonlyMap<string, readonly Span[]>>(new Map());

function hold(participationId: string, spans: readonly Span[]): void {
  const next = new Map(pending.value);
  next.set(participationId, spans);
  pending.value = next;
}

function release(participationId: string): void {
  const next = new Map(pending.value);
  next.delete(participationId);
  pending.value = next;
}

function spansOf(track: AvailabilityTrack): readonly Span[] {
  return pending.value.get(track.participationId) ?? track.spans;
}

const replace = useReplaceAvailability(orgId);
const isSaving = computed(() => replace.isPending.value);
const lastRejection = ref<ReplaceAvailabilityRejection | null>(null);
/** The board's one spoken line, for a screen reader and for everyone else —
 * a chip that merged, a day somebody is not enrolled on, a save that was
 * refused. */
const lastNotice = ref<string | null>(null);

/**
 * Save one day's chips for one volunteer.
 *
 * The windows sent are the *difference* between what the board now draws and
 * what the volunteer submitted, never the chips themselves
 * (`plan/availability.ts`): that is what leaves the submission alone.
 */
async function commit(
  track: AvailabilityTrack,
  spans: readonly Span[],
): Promise<void> {
  hold(track.participationId, spans);

  const result = await replace.mutateAsync({
    participationId: track.participationId,
    eventId: track.eventId,
    windows: declaredWindows(track.submitted, spans),
  });

  lastRejection.value = result.ok ? null : result.rejection;
  release(track.participationId);
}

function rejectionText(rejection: ReplaceAvailabilityRejection): string {
  return rejection.reason === 'unavailable'
    ? t('availability.rejection.unavailable')
    : rejection.detail;
}

// ---------------------------------------------------------------------------
// Dragging an edge
// ---------------------------------------------------------------------------

interface EdgeDrag {
  readonly participationId: string;
  readonly index: number;
  readonly edge: 'start' | 'end';
  readonly laneLeft: number;
  /**
   * The chips as they were when the pointer went down.
   *
   * Every move is computed against *these* rather than against the running
   * preview, because a drag can merge two chips on its way past a neighbour
   * and the index this drag is holding would then name a different chip
   * halfway through the gesture.
   */
  readonly from: readonly Span[];
  readonly track: AvailabilityTrack;
}

const edgeDrag = ref<EdgeDrag | null>(null);

function laneLeftOf(target: EventTarget | null): number | null {
  const element = target instanceof HTMLElement ? target : null;
  const lane = element?.closest('.evp-lane');
  return lane instanceof HTMLElement ? lane.getBoundingClientRect().left : null;
}

function msAtClientX(clientX: number, laneLeft: number): number | null {
  const current = scale.value;
  return current === null ? null : msAt(current, clientX - laneLeft);
}

function onHandlePointerDown(
  event: PointerEvent,
  track: AvailabilityTrack,
  index: number,
  edge: 'start' | 'end',
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
  const laneLeft = laneLeftOf(handle);
  if (laneLeft === null) {
    return;
  }

  // A handle sits astride its chip's own edge, reaching outside the span it
  // belongs to so there is something to grab. Left alone, this same
  // pointerdown bubbles to the lane below, which reads that position as empty
  // track and starts drawing a new chip there — stealing the pointer capture
  // this drag just took and turning "drag the edge" into "stretch a phantom
  // chip under the cursor". Stopping it here is what keeps the two gestures
  // from fighting over the same pointer.
  event.stopPropagation();
  handle.setPointerCapture(event.pointerId);
  edgeDrag.value = {
    participationId: track.participationId,
    index,
    edge,
    laneLeft,
    from: spansOf(track),
    track,
  };
  event.preventDefault();
}

function onHandlePointerMove(event: PointerEvent): void {
  const current = edgeDrag.value;
  if (current === null) {
    return;
  }
  const raw = msAtClientX(event.clientX, current.laneLeft);
  if (raw === null) {
    return;
  }

  hold(
    current.participationId,
    moveEdge(
      current.from,
      current.index,
      current.edge,
      raw,
      STEP_MINUTES,
      current.track.bounds,
    ),
  );
}

async function onHandlePointerUp(): Promise<void> {
  const current = edgeDrag.value;
  edgeDrag.value = null;
  if (current === null) {
    return;
  }

  const spans = pending.value.get(current.participationId) ?? current.from;
  if (spans.length < current.from.length) {
    lastNotice.value = t('availability.notice.merged');
  }
  await commit(current.track, spans);
}

function onHandlePointerCancel(): void {
  const current = edgeDrag.value;
  edgeDrag.value = null;
  if (current !== null) {
    release(current.participationId);
  }
}

// ---------------------------------------------------------------------------
// Drawing a new chip on empty track
// ---------------------------------------------------------------------------

interface DrawDrag {
  /** Whose lane the ghost belongs in. The track alone would not say: one row
   * carries a track per day, and a festival-wide board draws several rows'
   * worth of them on the same axis. */
  readonly rowKey: string;
  readonly track: AvailabilityTrack;
  readonly laneLeft: number;
  readonly anchorMs: number;
  readonly from: readonly Span[];
}

const drawDrag = ref<DrawDrag | null>(null);
/** The stretch the drag currently covers, drawn as a ghost so a coordinator
 * can see what they are about to get. */
const drawPreview = ref<Span | null>(null);

/** Which of this volunteer's days an instant falls in. `null` where they are
 * not enrolled on the day under the pointer, which is a thing worth saying
 * rather than a gesture worth silently dropping. */
function trackAt(row: AvailabilityRow, atMs: number): AvailabilityTrack | null {
  return (
    row.tracks.find(
      (track) => atMs >= track.bounds.startMs && atMs < track.bounds.endMs,
    ) ?? null
  );
}

function onLanePointerDown(event: PointerEvent, row: AvailabilityRow): void {
  if (event.button !== 0) {
    return;
  }
  const lane = event.currentTarget;
  if (!(lane instanceof HTMLElement)) {
    return;
  }
  const laneLeft = lane.getBoundingClientRect().left;
  const raw = msAtClientX(event.clientX, laneLeft);
  if (raw === null) {
    return;
  }

  const track = trackAt(row, raw);
  if (track === null) {
    const day = visibleEvents.value.find(
      (candidate) =>
        raw >= instantOf(candidate.period.start) &&
        raw < instantOf(candidate.period.end),
    );
    // Only where they are pointing at a real day: the margins and the folded
    // nights are not somewhere anybody is enrolled, and saying so would be
    // noise on every stray click.
    lastNotice.value =
      day === undefined
        ? null
        : t('availability.notice.notEnrolled', {
            name: row.name,
            day: day.name,
          });
    return;
  }

  const anchorMs = snapMs(raw, STEP_MINUTES, track.bounds.startMs);
  // Inside a chip this gesture is that chip's edge drag, not a new one.
  if (
    spansOf(track).some(
      (span) => anchorMs >= span.startMs && anchorMs < span.endMs,
    )
  ) {
    return;
  }

  lane.setPointerCapture(event.pointerId);
  drawDrag.value = {
    rowKey: row.key,
    track,
    laneLeft,
    anchorMs,
    from: spansOf(track),
  };
  drawPreview.value = null;
  event.preventDefault();
}

function onLanePointerMove(event: PointerEvent): void {
  const current = drawDrag.value;
  if (current === null) {
    return;
  }
  const raw = msAtClientX(event.clientX, current.laneLeft);
  if (raw === null) {
    return;
  }

  const toMs = snapMs(raw, STEP_MINUTES, current.track.bounds.startMs);
  const lo = Math.min(current.anchorMs, toMs);
  const hi = Math.max(current.anchorMs, toMs);
  drawPreview.value = hi > lo ? { startMs: lo, endMs: hi } : null;
}

async function onLanePointerUp(event: PointerEvent): Promise<void> {
  const current = drawDrag.value;
  drawDrag.value = null;
  drawPreview.value = null;
  if (current === null) {
    return;
  }

  const raw = msAtClientX(event.clientX, current.laneLeft);
  if (raw === null) {
    return;
  }

  const next = createSpan(
    current.from,
    current.anchorMs,
    raw,
    STEP_MINUTES,
    current.track.bounds,
  );
  // A click rather than a drag, or a stretch with no room: `createSpan`
  // answers with the list it was given, and a request for nothing is not a
  // request.
  if (next === current.from) {
    return;
  }
  await commit(current.track, next);
}

function onLanePointerCancel(): void {
  drawDrag.value = null;
  drawPreview.value = null;
}

// ---------------------------------------------------------------------------
// The keyboard path — every gesture above has one (WCAG 2.2 AA 2.5.7)
// ---------------------------------------------------------------------------

async function nudge(
  track: AvailabilityTrack,
  index: number,
  edge: 'start' | 'end',
  toMs: number,
): Promise<void> {
  const spans = spansOf(track);
  const next = moveEdge(spans, index, edge, toMs, STEP_MINUTES, track.bounds);
  if (next === spans) {
    return;
  }
  await commit(track, next);
}

async function onHandleKeydown(
  event: KeyboardEvent,
  track: AvailabilityTrack,
  index: number,
  edge: 'start' | 'end',
): Promise<void> {
  const span = spansOf(track)[index];
  if (span === undefined) {
    return;
  }
  const atMs = edge === 'start' ? span.startMs : span.endMs;
  const stepMs = STEP_MINUTES * 60_000;

  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    await nudge(track, index, edge, atMs - stepMs);
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    await nudge(track, index, edge, atMs + stepMs);
  } else if (event.key === 'Home') {
    event.preventDefault();
    await nudge(track, index, edge, track.bounds.startMs);
  } else if (event.key === 'End') {
    event.preventDefault();
    await nudge(track, index, edge, track.bounds.endMs);
  }
}

async function splitChip(
  track: AvailabilityTrack,
  index: number,
  atMs: number,
): Promise<void> {
  const spans = spansOf(track);
  const next = splitSpan(spans, index, atMs, SPLIT_GAP_MINUTES);
  if (next === spans) {
    lastNotice.value = t('availability.notice.tooShort');
    return;
  }
  lastNotice.value = t('availability.notice.split', {
    minutes: SPLIT_GAP_MINUTES,
  });
  await commit(track, next);
}

async function onChipDoubleClick(
  event: MouseEvent,
  track: AvailabilityTrack,
  index: number,
): Promise<void> {
  const laneLeft = laneLeftOf(event.currentTarget);
  if (laneLeft === null) {
    return;
  }
  const raw = msAtClientX(event.clientX, laneLeft);
  if (raw === null) {
    return;
  }
  await splitChip(
    track,
    index,
    snapMs(raw, STEP_MINUTES, track.bounds.startMs),
  );
}

async function splitAtMiddle(
  track: AvailabilityTrack,
  index: number,
): Promise<void> {
  const span = spansOf(track)[index];
  if (span === undefined) {
    return;
  }
  await splitChip(track, index, middleOf(span, STEP_MINUTES));
}

async function removeChip(
  track: AvailabilityTrack,
  index: number,
): Promise<void> {
  const span = spansOf(track)[index];
  if (span === undefined) {
    return;
  }
  lastNotice.value = t('availability.notice.removed', {
    start: clockAt(span.startMs, track.timezone),
    end: clockAt(span.endMs, track.timezone),
    day: track.eventName,
  });
  await commit(track, removeSpan(spansOf(track), index));
}

/** Whether any of this volunteer's days carry a coordinator's own edit —
 * what the reset button in the gutter undoes. */
function rowOverridden(row: AvailabilityRow): boolean {
  return row.tracks.some((track) => track.overridden);
}

/**
 * Discard every edit made here and go back to reading exactly what the
 * volunteer submitted.
 *
 * Committing `track.submitted` as the wanted spans against a base of
 * `track.submitted` sends an empty declared window (`declaredWindows`'s two
 * halves both come out empty), which is the honest way to say "no override
 * any more" rather than a client-side undo the next refetch could disagree
 * with.
 */
async function resetRow(row: AvailabilityRow): Promise<void> {
  for (const track of row.tracks) {
    if (!track.overridden) {
      continue;
    }
    await commit(track, track.submitted);
  }
  lastNotice.value = t('availability.notice.reset', { name: row.name });
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** What every label naming one chip is told: whose, which day, and its
 * two clock readings in that day's own zone. Each label is a whole message of
 * its own rather than a prefix on another one, so its word order is free. */
function chipValues(
  row: AvailabilityRow,
  track: AvailabilityTrack,
  span: Span,
): Record<'name' | 'day' | 'start' | 'end', string> {
  return {
    name: row.name,
    day: track.eventName,
    start: clockAt(span.startMs, track.timezone),
    end: clockAt(span.endMs, track.timezone),
  };
}

function chipHours(track: AvailabilityTrack, span: Span): string {
  return t('availability.chip.hours', {
    start: clockAt(span.startMs, track.timezone),
    end: clockAt(span.endMs, track.timezone),
  });
}

function chipStyle(
  track: AvailabilityTrack,
  span: Span,
): Record<string, string> {
  return {
    ...boxStyle(span.startMs, span.endMs),
    '--evp-chip-color': eventColor(track.color),
  };
}

function rowSummary(row: AvailabilityRow): string {
  return row.minutes === 0
    ? t('availability.row.nothingDeclared')
    : durationLabel(row.minutes);
}
</script>

<template>
  <HelpModal :title="t('availability.title')">
    <p>{{ t('availability.help.intro') }}</p>
    <!-- A key, then what it does: each `<kbd>` sits at the edge of its own
         message rather than in the middle of a sentence, so a translation can
         reorder the words around it. -->
    <dl class="evp-keys">
      <dt>
        <kbd>{{ t('availability.chip.split') }}</kbd>
      </dt>
      <dd>{{ t('availability.help.does.split') }}</dd>
      <dt><kbd>×</kbd></dt>
      <dd>{{ t('availability.help.does.remove') }}</dd>
      <dt><kbd>←</kbd> <kbd>→</kbd></dt>
      <dd>
        {{ t('availability.help.does.arrows', { minutes: STEP_MINUTES }) }}
      </dd>
      <dt>
        <kbd>{{ t('availability.help.keys.home') }}</kbd> /
        <kbd>{{ t('availability.help.keys.end') }}</kbd>
      </dt>
      <dd>{{ t('availability.help.does.homeEnd') }}</dd>
      <dt>
        <kbd>{{ t('availability.help.keys.ctrl') }}</kbd>
        {{ t('availability.help.keys.wheel') }}
      </dt>
      <dd>{{ t('availability.help.does.wheel') }}</dd>
    </dl>
    <p>{{ t('availability.help.outro') }}</p>
  </HelpModal>

  <section class="evp-availability" aria-labelledby="availability-heading">
    <h1 id="availability-heading">{{ t('availability.title') }}</h1>

    <label class="evp-tool" for="availability-zoom">
      <span class="evp-tool-label"
        >{{ t('availability.zoom.label') }}
        <span class="evp-unit">{{ t('availability.zoom.unit') }}</span></span
      >
      <input
        id="availability-zoom"
        class="evp-zoom"
        type="range"
        :min="board.MIN_PIXELS_PER_HOUR"
        :max="board.MAX_PIXELS_PER_HOUR"
        step="4"
        :value="board.pixelsPerHour"
        @input="onZoomInput"
      />
    </label>

    <p v-if="isPending">{{ t('common.status.loading') }}</p>

    <p v-else-if="participantsFailed" role="alert" class="evp-error">
      {{ t('availability.rosterFailed') }}
    </p>

    <p v-else-if="rows.length === 0" class="evp-empty">
      {{ t('availability.empty.lead') }}
      <RouterLink :to="{ name: submissionsRoute, params: scopeParams }">
        {{ t('availability.empty.link') }}
      </RouterLink>
      .
    </p>

    <template v-else>
      <div class="evp-board" :aria-busy="isSaving">
        <div class="evp-scroll" @wheel="onBoardWheel">
          <div class="evp-axis">
            <div
              class="evp-gutter evp-gutter--spacer"
              :style="{ height: axisHeight }"
            >
              <span class="evp-column-head">{{
                t('availability.columnHead')
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

              <button
                v-for="fold in foldMarks"
                :key="fold.key"
                type="button"
                class="evp-fold"
                :style="boxStyle(fold.startMs, fold.endMs)"
                @click="toggleFold(fold.startMs)"
              >
                <span class="evp-fold-glyph" aria-hidden="true" />
                <span class="evp-fold-length" aria-hidden="true">{{
                  fold.label
                }}</span>
                <span class="evp-visually-hidden">
                  {{
                    t('availability.fold.show', {
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
                <span class="evp-fold-glyph" aria-hidden="true" />
                <span class="evp-visually-hidden">
                  {{
                    t('availability.fold.hide', {
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
              <span class="evp-volunteer-name">
                {{ row.name }}
                <span class="evp-summary">{{ rowSummary(row) }}</span>
              </span>
              <button
                v-if="rowOverridden(row)"
                type="button"
                class="evp-reset"
                :disabled="isSaving"
                :aria-label="
                  t('availability.row.resetLabel', { name: row.name })
                "
                :title="t('availability.row.resetTitle')"
                @click="resetRow(row)"
              >
                <span class="evp-reset-glyph" aria-hidden="true" />
              </button>
            </div>

            <!-- eslint-disable-next-line vuejs-accessibility/no-static-element-interactions -- a drawing surface for the pointer only; the keyboard path to the same edits is each chip's own focusable handles and buttons -->
            <div
              class="evp-lane"
              :style="{
                width: `${String(laneWidth)}px`,
                height: `${String(LANE_ROW_REM)}rem`,
              }"
              @pointerdown="onLanePointerDown($event, row)"
              @pointermove="onLanePointerMove"
              @pointerup="onLanePointerUp"
              @pointercancel="onLanePointerCancel"
            >
              <span
                v-for="edge in margins"
                :key="edge.key"
                class="evp-lane-outside"
                :style="boxStyle(edge.startMs, edge.endMs)"
                aria-hidden="true"
              />
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
              <span
                v-for="mark in hourMarks"
                :key="mark.key"
                class="evp-hour-line"
                :style="atStyle(mark.atMs)"
                aria-hidden="true"
              />

              <!-- What the volunteer themself offered, under everything: the
                   thing a coordinator is overriding, so they can see they are
                   overriding it. -->
              <template
                v-for="track in row.tracks"
                :key="track.participationId"
              >
                <span
                  v-for="offered in track.submitted"
                  :key="`offered:${String(offered.startMs)}`"
                  class="evp-offered"
                  :style="boxStyle(offered.startMs, offered.endMs)"
                  aria-hidden="true"
                />
              </template>

              <span
                v-if="drawPreview !== null && drawDrag?.rowKey === row.key"
                class="evp-chip evp-chip--ghost"
                :style="boxStyle(drawPreview.startMs, drawPreview.endMs)"
                aria-hidden="true"
              />

              <template
                v-for="track in row.tracks"
                :key="track.participationId"
              >
                <!-- eslint-disable-next-line vuejs-accessibility/no-static-element-interactions -- the double click is a shortcut for the chip's own `split` button, which is focusable and does the same thing; the chip itself is a group holding the controls, not a control -->
                <div
                  v-for="(span, index) in spansOf(track)"
                  :key="`${track.participationId}:${String(index)}`"
                  class="evp-chip"
                  :class="{ 'evp-chip--offered': !track.overridden }"
                  :style="chipStyle(track, span)"
                  role="group"
                  :aria-label="
                    t('availability.chip.label', chipValues(row, track, span))
                  "
                  @dblclick="onChipDoubleClick($event, track, index)"
                >
                  <span
                    class="evp-handle evp-handle--start"
                    role="slider"
                    tabindex="0"
                    :aria-label="
                      t(
                        'availability.chip.startHandle',
                        chipValues(row, track, span),
                      )
                    "
                    :aria-valuemin="reach.startMs"
                    :aria-valuemax="reach.endMs"
                    :aria-valuenow="span.startMs"
                    :aria-valuetext="clockAt(span.startMs, track.timezone)"
                    @pointerdown="
                      onHandlePointerDown($event, track, index, 'start')
                    "
                    @pointermove="onHandlePointerMove"
                    @pointerup="onHandlePointerUp"
                    @pointercancel="onHandlePointerCancel"
                    @keydown="onHandleKeydown($event, track, index, 'start')"
                  />

                  <span class="evp-chip-hours" aria-hidden="true">
                    {{ chipHours(track, span) }}
                  </span>

                  <span class="evp-chip-controls">
                    <button
                      type="button"
                      :disabled="isSaving"
                      :aria-label="
                        t(
                          'availability.chip.splitLabel',
                          chipValues(row, track, span),
                        )
                      "
                      @pointerdown.stop
                      @click="splitAtMiddle(track, index)"
                    >
                      {{ t('availability.chip.split') }}
                    </button>
                    <button
                      type="button"
                      class="evp-remove"
                      :disabled="isSaving"
                      :aria-label="
                        t(
                          'availability.chip.removeLabel',
                          chipValues(row, track, span),
                        )
                      "
                      @pointerdown.stop
                      @click="removeChip(track, index)"
                    >
                      ×
                    </button>
                  </span>

                  <span
                    class="evp-handle evp-handle--end"
                    role="slider"
                    tabindex="0"
                    :aria-label="
                      t(
                        'availability.chip.endHandle',
                        chipValues(row, track, span),
                      )
                    "
                    :aria-valuemin="reach.startMs"
                    :aria-valuemax="reach.endMs"
                    :aria-valuenow="span.endMs"
                    :aria-valuetext="clockAt(span.endMs, track.timezone)"
                    @pointerdown="
                      onHandlePointerDown($event, track, index, 'end')
                    "
                    @pointermove="onHandlePointerMove"
                    @pointerup="onHandlePointerUp"
                    @pointercancel="onHandlePointerCancel"
                    @keydown="onHandleKeydown($event, track, index, 'end')"
                  />
                </div>
              </template>
            </div>
          </div>
        </div>
      </div>
    </template>
  </section>

  <ToastStack>
    <ToastMessage
      v-if="lastRejection !== null"
      tone="danger"
      dismissible
      @dismiss="lastRejection = null"
    >
      {{ rejectionText(lastRejection) }}
    </ToastMessage>
    <ToastMessage
      v-if="lastNotice !== null"
      dismissible
      @dismiss="lastNotice = null"
    >
      {{ lastNotice }}
    </ToastMessage>
  </ToastStack>
</template>

<style scoped>
.evp-tool {
  align-items: center;
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
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

.evp-keys {
  display: grid;
  gap: 0.25rem 0.75rem;
  grid-template-columns: max-content 1fr;
  margin: 0.75rem 0;
}

.evp-keys dt {
  white-space: nowrap;
}

.evp-keys dd {
  margin: 0;
}

kbd {
  background: var(--evp-surface-raised);
  border: 1px solid var(--evp-border);
  border-radius: 0.1875rem;
  font-size: 0.75rem;
  padding: 0 0.1875rem;
}

.evp-error {
  color: var(--evp-danger);
}

.evp-empty {
  color: var(--evp-text-muted);
  font-size: 0.875rem;
}

.evp-board {
  border: 1px solid var(--evp-border);
  border-radius: 0.5rem;
  overflow: hidden;
}

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

.evp-axis-track {
  position: relative;
}

.evp-gutter {
  align-items: flex-start;
  background: var(--evp-surface);
  border-right: 1px solid var(--evp-border);
  display: flex;
  flex: 0 0 13.5rem;
  flex-direction: column;
  gap: 0.25rem;
  justify-content: center;
  left: 0;
  padding: 0.5rem 1.75rem 0.5rem 0.625rem;
  position: sticky;
  width: 13.5rem;
  z-index: 2;
}

.evp-gutter--spacer {
  justify-content: flex-start;
}

.evp-row + .evp-row .evp-gutter,
.evp-row + .evp-row .evp-lane {
  border-top: 1px solid var(--evp-border);
}

.evp-column-head {
  color: var(--evp-text-muted);
  font-size: 0.8125rem;
  font-weight: 600;
}

.evp-volunteer-name {
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.25;
  overflow-wrap: break-word;
}

.evp-summary {
  color: var(--evp-text-muted);
  display: block;
  font-size: 0.6875rem;
  font-weight: 400;
}

.evp-reset {
  align-items: center;
  background: var(--evp-surface);
  border: 1px solid var(--evp-border);
  border-radius: 999px;
  color: var(--evp-text-muted);
  cursor: pointer;
  display: inline-flex;
  font-size: 0.75rem;
  height: 1.25rem;
  justify-content: center;
  line-height: 1;
  padding: 0;
  position: absolute;
  right: 0.5rem;
  top: 0.5rem;
  width: 1.25rem;
}

.evp-reset:hover:not(:disabled) {
  background: var(--evp-accent);
  border-color: var(--evp-accent);
  color: var(--evp-on-accent);
}

.evp-reset:disabled {
  cursor: not-allowed;
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

.evp-public-mark {
  border-left: 2px dotted var(--evp-accent);
  color: var(--evp-accent);
  font-size: 0.6875rem;
  padding-left: 0.1875rem;
  position: absolute;
  top: 2.5rem;
  white-space: nowrap;
}

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

/* The glyphs are drawn by CSS rather than written in the template: they are
   decoration (`aria-hidden`, and the buttons carry their own names), and a
   symbol is not a message for the catalogue to hold. */
.evp-fold-glyph::before {
  content: '⋯';
}

.evp-reset-glyph::before {
  content: '↺';
}

.evp-fold-length {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.evp-fold--open {
  background: var(--evp-surface);
  border-right: 0;
  cursor: zoom-out;
  width: 1.5rem;
}

.evp-lane {
  position: relative;
  touch-action: none;
}

.evp-lane-outside,
.evp-lane-band,
.evp-lane-fold,
.evp-public-rule,
.evp-hour-line,
.evp-offered {
  pointer-events: none;
}

.evp-lane-band {
  border-left: 1px solid var(--evp-border);
  bottom: 0;
  position: absolute;
  top: 0;
}

.evp-hour-line {
  border-left: 1px solid var(--evp-border);
  bottom: 0;
  opacity: 0.35;
  position: absolute;
  top: 0;
}

.evp-public-rule {
  border-left: 2px dotted var(--evp-accent);
  bottom: 0;
  opacity: 0.6;
  position: absolute;
  top: 0;
}

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

/* What the volunteer offered, before anybody edited it: a thin rule under the
   chips rather than a second block, so an overridden stretch reads as "this
   used to reach further" without competing with the chip itself. */
.evp-offered {
  border-bottom: 2px dotted var(--evp-text-muted);
  bottom: 0.25rem;
  height: 0;
  opacity: 0.7;
  position: absolute;
}

/* Deliberately larger than the shift board's bars: this board has one row per
   volunteer and one job, and the chip is the thing being grabbed. */
.evp-chip {
  height: 2rem;
  position: absolute;
  top: 0.5rem;
}

.evp-chip::before {
  background: var(--evp-chip-color);
  border-radius: 0.375rem;
  content: '';
  inset: 0;
  opacity: 0.85;
  position: absolute;
}

/* Nobody has touched this one: it is the volunteer's own answer, drawn as
   such, so "what did they say?" and "what have we since agreed?" are not the
   same picture. */
.evp-chip--offered::before {
  background: repeating-linear-gradient(
    135deg,
    var(--evp-chip-color),
    var(--evp-chip-color) 6px,
    transparent 6px,
    transparent 9px
  );
  opacity: 0.55;
}

.evp-chip--ghost {
  pointer-events: none;
}

.evp-chip--ghost::before {
  background: none;
  border: 2px dashed var(--evp-accent);
}

.evp-chip-hours {
  color: #ffffff;
  font-size: 0.75rem;
  font-weight: 600;
  left: 0.5rem;
  line-height: 2rem;
  overflow: hidden;
  position: absolute;
  right: 0.5rem;
  text-overflow: ellipsis;
  text-shadow: 0 0 2px rgb(0 0 0 / 45%);
  white-space: nowrap;
}

.evp-handle {
  cursor: ew-resize;
  height: 2rem;
  position: absolute;
  top: 0;
  touch-action: none;
  width: 1.5rem;
  z-index: 1;
}

.evp-handle--start {
  left: -0.75rem;
}

.evp-handle--end {
  right: -0.75rem;
}

.evp-handle::before {
  background: var(--evp-text);
  border-radius: 1px;
  content: '';
  height: 2.25rem;
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

.evp-chip-controls {
  display: flex;
  gap: 0.1875rem;
  position: absolute;
  right: 0;
  top: -0.6875rem;
  z-index: 2;
}

.evp-chip-controls button {
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

.evp-chip-controls button:hover:not(:disabled) {
  background: var(--evp-accent);
  border-color: var(--evp-accent);
  color: var(--evp-on-accent);
}

.evp-chip-controls button:disabled {
  cursor: not-allowed;
}

.evp-chip:hover .evp-chip-controls button,
.evp-chip-controls button:focus-visible {
  opacity: 1;
}

.evp-remove:hover:not(:disabled) {
  background: var(--evp-danger);
  border-color: var(--evp-danger);
}

.evp-visually-hidden {
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  height: 1px;
  overflow: hidden;
  position: absolute;
  white-space: nowrap;
  width: 1px;
}

/* Forced colours drops author colour entirely, so every chip would be one
   flat block. Borders carry the distinction instead. */
@media (forced-colors: active) {
  .evp-chip::before {
    border: 1px solid CanvasText;
  }

  .evp-chip--offered::before {
    border-style: dashed;
  }

  .evp-handle::before {
    background: CanvasText;
  }
}
</style>
