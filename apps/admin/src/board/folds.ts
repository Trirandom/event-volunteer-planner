// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * Which stretches of the axis have nothing on them — the hours the board
 * elides.
 *
 * A festival is mostly not happening. Soundclash runs Friday 18:00–05:00 and
 * Saturday 18:00–06:00; between the two there are thirteen hours in which no
 * volunteer is anywhere, and on a continuous axis at a zoom where a 45-minute
 * slot can be grabbed, those thirteen hours are wider than either night. The
 * coordinator comparing Friday's bar rota with Saturday's scrolls a screen and
 * a half of blank track to do it, and the two things they are comparing are
 * never on screen together — which is the one thing the board exists for.
 *
 * So the empty stretches are folded away and `scale.ts` draws each as a few
 * pixels of ellipsis.
 *
 * **Every day keeps a margin of air on both sides.** The board's edge drag is
 * the reason and it is not a cosmetic one: a bar is born spanning its whole
 * event, so the handle a coordinator grabs sits exactly on the end of the day,
 * and dragging it outwards is how the day itself is lengthened
 * (`PlanShiftsView.vue`). Fold flush to the last shift and that gesture has
 * nowhere to land — the pixel past closing time would be the ellipsis, and the
 * ellipsis is not a time anyone can drop an edge on. The margin is the same
 * two hours the axis already reaches past the first and last day, for the same
 * reason and to the same end: one ordinary slot and a bit, and it moves out
 * with the day each time, so a longer reach is the same gesture twice.
 *
 * Pure, and over plain spans rather than over `EventWindow`, because what
 * makes a stretch empty is only that no event covers it. Test-first: this
 * decides what a coordinator can see, and "the board hid an afternoon that had
 * work in it" is not a bug that announces itself.
 */

import type { MsSpan } from './scale';

const MS_PER_MINUTE = 60_000;

/**
 * Merge `spans` into the fewest disjoint spans covering the same time.
 *
 * Touching counts as overlapping: two days whose margins meet exactly are one
 * continuous stretch of visible axis, and leaving a zero-length gap between
 * them would put an ellipsis over no time at all.
 */
function merged(spans: readonly MsSpan[]): readonly MsSpan[] {
  const ordered = [...spans].sort((a, b) => a.startMs - b.startMs);
  const out: MsSpan[] = [];

  for (const span of ordered) {
    const last = out.at(-1);
    if (last === undefined || span.startMs > last.endMs) {
      out.push(span);
      continue;
    }
    // In start order, so only the reach can grow — and it can *shrink* in the
    // input, a day wholly inside a longer one, which `Math.max` absorbs.
    out.splice(out.length - 1, 1, {
      startMs: last.startMs,
      endMs: Math.max(last.endMs, span.endMs),
    });
  }

  return out;
}

/**
 * The stretches of `axis` that no event reaches, once every event is given
 * `marginMinutes` of air on each side.
 *
 * `minFoldMinutes` is the floor below which eliding is not worth saying so:
 * two days four hours and ten minutes apart leave ten minutes between their
 * margins, and an ellipsis announcing that it has hidden ten minutes tells a
 * coordinator nothing and costs them the continuity of the ruler. (Whether a
 * fold is worth it *in pixels* is `scale.ts`'s call, because only that depends
 * on the zoom.)
 *
 * No events means no folds rather than one fold over everything: an axis with
 * nothing on it is already the empty board, and crushing it would leave a
 * coordinator with an ellipsis and no way back.
 */
export function axisFolds(
  windows: readonly MsSpan[],
  axis: MsSpan,
  marginMinutes: number,
  minFoldMinutes: number,
): readonly MsSpan[] {
  if (!(marginMinutes >= 0)) {
    throw new RangeError('a fold margin cannot be negative');
  }
  if (!(minFoldMinutes > 0)) {
    throw new RangeError('a fold floor must be a positive number of minutes');
  }
  if (windows.length === 0) {
    return [];
  }

  const marginMs = marginMinutes * MS_PER_MINUTE;
  const kept = merged(
    windows
      .map((window) => ({
        startMs: Math.max(window.startMs - marginMs, axis.startMs),
        endMs: Math.min(window.endMs + marginMs, axis.endMs),
      }))
      .filter((span) => span.endMs > span.startMs),
  );

  const floorMs = minFoldMinutes * MS_PER_MINUTE;
  const folds: MsSpan[] = [];
  let cursor = axis.startMs;

  for (const span of kept) {
    if (span.startMs - cursor >= floorMs) {
      folds.push({ startMs: cursor, endMs: span.startMs });
    }
    cursor = Math.max(cursor, span.endMs);
  }
  if (axis.endMs - cursor >= floorMs) {
    folds.push({ startMs: cursor, endMs: axis.endMs });
  }

  return folds;
}
