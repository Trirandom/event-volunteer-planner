# ADR-0047 — The interface is flat, and its rules live in one shared stylesheet

**Status:** Accepted · **Date:** 2026-11-15

## Context

The landing page, the sign-in card and the header were redrawn flat: solid
matte fills, no gradients, and depth shown by a solid offset "slab" with no
blur, pressed into on click. The first pass wrote each rule where it was used —
six slab offsets, five corner radii and three slab colours as literals across
four components. That is how a visual language drifts: the next screen copies
whichever page its author opened last, and the two stop agreeing within a
month.

The palette already has one home (`packages/shared/src/tokens.ts`, restated in
`tokens.css` and proved by `tokens.test.ts`, docs/14 §7). Shape, depth and
motion had none.

## Decision

1. **The visual language is flat.** Surfaces are one matte colour. Depth is a
   solid slab offset down and right with zero blur, never a soft shadow and
   never a gradient. A control that should be pressed (the one call to action
   on a screen) sinks into its slab along the slab's diagonal while the pointer
   is down. Nothing else moves.
2. **Its rules live in `packages/shared/src/styles/flat.css`**, imported by
   both applications after `tokens.css`:
   - variables for the scales: corner radius (`--evp-radius-sm` … `-2xl`), the
     flat edge (`--evp-edge`), slab offsets (`--evp-slab-sm` … `-xl`), press
     travel (`--evp-press`) and transition duration (`--evp-duration`);
   - the slab colours, derived from the semantic tokens with `color-mix` so
     they follow the theme with no second declaration;
   - primitive classes that compose: `.evp-slab` (+ size and `--tint`
     modifiers), `.evp-pressable`, `.evp-card`, `.evp-tile`, `.evp-icon-tile`,
     `.evp-notice`, `.evp-pill`.
3. **Components use those, not literals.** A component's scoped style may still
   lay itself out, but a radius, a slab or a press is a variable or a class
   from `flat.css`.
4. **Every flat block keeps a transparent border** (`--evp-edge`). Under
   forced-colors the backgrounds and the slab are dropped, and that border is
   what is left of the block's edge (docs/14 §2).
5. **Text only sits on pairs the contrast test proved.** The `color-mix`
   derivatives are fills, slabs and tints under body text near the surface
   colour. They are never a new foreground/background pair.

## Alternatives considered

- **Soft elevation shadows (Material-style blur).** Rejected: a blurred
  shadow needs a different strength per theme to read at all on a near-black
  ground, which is a second palette to keep conformant. A solid slab derived
  from the accent is darker than what it sits under in both themes by
  construction.
- **Tailwind utilities in the templates.** Rejected for these rules: a slab is
  four declarations plus a pressed state, and spelling them per element is the
  drift this ADR exists to stop. Tailwind stays available for layout.
- **Putting the scales in `tokens.ts` with the palette.** Rejected: the palette
  is in TypeScript so its contrast can be a unit test. Radii and offsets have no
  such property to prove, and a TypeScript restatement would be ceremony
  without a test behind it. `flat.css` is tested instead for what can go wrong
  with it, a `var(--evp-…)` that names nothing.

## Consequences

- New screens get the language by composing classes. A change of radius or
  slab depth is one line.
- `.evp-panel`, `.evp-field` and the default `.evp-button` across the rest of
  the coordinator application still have the earlier bordered look. Moving them
  onto these primitives is follow-up work, screen by screen.
- A typo in a custom property name (`var(--evp-slab-md)` against a
  declared `--evp-slab-m`) silently resolves to nothing in CSS. A test scans
  both applications and the shared package and fails on any `var(--evp-…)`
  that nothing declares.
