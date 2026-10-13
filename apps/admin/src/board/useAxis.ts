// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The board's ruler, as one composable: the time↔pixel scale, the day bands,
 * the clock ticks, the elisions, the door marks and the coloured strip of
 * events under it.
 *
 * Two pages draw on this axis — the shift board, which cuts missions into
 * shifts, and the assignation board, which staffs them — and they have to
 * agree about it to the pixel. Not because sharing code is tidy, but because
 * the two are read together: a coordinator finds the hole on one page and
 * fills it on the other, and an ellipsis that swallowed a different stretch of
 * night on each would make the second page a different festival. Two copies of
 * this arithmetic would drift the first time one of them is tuned.
 *
 * What lives here is everything that depends only on *which days are in view*.
 * What does not: anything a page does to its own rows. Editing a shift and
 * seating a volunteer have nothing in common and are not abstracted over.
 *
 * Epoch milliseconds throughout, and the event's own zone for every label
 * (docs/16 §1) — never the viewer's browser zone.
 */
import { eventColor } from '@evp/shared';
import { eventTimeZone, formatTime, type ViewerLocale } from '@evp/shared/intl';
import {
  computed,
  ref,
  toValue,
  type ComputedRef,
  type MaybeRefOrGetter,
} from 'vue';

import { axisDays, axisTicks } from './axis';
import { eventLanes, type EventLane, type EventLanes } from './eventLanes';
import { axisFolds } from './folds';
import type { EventWindow } from './runs';
import {
  foldedTimeScale,
  isFolded,
  scaleWidth,
  xOf,
  type TimeScale,
} from './scale';
import { t } from '../i18n';
import { useBoardStore } from '../stores/board';

const MS_PER_MINUTE = 60_000;

/** A label needs about this much room before two of them collide. */
const MIN_TICK_PIXELS = 52;

/** And this much before a date band is a date nobody can read. Folding makes
 * that reachable in a way it was not before: a civil day the festival barely
 * touches — ten minutes past midnight, then nothing — keeps its band, and the
 * band is now ten minutes wide. */
const MIN_BAND_PIXELS = 44;

/**
 * Below this many pixels an hour, a line every hour is a line every few
 * pixels — the grid a coordinator asked for so a start time reads as "on the
 * hour" at a glance, turned into a smear that reads as nothing. Zoomed out
 * that far the labelled ticks already thin themselves out for the same
 * reason (`tickMinutes`); the hour grid does the same rather than fight it.
 */
const MIN_HOUR_LINE_PIXELS = 24;

/**
 * The blank axis kept around every day — the room a bar is lengthened into.
 *
 * Without it the shift board's edge drag cannot be reached at all. Every bar
 * is born spanning its whole event, so the edge a coordinator grabs sits
 * exactly on the end of the day; if the axis also ended there, there would be
 * no pixel to drag it to. Two hours is one ordinary slot and a bit, and the
 * margin moves out with the day each time, so a longer reach is the same
 * gesture twice rather than a special case.
 *
 * One constant for two things on purpose: it is what the axis reaches past the
 * first and last day, *and* what `axisFolds` leaves standing on each side of
 * every day in between.
 *
 * Fixed, and deliberately not derived from a drag: `xOf` reads
 * `scale.startMs`, so an axis that grew *while* the pointer was down would
 * move every bar out from under it.
 */
export const AXIS_MARGIN_MINUTES = 120;

/**
 * The floor under an elision, and the width one is drawn at.
 *
 * Two days five hours apart leave an hour between their margins; folding it
 * saves a screenful at the zooms that matter and nothing at all at the zooms
 * that do not, which is why `foldedTimeScale` also drops any fold that is not
 * already wider than its own marker. Below an hour there is nothing to say,
 * and a ruler broken every few minutes is worse than a long one.
 *
 * 40 px is a thumb-sized target and about as wide as the `⋯ 13 h` it carries —
 * the label is the point. An ellipsis that only said "something is missing"
 * would make a coordinator zoom out to find out *what*, and the whole reason
 * they are folded is so that nobody has to.
 */
const MIN_FOLD_MINUTES = 60;
const FOLD_PIXELS = 40;

/**
 * The ruler's three rows — date, clock, doors — plus one row per strip lane,
 * in `rem` so the whole thing scales with the viewer's text size (docs/14 §2).
 */
const AXIS_RULER_REM = 3.5;
const EVENT_LANE_REM = 1;

export interface AxisBand {
  readonly startMs: number;
  readonly endMs: number;
  readonly label: string;
}

export interface FoldMark {
  readonly key: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly label: string;
}

export interface PublicMark {
  readonly key: string;
  readonly atMs: number;
  readonly label: string;
}

export interface HourMark {
  readonly key: number;
  readonly atMs: number;
}

export interface MarginSpan {
  readonly key: string;
  readonly startMs: number;
  readonly endMs: number;
}

export interface BoardAxis {
  /** The scale, or `null` when no day is in view — every consumer has to
   * handle that anyway, because a board with no days has nothing to draw. */
  readonly scale: ComputedRef<TimeScale | null>;
  /** The full width of the track, in CSS pixels. */
  readonly laneWidth: ComputedRef<number>;
  /** The ruler's height, `rem`, including however deep the event strip is. */
  readonly axisHeight: ComputedRef<string>;
  /** The zone every label on this axis is rendered in. */
  readonly axisTimezone: ComputedRef<string>;
  /** How far the board lets anything travel: the axis, and nothing beyond. */
  readonly reach: ComputedRef<{
    readonly startMs: number;
    readonly endMs: number;
  }>;
  readonly bands: ComputedRef<readonly AxisBand[]>;
  readonly ticks: ComputedRef<
    readonly { readonly atMs: number; readonly label: string }[]
  >;
  /**
   * Where every civil hour starts, in the axis's own zone — independent of
   * `ticks`, which thins itself out to whatever spacing stays legible as the
   * board zooms. A coordinator asking "does this bar start on the hour?"
   * wants that answered at every zoom a bar can be seen at, not only the ones
   * where the ruler happens to label the hour.
   */
  readonly hourMarks: ComputedRef<readonly HourMark[]>;
  /** Time that is on the board but in no day, at either end. */
  readonly margins: ComputedRef<readonly MarginSpan[]>;
  /** The stretches the scale actually folded — one ellipsis each. */
  readonly foldMarks: ComputedRef<readonly FoldMark[]>;
  /** Stretches a coordinator has opened back up. */
  readonly openedMarks: ComputedRef<readonly FoldMark[]>;
  readonly publicMarks: ComputedRef<readonly PublicMark[]>;
  readonly strip: ComputedRef<EventLanes>;
  readonly toggleFold: (startMs: number) => void;
  readonly leftPx: (ms: number) => number;
  readonly boxStyle: (startMs: number, endMs: number) => Record<string, string>;
  readonly atStyle: (ms: number) => Record<string, string>;
  /** A position *inside* a box, which is a difference of two positions and not
   * the position of a difference. */
  readonly offsetStyle: (
    fromMs: number,
    atMs: number,
  ) => Record<string, string>;
  readonly eventLineStyle: (lane: EventLane) => Record<string, string>;
  /** A clock reading in the zone the work is actually done in. */
  readonly clockAt: (ms: number, timezone: string) => string;
}

export interface AxisOptions {
  /** The days laid on the axis, in any order. */
  readonly windows: MaybeRefOrGetter<readonly EventWindow[]>;
  /**
   * The zone the ruler itself is drawn in.
   *
   * One line, one clock. A festival spanning two zones cannot be ruled out and
   * a shared axis can only carry one reading; each bar still announces the
   * zone it is genuinely worked in, which is what docs/16 §1 cares about.
   */
  readonly timezone: MaybeRefOrGetter<string>;
  readonly locale: MaybeRefOrGetter<ViewerLocale>;
  /**
   * Overrides `AXIS_MARGIN_MINUTES` for callers that don't need the shift
   * board's drag reach — the assignation board never drags a shift's edge,
   * so reserving two hours of dead axis for a gesture it doesn't have is
   * blank space with nothing behind it. Everything *else* about the axis
   * (hour grid, day colour, folding of hours no day reaches) stays identical
   * between callers regardless of this value — that is the invariant the
   * file-top comment means, not the edge margin's width.
   */
  readonly marginMinutes?: number;
}

/**
 * How long a folded stretch is, in the coarsest unit that is still honest.
 *
 * Hours up to two days, then days: "62 h" is a number a coordinator has to
 * divide before it means anything, and all the ellipsis has to convey is the
 * order of magnitude of what is behind it. Rounded, because a fold's exact
 * length is the margin arithmetic and not a fact about the festival — the
 * precise instants are on the ticks either side of it.
 *
 * A catalogue message rather than `@evp/shared/intl`: that module is the only
 * route to a formatted *time* and rightly so (docs/16 §7), but this is a
 * duration, which has no timezone to get wrong — only a unit to spell.
 */
function foldLength(ms: number): string {
  const hours = Math.round(ms / (60 * MS_PER_MINUTE));
  return hours >= 48
    ? t('board.fold.days', { days: Math.round(hours / 24) })
    : t('board.fold.hours', { hours });
}

export function useAxis(options: AxisOptions): BoardAxis {
  const board = useBoardStore();
  const windows = computed(() => toValue(options.windows));
  const locale = computed(() => toValue(options.locale));
  const axisTimezone = computed(() => toValue(options.timezone));
  const marginMinutes = options.marginMinutes ?? AXIS_MARGIN_MINUTES;

  /**
   * One continuous axis across everything in view, day boundaries marked.
   *
   * The overnight case is the reason: a club night running 22:00–05:00 is one
   * stretch of work, and an axis that restarted at each midnight would cut it
   * in half down the middle of the busiest hour of the festival.
   */
  const daysSpan = computed(() => {
    const all = windows.value;
    if (all.length === 0) {
      return null;
    }
    const startMs = Math.min(...all.map((window) => window.startMs));
    const endMs = Math.max(...all.map((window) => window.endMs));
    return endMs > startMs ? { startMs, endMs } : null;
  });

  const span = computed(() => {
    const days = daysSpan.value;
    if (days === null) {
      return null;
    }
    const marginMs = marginMinutes * MS_PER_MINUTE;
    return {
      startMs: days.startMs - marginMs,
      endMs: days.endMs + marginMs,
    };
  });

  /** The axis, and nothing beyond it: a plan that reached further than the
   * coordinator can see would be a plan they did not make. */
  const reach = computed(() =>
    span.value === null
      ? { startMs: 0, endMs: 0 }
      : { startMs: span.value.startMs, endMs: span.value.endMs },
  );

  /**
   * The hours no day reaches, which the axis elides rather than scrolls
   * through.
   *
   * Computed from the *days*, never from the shifts: a mission with an empty
   * afternoon in the middle of the festival is a hole a coordinator has opened
   * this page to see, and folding it away would hide the answer to the
   * question (docs/01 §S8). Only time no event covers at all is time nobody is
   * working.
   */
  const candidateFolds = computed(() => {
    const axis = span.value;
    return axis === null
      ? []
      : axisFolds(windows.value, axis, marginMinutes, MIN_FOLD_MINUTES);
  });

  /**
   * Folds the coordinator has opened again, keyed on where they start.
   *
   * Elision that could not be undone would be the board deciding what is worth
   * looking at, and it would be wrong the moment somebody has a reason to put
   * work at 04:00 on a night nothing else runs — which is how a load-out gets
   * staffed. So every ellipsis is a button, and this is what it toggles.
   *
   * Keyed on the instant rather than on an index: widening a day moves the
   * fold that follows it, and an index would quietly transfer the
   * coordinator's "open" to a different stretch of the night.
   */
  const openedFolds = ref<ReadonlySet<number>>(new Set());

  function toggleFold(startMs: number): void {
    const next = new Set(openedFolds.value);
    if (!next.delete(startMs)) {
      next.add(startMs);
    }
    openedFolds.value = next;
  }

  const folds = computed(() =>
    candidateFolds.value.filter((fold) => !openedFolds.value.has(fold.startMs)),
  );

  const scale = computed(() => {
    const window = span.value;
    return window === null
      ? null
      : foldedTimeScale(
          window.startMs,
          window.endMs,
          board.pixelsPerMinute,
          folds.value,
          FOLD_PIXELS,
        );
  });

  const laneWidth = computed(() =>
    scale.value === null ? 0 : scaleWidth(scale.value),
  );

  function leftPx(ms: number): number {
    return scale.value === null ? 0 : xOf(scale.value, ms);
  }

  function boxStyle(startMs: number, endMs: number): Record<string, string> {
    const left = leftPx(startMs);
    return {
      left: `${String(left)}px`,
      width: `${String(Math.max(leftPx(endMs) - left, 1))}px`,
    };
  }

  function atStyle(ms: number): Record<string, string> {
    return { left: `${String(leftPx(ms))}px` };
  }

  function offsetStyle(fromMs: number, atMs: number): Record<string, string> {
    return { left: `${String(leftPx(atMs) - leftPx(fromMs))}px` };
  }

  function clockAt(ms: number, timezone: string): string {
    return formatTime(ms, {
      locale: locale.value,
      timeZone: eventTimeZone(timezone),
    });
  }

  /** Coarsen the ruler as the board zooms out, rather than letting labels
   * overlap into an unreadable smear. */
  const tickMinutes = computed(() => {
    const choices = [15, 30, 60, 120, 180, 360, 720, 1440];
    return (
      choices.find(
        (minutes) => minutes * board.pixelsPerMinute >= MIN_TICK_PIXELS,
      ) ?? 1440
    );
  });

  // Cut from the days, not from the axis: a band is a *date of the festival*,
  // and running it across the margin would put a second, two-hour-wide label
  // on a day nobody is working.
  //
  // Then dropped where folding has left it no room. A band is a date *and* the
  // stretch it covers, and one squeezed to a few pixels keeps only the label —
  // which then overhangs into the next date and says the wrong thing about it.
  const bands = computed(() => {
    const window = daysSpan.value;
    return window === null
      ? []
      : axisDays(
          window.startMs,
          window.endMs,
          axisTimezone.value,
          locale.value,
        ).filter(
          (band) =>
            leftPx(band.endMs) - leftPx(band.startMs) >= MIN_BAND_PIXELS,
        );
  });

  // A tick inside a fold is a clock reading with no room to be at: forty
  // pixels would carry a night's worth of them, stacked into an inkblot. The
  // ticks on the fold's own two edges survive, which is what keeps it readable
  // as "from 19:00 to 08:00" rather than as an unlabelled break.
  const ticks = computed(() => {
    const window = span.value;
    const current = scale.value;
    return window === null || current === null
      ? []
      : axisTicks(
          window.startMs,
          window.endMs,
          axisTimezone.value,
          locale.value,
          tickMinutes.value,
        ).filter((tick) => !isFolded(current, tick.atMs));
  });

  /**
   * Every civil hour, straight down the board, so a bar's start reads as "on
   * the hour" or not without a coordinator doing the arithmetic.
   *
   * Built from `axisTicks` at a fixed 60-minute step rather than reusing
   * `ticks`: the ruler's own ticks coarsen as the board zooms out
   * (`tickMinutes`), and an hour grid that thinned out the same way would stop
   * answering the question it exists for at exactly the zoom a whole day is in
   * view. Dropped once an hour is fewer pixels than a line is wide apart —
   * below that it is not a grid, it is a fill.
   */
  const hourMarks = computed<readonly HourMark[]>(() => {
    const window = span.value;
    const current = scale.value;
    if (
      window === null ||
      current === null ||
      60 * board.pixelsPerMinute < MIN_HOUR_LINE_PIXELS
    ) {
      return [];
    }
    return axisTicks(
      window.startMs,
      window.endMs,
      axisTimezone.value,
      locale.value,
      60,
    )
      .filter((tick) => !isFolded(current, tick.atMs))
      .map((tick) => ({ key: tick.atMs, atMs: tick.atMs }));
  });

  /**
   * The blank ends of the axis — time that is on the board but not in any day.
   *
   * Drawn rather than left white because it is the only affordance for the
   * gesture that puts work there: a coordinator has to be able to see that
   * there *is* somewhere past closing time, and that it is not part of the day
   * yet.
   */
  const margins = computed<readonly MarginSpan[]>(() => {
    const days = daysSpan.value;
    const axis = span.value;
    return days === null || axis === null
      ? []
      : [
          { key: 'before', startMs: axis.startMs, endMs: days.startMs },
          { key: 'after', startMs: days.endMs, endMs: axis.endMs },
        ];
  });

  /**
   * The ellipses themselves — one per stretch the scale actually folded.
   *
   * Read back off the scale rather than off `folds`, because the scale drops a
   * fold its zoom has already made narrower than the marker. Taking the list
   * from anywhere else would draw an ellipsis over time that is fully in view,
   * which is the one thing an ellipsis must never do.
   */
  const foldMarks = computed<readonly FoldMark[]>(() => {
    const current = scale.value;
    return current === null
      ? []
      : current.segments
          .filter((segment) => segment.folded)
          .map((segment) => ({
            key: segment.startMs,
            startMs: segment.startMs,
            endMs: segment.endMs,
            label: foldLength(segment.endMs - segment.startMs),
          }));
  });

  /**
   * Stretches a coordinator has opened back up — drawn, because otherwise the
   * only way back to the folded reading would be to remember having opened it.
   *
   * From `candidateFolds`, not from the scale: an opened fold is by definition
   * not a segment any more.
   */
  const openedMarks = computed<readonly FoldMark[]>(() =>
    candidateFolds.value
      .filter((fold) => openedFolds.value.has(fold.startMs))
      .map((fold) => ({
        key: fold.startMs,
        startMs: fold.startMs,
        endMs: fold.endMs,
        label: foldLength(fold.endMs - fold.startMs),
      })),
  );

  /**
   * Doors open and doors close, for a day that has published them.
   *
   * Only for those days: most events never state a door time, and a mark
   * invented from the ends of the operational window would be a mark saying
   * something nobody said.
   */
  const publicMarks = computed<readonly PublicMark[]>(() =>
    windows.value.flatMap((window) => {
      const { publicStartMs, publicEndMs } = window;
      if (publicStartMs === null || publicEndMs === null) {
        return [];
      }
      return [
        {
          key: `${window.id}:open`,
          atMs: publicStartMs,
          label: t('board.publicMark.doors', {
            time: clockAt(publicStartMs, window.timezone),
          }),
        },
        {
          key: `${window.id}:close`,
          atMs: publicEndMs,
          label: t('board.publicMark.close', {
            time: clockAt(publicEndMs, window.timezone),
          }),
        },
      ];
    }),
  );

  /**
   * One coloured line per event, laid under the clock.
   *
   * The axis is deliberately one continuous line so an overnight shift reads
   * as one stretch of work, and the date bands on it mark civil midnights.
   * Neither says which *day of the festival* a given bar belongs to — Friday's
   * load-in starts at 08:00 and Saturday's club night ends at 05:00 on what
   * the calendar calls Sunday. The strip is that missing reading, and it is
   * the same colour every chip below is drawn in, so the answer is a match
   * rather than a sum.
   */
  const strip = computed(() => eventLanes(windows.value));

  const axisHeight = computed(
    () =>
      `${String(AXIS_RULER_REM + strip.value.rowCount * EVENT_LANE_REM)}rem`,
  );

  function eventLineStyle(lane: EventLane): Record<string, string> {
    return {
      ...boxStyle(lane.window.startMs, lane.window.endMs),
      background: eventColor(lane.window.color),
      top: `${String(AXIS_RULER_REM + lane.row * EVENT_LANE_REM)}rem`,
    };
  }

  return {
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
  };
}
