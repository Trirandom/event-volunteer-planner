// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The flat visual language's stylesheet (ADR-0047).
 *
 * There is no contrast to prove for a radius or an offset, so what is tested is
 * what actually goes wrong with custom properties: one that nothing declares.
 * CSS resolves `var(--evp-slab-m)` to nothing without a warning, and the slab
 * quietly disappears from whichever button had the typo.
 */

const flatCss = readFileSync(
  fileURLToPath(new URL('./styles/flat.css', import.meta.url)),
  'utf8',
);

/** The scales every flat component is built from. */
const scales = [
  '--evp-radius-sm',
  '--evp-radius-md',
  '--evp-radius-lg',
  '--evp-radius-xl',
  '--evp-radius-2xl',
  '--evp-edge',
  '--evp-slab-sm',
  '--evp-slab-md',
  '--evp-slab-lg',
  '--evp-slab-xl',
  '--evp-press',
  '--evp-duration',
  '--evp-slab',
];

/** The primitives ADR-0047 names, so a rename cannot drop one silently. */
const primitives = [
  '.evp-slab',
  '.evp-slab--sm',
  '.evp-slab--lg',
  '.evp-slab--xl',
  '.evp-slab--tint',
  '.evp-pressable',
  '.evp-card',
  '.evp-tile',
  '.evp-icon-tile',
  '.evp-notice',
  '.evp-pill',
];

describe('flat.css', () => {
  // The first `:root { … }` block, which must not be inside a media query:
  // like the palette, every scale has a value whatever the viewer's
  // preferences (docs/14 §6).
  const root = /^:root\s*\{([^}]*)\}/m.exec(flatCss)?.[1] ?? '';

  it('declares its scales on a bare :root', () => {
    for (const name of scales) {
      expect(root, `${name} is not declared on :root`).toMatch(
        new RegExp(`${name}:`),
      );
    }
  });

  it('defines every primitive the ADR names', () => {
    for (const selector of primitives) {
      expect(flatCss, `${selector} is missing`).toMatch(
        new RegExp(`${selector.replace('.', '\\.')}\\s*[{,:]`),
      );
    }
  });
});

describe('custom properties across the frontends', () => {
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const roots = ['packages/shared/src', 'apps/admin/src', 'apps/form/src'];

  const sources = roots.flatMap((root) =>
    readdirSync(join(repoRoot, root), { recursive: true, encoding: 'utf8' })
      .filter((path) => /\.(css|vue)$/.test(path))
      .map((path) => ({
        path: `${root}/${path.replaceAll('\\', '/')}`,
        text: readFileSync(join(repoRoot, root, path), 'utf8'),
      })),
  );

  // A declaration in a stylesheet (`--evp-x:`) or a key in a template's
  // `:style` binding (`'--evp-x':`), which is how a per-item colour reaches
  // its scoped rule.
  const declared = new Set(
    sources.flatMap(({ text }) =>
      [...text.matchAll(/(--evp-[a-z0-9-]+)['"]?\s*:/g)].map(
        (match) => match[1],
      ),
    ),
  );

  // `var(--evp-x)` with nothing after the name. One with a fallback,
  // `var(--evp-tile-hue, …)`, is an optional knob, complete when unset.
  it('uses no --evp- property that nothing declares', () => {
    const undeclared = sources.flatMap(({ path, text }) =>
      [...text.matchAll(/var\(\s*(--evp-[a-z0-9-]+)\s*\)/g)].flatMap(
        ([, name]) =>
          name === undefined || declared.has(name) ? [] : [`${path}: ${name}`],
      ),
    );
    expect(undeclared).toEqual([]);
  });
});
