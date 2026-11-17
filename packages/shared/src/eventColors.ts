// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The 64 colours an event may be drawn in, as data.
 *
 * A festival's days need telling apart at a glance on the board, in the day
 * strip and in whatever chip the roster ends up printed on, and the one thing
 * a colour used that way must survive is being put next to either kind of
 * text. So every entry here clears **4.5:1 against both `#000000` and
 * `#ffffff`** — the body-text threshold, not the 3:1 graphics one, because a
 * coordinator will inevitably use one of these as a text colour and the
 * palette has no way to stop them. `eventColors.test.ts` is the gate;
 * `contrast.ts` is the same arithmetic the semantic tokens are proved with.
 *
 * That requirement is what fixes the *shape* of the palette. Contrast against
 * black rises with luminance and contrast against white falls with it, so
 * clearing 4.5:1 on both sides admits a band of sRGB relative luminance
 * roughly 0.175–0.183 wide and nothing else. Every colour below therefore
 * sits at essentially one luminance (≈0.179, giving ≈4.56:1 each way) and
 * varies only in hue and chroma. There is no "light" or "dark" variant to be had, and
 * asking for one would be asking to fail the gate.
 *
 * **The order is part of the contract, twice over.**
 *
 * The database stores an *index* into this list, not a hex (see the
 * `events.color` migration), so reordering or removing an entry silently
 * recolours every event already assigned. That is why narrowing what a
 * coordinator may *pick* is `eventColorChoiceCount` below and not a shorter
 * list: the two numbers are allowed to differ, and this one may not shrink.
 * Entries may be corrected in place when a value is wrong; they may not be
 * moved. Appending past 64 needs the column's `CHECK` widened in a new
 * migration.
 *
 * And the order is what a festival's days are handed: the server gives a new
 * event the lowest index its siblings are not using, so the first *n* entries
 * are an *n*-day festival's colours. Indices 0–15 are therefore chosen and
 * ordered for distance (ADR-0050): the 16 contrast-passing colours whose
 * closest pair is as far apart as possible in OKLab, each one the farthest
 * remaining from all before it. They were once a 13/32 hue step, which kept
 * neighbours apart but put index 5 one thirty-second of a turn from index 0 —
 * two days nobody could tell apart. 16–63 are still that older sequence, kept
 * because an event may hold one of them.
 */

/**
 * Indexed by `events.color`. Generated against the luminance target described
 * above rather than picked by eye — see the module comment for why the values
 * are as narrow in lightness as they are. `eventColors.test.ts` gates both the
 * contrast and the distance.
 */
export const eventColors: readonly string[] = [
  // 0–15: the offered sixteen (ADR-0050), farthest-point ordered.
  '#e40079',
  '#008a01',
  '#0a6aff',
  '#b70aff',
  '#af6304',
  '#8c66a3',
  '#018092',
  '#e52701',
  '#8259ec',
  '#d900b9',
  '#bd5560',
  '#4a74c4',
  '#807701',
  '#ad47cd',
  '#3f8459',
  '#bc4996',
  // 16–63: the original hue-stepped sequence, drawable but no longer offered.
  '#008574',
  '#ce00d6',
  '#767b00',
  '#006ff6',
  '#c65100',
  '#008380',
  '#d800b6',
  '#637f00',
  '#4a65ff',
  '#b55e00',
  '#00828a',
  '#df0097',
  '#438500',
  '#6c5bff',
  '#a86700',
  '#008195',
  '#b15a77',
  '#518055',
  '#7c68be',
  '#89724e',
  '#517b8c',
  '#b35a68',
  '#527f64',
  '#8c61be',
  '#83744e',
  '#517a94',
  '#b45b59',
  '#527e6e',
  '#9a5db4',
  '#7c764e',
  '#50799f',
  '#ad604f',
  '#527e75',
  '#a35ba4',
  '#75794d',
  '#4d76b5',
  '#a0684e',
  '#527d7b',
  '#a95a95',
  '#6c7b4d',
  '#5c72bc',
  '#976c4e',
  '#527d80',
  '#ae5a86',
  '#5e7e4d',
  '#6c6dbd',
  '#8f704e',
  '#527c86',
];

/** How many indices the column's `CHECK` admits. */
export const eventColorCount = 64;

/**
 * How many of them a coordinator is *offered*: one row of sixteen (ADR-0050).
 *
 * Fewer than the column admits, and deliberately not the same number. At one
 * luminance only hue and chroma separate colours, and sixteen is about as many
 * as stay plainly distinct that way; past it, a grid of swatches turns into
 * pairs a person hesitates over, a decision about nothing.
 *
 * It is a *choice* count rather than a shorter palette because the order is
 * the contract (see above): dropping entries would recolour every event
 * already sitting on one of them, and the column would still hand them back.
 * So the rest stay drawable and stop being offerable — an event that holds
 * one keeps it, and `eventColorChoices` is what puts it back on screen beside
 * the sixteen rather than leaving its owner looking at a row with nothing
 * selected in it.
 */
export const eventColorChoiceCount = 16;

/**
 * The indices a picker should show for an event currently on `current`.
 *
 * The offered range, plus `current` appended when it falls outside it — never
 * inserted in its place in the order, because the sixteen are a contiguous block a
 * keyboard walks through and a hole in it would be one arrow key landing on a
 * colour nobody can choose again once they leave.
 *
 * An index this build does not know at all (`>= eventColorCount`) is not
 * appended: `eventColor` already answers that with colour 0, and offering a
 * swatch that draws as a different colour than the row stores would be worse
 * than a grid with nothing ticked.
 */
export function eventColorChoices(current: number): readonly number[] {
  const offered = Array.from(
    { length: eventColorChoiceCount },
    (_unused, index) => index,
  );

  return Number.isInteger(current) &&
    current >= eventColorChoiceCount &&
    current < eventColorCount
    ? [...offered, current]
    : offered;
}

/**
 * The hex for a stored index.
 *
 * Falls back to index 0 rather than returning `undefined`: the column is
 * `NOT NULL` and range-checked, so an out-of-range value here means this
 * build is older than the row it is drawing, and a visibly wrong colour is a
 * better answer than a missing one. `noUncheckedIndexedAccess` is what makes
 * the fallback explicit instead of a lie in the type.
 */
export function eventColor(index: number): string {
  return eventColors[index] ?? eventColors[0] ?? '#000000';
}
