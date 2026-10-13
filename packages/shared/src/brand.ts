// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

/**
 * The brand ramps, as data.
 *
 * Five families, eleven steps each, in the Tailwind convention — which is not
 * a coincidence: `src/styles/brand.css` restates exactly these under the names
 * Tailwind v4's `@theme` block turns into utilities, so `bg-muted-teal-600` in
 * a template and `brand['muted-teal'][600]` in a script are the same colour by
 * construction rather than by hope. `tokens.test.ts` asserts the two agree.
 *
 * This file is the *raw material*. Nothing in the application should reach for
 * a ramp step directly to colour text or a control — those decisions are the
 * semantic tokens in `tokens.ts`, which are the ones the contrast gate proves.
 * A ramp step used raw is a colour nobody checked. The legitimate exceptions
 * are decorative surfaces that carry no information: a hero wash, a logo
 * plate, a divider gradient.
 *
 * Step 600 of `muted-teal` (#4a8251) is the green in `logo.svg`. It is the one
 * value here that cannot be changed without redrawing the mark.
 */

export type BrandFamily =
  'muted-teal' | 'deep-teal' | 'apricot-cream' | 'sandy-clay' | 'light-coral';

export const brandFamilies: readonly BrandFamily[] = [
  'muted-teal',
  'deep-teal',
  'apricot-cream',
  'sandy-clay',
  'light-coral',
];

export type BrandStep =
  50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 | 950;

export const brandSteps: readonly BrandStep[] = [
  50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950,
];

export type BrandRamp = Readonly<Record<BrandStep, string>>;

export const brand: Readonly<Record<BrandFamily, BrandRamp>> = {
  /** The mark's green. Primary actions, and everything that means "this is us". */
  'muted-teal': {
    50: '#eff6f0',
    100: '#dfece0',
    200: '#bedac1',
    300: '#9ec7a3',
    400: '#7db584',
    500: '#5da265',
    600: '#4a8251',
    700: '#38613d',
    800: '#254128',
    900: '#132014',
    950: '#0d170e',
  },
  /** Structure: body text, muted text, borders, and the dark theme's grounds. */
  'deep-teal': {
    50: '#eff5f3',
    100: '#e0ebe7',
    200: '#c0d8ce',
    300: '#a1c4b6',
    400: '#82b09e',
    500: '#629d85',
    600: '#4f7d6b',
    700: '#3b5e50',
    800: '#273f35',
    900: '#141f1b',
    950: '#0e1613',
  },
  /** Gold. The focus ring, and highlights that must not read as green. */
  'apricot-cream': {
    50: '#fdf5e8',
    100: '#faead1',
    200: '#f6d6a2',
    300: '#f1c174',
    400: '#edad45',
    500: '#e89817',
    600: '#ba7a12',
    700: '#8b5b0e',
    800: '#5d3d09',
    900: '#2e1e05',
    950: '#201503',
  },
  /** Caution. Soft rule warnings — the overridable ones (ADR-0007). */
  'sandy-clay': {
    50: '#faf2eb',
    100: '#f4e6d7',
    200: '#eaccae',
    300: '#dfb386',
    400: '#d4995e',
    500: '#c98036',
    600: '#a1662b',
    700: '#794d20',
    800: '#513315',
    900: '#281a0b',
    950: '#1c1207',
  },
  /** Refusal. A hard constraint the database will not accept. */
  'light-coral': {
    50: '#fce8e8',
    100: '#fad2d1',
    200: '#f5a5a3',
    300: '#f07775',
    400: '#eb4a47',
    500: '#e61d19',
    600: '#b81714',
    700: '#8a110f',
    800: '#5c0c0a',
    900: '#2e0605',
    950: '#200404',
  },
};

/**
 * `('muted-teal', 500)` → `--color-muted-teal-500`.
 *
 * The `--color-` prefix is Tailwind v4's namespace for colours: a variable
 * declared under that name inside `@theme` generates `bg-`, `text-`, `border-`
 * and friends for it. So this is the utility name as much as the variable one.
 */
export function brandVariableName(
  family: BrandFamily,
  step: BrandStep,
): string {
  return `--color-${family}-${String(step)}`;
}
