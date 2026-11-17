// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { describe, expect, it } from 'vitest';

import { AA_BODY_TEXT, contrastRatio, parseHex } from './contrast.js';
import {
  eventColor,
  eventColorChoiceCount,
  eventColorChoices,
  eventColorCount,
  eventColors,
} from './eventColors.js';

const BLACK = { r: 0, g: 0, b: 0 };
const WHITE = { r: 255, g: 255, b: 255 };

function rgbOf(hex: string) {
  const rgb = parseHex(hex);
  if (rgb === undefined) {
    throw new Error(`${hex} is not a #rrggbb value`);
  }
  return rgb;
}

/**
 * OKLab (Ottosson 2020), whose Euclidean distance tracks how different two
 * colours look far better than any distance in sRGB. Here rather than in the
 * library because only the gate needs it: nothing at runtime compares colours.
 */
function oklabOf(hex: string): readonly [number, number, number] {
  const { r, g, b } = rgbOf(hex);
  const linear = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
  const l = Math.cbrt(
    0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb,
  );
  const m = Math.cbrt(
    0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb,
  );
  const s = Math.cbrt(
    0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb,
  );
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabDistance(a: string, b: string): number {
  const [l1, a1, b1] = oklabOf(a);
  const [l2, a2, b2] = oklabOf(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** Every pair among the first `count` indices that is closer than `floor`,
 * as a readable list, so a failure names the colours rather than a number. */
function pairsCloserThan(count: number, floor: number): string[] {
  const close: string[] = [];
  for (let i = 0; i < count; i += 1) {
    for (let j = 0; j < i; j += 1) {
      const distance = oklabDistance(eventColor(i), eventColor(j));
      if (distance < floor) {
        close.push(
          `${String(j)} ${eventColor(j)} / ${String(i)} ${eventColor(i)}: ${distance.toFixed(3)}`,
        );
      }
    }
  }
  return close;
}

describe('the event colour palette', () => {
  it('has exactly as many entries as the column admits', () => {
    expect(eventColors).toHaveLength(eventColorCount);
  });

  // The gate the palette exists to pass. An event colour is used as a chip
  // background with text of either polarity on it, *and* as a text colour on
  // either background — so the body-text threshold has to hold in all four
  // directions, which for a single colour reduces to these two.
  for (const [index, hex] of eventColors.entries()) {
    it(`clears ${String(AA_BODY_TEXT)}:1 against black and white at index ${String(index)}`, () => {
      const rgb = rgbOf(hex);
      const onBlack = contrastRatio(rgb, BLACK);
      const onWhite = contrastRatio(rgb, WHITE);

      expect(
        onBlack,
        `${hex} is ${onBlack.toFixed(2)}:1 on black`,
      ).toBeGreaterThanOrEqual(AA_BODY_TEXT);
      expect(
        onWhite,
        `${hex} is ${onWhite.toFixed(2)}:1 on white`,
      ).toBeGreaterThanOrEqual(AA_BODY_TEXT);
    });
  }

  it('has no duplicate entries', () => {
    expect(new Set(eventColors).size).toBe(eventColors.length);
  });

  /**
   * Consecutive indices are what a festival's days get handed, so "not the
   * same colour" is not enough — they have to be told apart across a board.
   * A crude channel-distance floor catches a palette accidentally reordered
   * into hue order without pretending to be a perceptual metric.
   */
  it('keeps consecutive indices far apart', () => {
    for (let index = 1; index < eventColors.length; index += 1) {
      const previous = rgbOf(eventColor(index - 1));
      const current = rgbOf(eventColor(index));
      const distance =
        Math.abs(previous.r - current.r) +
        Math.abs(previous.g - current.g) +
        Math.abs(previous.b - current.b);
      expect(
        distance,
        `${eventColor(index - 1)} and ${eventColor(index)} are neighbours`,
      ).toBeGreaterThan(120);
    }
  });

  it('falls back to the first colour for an index this build does not know', () => {
    expect(eventColor(eventColorCount)).toBe(eventColors[0]);
    expect(eventColor(-1)).toBe(eventColors[0]);
  });
});

/**
 * ADR-0050. At one luminance, only hue and chroma tell colours apart, so a
 * palette can pass every contrast test and still offer two pinks nobody can
 * tell apart (indices 0 and 5 used to be 0.047 apart). A JND in OKLab is about
 * 0.02, so these floors are four to ten of them.
 */
describe('the offered colours, told apart', () => {
  it('keeps every offered pair visibly different', () => {
    expect(pairsCloserThan(eventColorChoiceCount, 0.09)).toEqual([]);
  });

  /** A festival's days are handed the lowest free index, so the first few
   * are the colours most boards are drawn in. */
  it('keeps the first four, a short festival, far apart', () => {
    expect(pairsCloserThan(4, 0.2)).toEqual([]);
  });

  /** In one row, so the offer reads as one set rather than a grid to scan. */
  it('offers sixteen', () => {
    expect(eventColorChoiceCount).toBe(16);
  });
});

describe('what a picker is offered', () => {
  /**
   * The two numbers are allowed to differ, in one direction. Offering more
   * than the column admits is a 422 waiting to happen; offering fewer is the
   * point of `eventColorChoiceCount`.
   */
  it('never offers an index the column would refuse', () => {
    expect(eventColorChoiceCount).toBeLessThanOrEqual(eventColorCount);
  });

  it('offers the first indices, in palette order', () => {
    expect(eventColorChoices(0)).toEqual(
      Array.from({ length: eventColorChoiceCount }, (_unused, i) => i),
    );
  });

  it('offers nothing twice for an event already on an offered colour', () => {
    const choices = eventColorChoices(7);
    expect(choices).toHaveLength(eventColorChoiceCount);
    expect(new Set(choices).size).toBe(choices.length);
  });

  /**
   * The case this function exists for. An event created before the choice was
   * narrowed — or coloured by the server, which still allocates out of the
   * whole palette — must find its own colour in the row, or saving anything
   * else about it would quietly move it to whichever swatch got ticked
   * instead.
   */
  it('keeps a stored unoffered colour choosable, at the end', () => {
    const choices = eventColorChoices(40);
    expect(choices).toHaveLength(eventColorChoiceCount + 1);
    expect(choices.at(-1)).toBe(40);
    expect(choices.slice(0, eventColorChoiceCount)).toEqual(
      eventColorChoices(0),
    );
  });

  it('does not offer an index this build cannot draw', () => {
    expect(eventColorChoices(eventColorCount)).toEqual(eventColorChoices(0));
    expect(eventColorChoices(-1)).toEqual(eventColorChoices(0));
  });
});
