// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  brand,
  brandFamilies,
  brandSteps,
  brandVariableName,
} from './brand.js';
import { contrastRatio, parseHex } from './contrast.js';
import {
  contrastRequirements,
  cssVariableName,
  palettes,
  type Palette,
  type ThemeName,
} from './tokens.js';

const themes: readonly ThemeName[] = ['light', 'dark'];

// `Object.keys`/`Object.entries` widen to `string`/`any`, and type assertions
// are banned (docs/11 §3), so the key list is derived from a value whose type
// is already `keyof Palette`. That the derivation is exhaustive is itself
// asserted below, by "requires a ratio for every token in every theme".
const tokenNames: readonly (keyof Palette)[] = contrastRequirements
  .flatMap(({ foreground, background }) => [foreground, background])
  .filter((token, i, all) => all.indexOf(token) === i);

function rgbOf(theme: ThemeName, token: keyof Palette) {
  const hex = palettes[theme][token];
  const rgb = parseHex(hex);
  if (rgb === undefined) {
    throw new Error(`${theme}.${token} is not a #rrggbb value: ${hex}`);
  }
  return rgb;
}

describe('palette contrast', () => {
  for (const theme of themes) {
    for (const { foreground, background, minimum } of contrastRequirements) {
      it(`meets ${String(minimum)}:1 for ${foreground} on ${background} in the ${theme} theme`, () => {
        const ratio = contrastRatio(
          rgbOf(theme, foreground),
          rgbOf(theme, background),
        );
        expect(
          ratio,
          `${theme}: ${foreground} (${palettes[theme][foreground]}) on ` +
            `${background} (${palettes[theme][background]}) is ` +
            `${ratio.toFixed(2)}:1, below the required ${String(minimum)}:1`,
        ).toBeGreaterThanOrEqual(minimum);
      });
    }
  }

  it('requires a ratio for every token in every theme', () => {
    const covered = new Set(
      contrastRequirements.flatMap(({ foreground, background }) => [
        foreground,
        background,
      ]),
    );
    const declared = Object.keys(palettes.light);
    expect([...declared].sort()).toEqual([...covered].sort());
  });
});

describe('tokens.css', () => {
  const css = readFileSync(
    fileURLToPath(new URL('./styles/tokens.css', import.meta.url)),
    'utf8',
  );

  function blockFor(theme: ThemeName): string {
    if (theme === 'light') {
      const match = /:root\s*\{([^}]*)\}/.exec(css);
      return match?.[1] ?? '';
    }
    const match =
      /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(
        css,
      );
    return match?.[1] ?? '';
  }

  for (const theme of themes) {
    it(`declares every ${theme} token with the value tokens.ts proved`, () => {
      const block = blockFor(theme);
      expect(block, `no ${theme} :root block found in tokens.css`).not.toBe('');

      for (const token of tokenNames) {
        const hex = palettes[theme][token];
        const name = cssVariableName(token);
        expect(block, `${name} missing from the ${theme} block`).toContain(
          `${name}:`,
        );
        const declared = new RegExp(`${name}:\\s*(#[0-9a-f]{6})`).exec(block);
        expect(
          declared?.[1],
          `${name} in tokens.css disagrees with tokens.ts`,
        ).toBe(hex);
      }
    });
  }
});

describe('brand.css', () => {
  const css = readFileSync(
    fileURLToPath(new URL('./styles/brand.css', import.meta.url)),
    'utf8',
  );

  // Tailwind's `@theme` is the only block in the file, and every ramp step
  // must be inside it: a `--color-*` declaration that escaped to plain `:root`
  // would still be a variable but would generate no utility, which is a
  // failure nobody notices until a class silently does nothing.
  const theme = /@theme\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';

  it('declares a @theme block', () => {
    expect(theme).not.toBe('');
  });

  for (const family of brandFamilies) {
    it(`restates the ${family} ramp exactly as brand.ts has it`, () => {
      for (const step of brandSteps) {
        const name = brandVariableName(family, step);
        const declared = new RegExp(`${name}:\\s*(#[0-9a-f]{6})`).exec(theme);
        expect(
          declared?.[1],
          `${name} is missing from brand.css or disagrees with brand.ts`,
        ).toBe(brand[family][step]);
      }
    });
  }
});

describe('semantic tokens', () => {
  // The point of the ramps is that the palette is drawn from them. A token
  // holding a hex that is not a ramp step is either a mistake or a sixth
  // colour family nobody declared; both should fail here rather than in a
  // design review six months later.
  const rampValues = new Set(
    brandFamilies.flatMap((family) =>
      brandSteps.map((step) => brand[family][step]),
    ),
  );

  // White is the light theme's page ground and the text on the primary button.
  // It is not a brand colour and deliberately has no ramp step.
  const allowedNonRampValues = new Set(['#ffffff']);

  for (const theme of themes) {
    it(`draws every ${theme} token from a brand ramp`, () => {
      for (const token of tokenNames) {
        const value = palettes[theme][token];
        expect(
          rampValues.has(value) || allowedNonRampValues.has(value),
          `${theme}.${token} is ${value}, which is not a step of any brand ramp`,
        ).toBe(true);
      }
    });
  }
});
