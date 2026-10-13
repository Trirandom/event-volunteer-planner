// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The semantic palette, as data.
 *
 * Every value is a step of a brand ramp (`brand.ts`) rather than a hex typed
 * here, so "which green is the primary action" has one answer and changing a
 * ramp moves the token with it. What this file adds on top of the ramps is the
 * part a ramp cannot express: *which* step may be used for *what*, given the
 * background it lands on.
 *
 * It lives in TypeScript rather than only in CSS so that the contrast gate in
 * docs/14 §7 can be an ordinary unit test instead of a screenshot diff.
 * `src/styles/tokens.css` restates these as custom properties and
 * `tokens.test.ts` asserts the two agree, so the CSS cannot drift away from
 * the values that were proved conformant.
 *
 * Both themes meet the requirements independently (docs/14 §6). No token is
 * defined only inside a media query.
 *
 * Two deliberate collisions, because the ramps are narrower than the vocabulary
 * and colour is never the only carrier of meaning here (docs/14 §2):
 *
 * - `success` and `accentHover` are the same green. One is text, the other a
 *   button background; they never appear as the same kind of thing.
 * - `accent` and `success` are both green at all, which they must be — the
 *   brand is green and so is "satisfied". Every success state is an icon and a
 *   sentence as well, so nothing rests on telling the two greens apart.
 *
 * What is *not* a collision, and is load-bearing: `focus` is gold and `danger`
 * is coral, so neither can be mistaken for the brand or for each other.
 */

import { brand } from './brand.js';

export type ThemeName = 'light' | 'dark';

export interface Palette {
  /** Page background. */
  readonly surface: string;
  /** Cards, the planner board's row bands, dialogs. Also the hover ground for a row on `surface`. */
  readonly surfaceRaised: string;
  /** Body text. */
  readonly text: string;
  /** Secondary text: timezone labels, counts, help text. */
  readonly textMuted: string;
  /** Control and cell boundaries. A UI boundary, so 3:1 not 4.5:1. */
  readonly border: string;
  /** Primary action background. The mark's green, one step deeper so text can sit on it. */
  readonly accent: string;
  /** Primary action background, hovered and active. */
  readonly accentHover: string;
  /** Text drawn on `accent` and on `accentHover`. */
  readonly onAccent: string;
  /** Focus ring. Never removed; 3:1 against what it sits on (docs/14 §2). */
  readonly focus: string;
  /** A hard constraint refusal. Always paired with an icon and text. */
  readonly danger: string;
  /** A soft rule warning. */
  readonly warning: string;
  /** A satisfied requirement. */
  readonly success: string;
  /**
   * A green that marks a *graphic*, not a word.
   *
   * `success` is proven at 4.5:1 because it colours text, and at that
   * threshold the light theme's green is `muted-teal-800` — near enough to
   * black that a 2 px tick drawn in it reads as black. A mark is a
   * non-text contrast object (WCAG 1.4.11, 3:1), so it can and must be the
   * lighter step that actually looks green. The planner board's shift cuts
   * are the first user, and they are never the sole carrier of meaning: the
   * bar beneath them is also divided, and every slot is in the accessible
   * name of its own edge handles.
   */
  readonly mark: string;
}

export const palettes: Readonly<Record<ThemeName, Palette>> = {
  light: {
    // White rather than `muted-teal-50`: the tint is what makes a card read as
    // raised, and it cannot do that if the page is already tinted.
    surface: '#ffffff',
    surfaceRaised: brand['muted-teal'][50],
    text: brand['deep-teal'][950],
    textMuted: brand['deep-teal'][700],
    // 600 and not 500: a border has to clear 3:1 against `surfaceRaised` too,
    // and every family's 500 step falls under it on a tinted ground.
    border: brand['deep-teal'][600],
    // 700 and not the mark's own 600: 600 is 4.15:1 on `surfaceRaised`, so an
    // accent-coloured link inside a card would fail. The mark keeps 600.
    accent: brand['muted-teal'][700],
    accentHover: brand['muted-teal'][800],
    onAccent: '#ffffff',
    focus: brand['apricot-cream'][700],
    danger: brand['light-coral'][600],
    warning: brand['sandy-clay'][700],
    success: brand['muted-teal'][800],
    // The mark's own 600 — the one step `accent` had to give up to clear
    // 4.5:1 as a link, and the one this token exists to keep.
    mark: brand['muted-teal'][600],
  },
  dark: {
    surface: brand['deep-teal'][950],
    surfaceRaised: brand['deep-teal'][900],
    text: brand['muted-teal'][50],
    textMuted: brand['deep-teal'][400],
    // The one token with the same value in both themes, and it earns it: 600
    // is the only step that clears 3:1 against a near-white ground *and* a
    // near-black one.
    border: brand['deep-teal'][600],
    accent: brand['muted-teal'][300],
    accentHover: brand['muted-teal'][200],
    onAccent: brand['deep-teal'][950],
    focus: brand['apricot-cream'][400],
    danger: brand['light-coral'][300],
    warning: brand['sandy-clay'][300],
    success: brand['muted-teal'][200],
    mark: brand['muted-teal'][300],
  },
};

/**
 * Which pairs actually appear together on screen, and at which threshold.
 * Adding a token without adding it here is how a palette quietly stops being
 * conformant, so the test also asserts that every token is covered.
 *
 * `surfaceRaised` carries the same requirements as `surface` for every
 * foreground, not only for body text: a card is a place where anything may be
 * rendered, and a token that is legible on the page but not inside a dialog is
 * a bug waiting for the first dialog.
 */
export interface ContrastRequirement {
  readonly foreground: keyof Palette;
  readonly background: keyof Palette;
  readonly minimum: 4.5 | 3;
}

export const contrastRequirements: readonly ContrastRequirement[] = [
  { foreground: 'text', background: 'surface', minimum: 4.5 },
  { foreground: 'text', background: 'surfaceRaised', minimum: 4.5 },
  { foreground: 'textMuted', background: 'surface', minimum: 4.5 },
  { foreground: 'textMuted', background: 'surfaceRaised', minimum: 4.5 },
  { foreground: 'accent', background: 'surface', minimum: 4.5 },
  { foreground: 'accent', background: 'surfaceRaised', minimum: 4.5 },
  { foreground: 'danger', background: 'surface', minimum: 4.5 },
  { foreground: 'danger', background: 'surfaceRaised', minimum: 4.5 },
  { foreground: 'warning', background: 'surface', minimum: 4.5 },
  { foreground: 'warning', background: 'surfaceRaised', minimum: 4.5 },
  { foreground: 'success', background: 'surface', minimum: 4.5 },
  { foreground: 'success', background: 'surfaceRaised', minimum: 4.5 },
  { foreground: 'onAccent', background: 'accent', minimum: 4.5 },
  { foreground: 'onAccent', background: 'accentHover', minimum: 4.5 },
  { foreground: 'border', background: 'surface', minimum: 3 },
  { foreground: 'border', background: 'surfaceRaised', minimum: 3 },
  { foreground: 'focus', background: 'surface', minimum: 3 },
  { foreground: 'focus', background: 'surfaceRaised', minimum: 3 },
  // 3, not 4.5: a tick on a timeline is a graphical object, and holding it to
  // the text threshold is what turned the last green into a black one.
  { foreground: 'mark', background: 'surface', minimum: 3 },
  { foreground: 'mark', background: 'surfaceRaised', minimum: 3 },
];

/** `surfaceRaised` → `--evp-surface-raised`. */
export function cssVariableName(token: keyof Palette): string {
  return `--evp-${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}
