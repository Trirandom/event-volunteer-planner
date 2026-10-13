// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * WCAG 2.x relative luminance and contrast ratio.
 *
 * Pure arithmetic, which is why it is here rather than in a test helper: the
 * token contrast gate in docs/14 §7 has to be able to fail the build, and a
 * gate implemented inside the test it guards is not a gate.
 */

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** Parses `#rrggbb`. Returns undefined rather than throwing — parse, don't cast. */
export function parseHex(hex: string): Rgb | undefined {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
    return undefined;
  }
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return { r, g, b };
}

function channel(value8Bit: number): number {
  const c = value8Bit / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** 1 to 21. Order-independent, as WCAG defines it. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** docs/14 §2: 4.5:1 for body text, 3:1 for large text and UI boundaries. */
export const AA_BODY_TEXT = 4.5;
export const AA_LARGE_TEXT_AND_UI = 3;
