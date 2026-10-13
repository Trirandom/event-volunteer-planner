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

describe('what a picker is offered', () => {
  /**
   * The two numbers are allowed to differ, in one direction. Offering more
   * than the column admits is a 422 waiting to happen; offering fewer is the
   * point of `eventColorChoiceCount`.
   */
  it('never offers an index the column would refuse', () => {
    expect(eventColorChoiceCount).toBeLessThanOrEqual(eventColorCount);
  });

  it('offers the vivid half, in palette order', () => {
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
   * whole palette — must find its own colour in the grid, or saving anything
   * else about it would quietly move it to whichever swatch got ticked
   * instead.
   */
  it('keeps a stored muted colour choosable, at the end', () => {
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
