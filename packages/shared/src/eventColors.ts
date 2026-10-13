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
 * varies only in hue and chroma: 32 hues at full in-gamut chroma, then the
 * same 32 again at half. There is no "light" or "dark" variant to be had, and
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
 * And the sequence is deliberately not the colour wheel: consecutive indices
 * step 13/32 of the way around it, ~146° apart. The server hands a new event
 * the lowest index its siblings are not using, so "the next colour" has to be
 * one nobody will confuse with the last one — which a hue-ordered list would
 * get exactly wrong. The first 32 are the full-chroma half, so a festival
 * exhausts the vivid colours before it reaches the muted ones.
 */

/**
 * Indexed by `events.color`. Generated against the luminance target described
 * above rather than picked by eye — see the module comment for why the values
 * are as narrow in lightness as they are.
 */
export const eventColors: readonly string[] = [
  '#e40079',
  '#00882b',
  '#894eff',
  '#9c6d00',
  '#007fa2',
  '#e8005a',
  '#008752',
  '#a537ff',
  '#907200',
  '#007db1',
  '#eb0033',
  '#008666',
  '#c000f7',
  '#847600',
  '#0079c7',
  '#de3200',
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
 * How many of them a coordinator is *offered*.
 *
 * Fewer than the column admits, and deliberately not the same number. The
 * second half of the list is the first half again at half chroma — the same
 * 32 hues, muted — and on a grid of swatches those are the pairs a person
 * hesitates over: picking between `#e40079` and `#b15a77` is a decision about
 * nothing, made 32 times. The vivid half is also the half that survives being
 * shrunk to a 10 px dot in a day strip, which is where an event colour is
 * mostly read.
 *
 * It is a *choice* count rather than a shorter palette because the order is
 * the contract (see above): dropping entries 32–63 would recolour every event
 * already sitting on one of them, and the column would still hand them back.
 * So the muted half stays drawable and stops being offerable — an event that
 * holds one keeps it, and `eventColorChoices` is what puts it back on screen
 * beside the 32 rather than leaving its owner looking at a grid with nothing
 * selected in it.
 */
export const eventColorChoiceCount = 32;

/**
 * The indices a picker should show for an event currently on `current`.
 *
 * The offered range, plus `current` appended when it falls outside it — never
 * inserted in its place in the order, because the 32 are a contiguous block a
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
