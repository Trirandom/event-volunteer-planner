# ADR-0017 — WCAG 2.2 AA, and every drag has a keyboard equivalent

**Status:** Accepted · **Date:** 2026-09-10
**Amended by:** [ADR-0024](0024-server-side-undo-and-per-item-bulk.md) — the
server-side undo and the operation id required in *Consequences* below are
specified there, together with the per-item bulk semantics they imply.

## Context

Accessibility had been mentioned repeatedly across the design — a roving
tabindex on the planner board, numeric time entry in the availability picker,
no colour-only meaning — as good practice, with no target, no gate, and no
statement of what conformance means. Under
[ADR-0015](0015-strictness-is-enforced-not-documented.md) that makes it a
suggestion.

The application also has an unusual property: its densest surface is a
drag-and-drop grid, and its most important input is a drag-based range picker.
Those are the two interaction patterns most likely to exclude people, and they
are both central rather than incidental.

Separately, a coordinator needs to make **mass modifications** efficiently. A
spreadsheet is very good at that; a web application requiring one mouse click
per assignment is not a replacement, whatever else it gets right.

## Decision

**Target WCAG 2.2 level AA**, with RGAA 4 as the French compliance frame since
that is the reference an association here would be measured against.

Three consequences are called out because they constrain design rather than
just styling:

- **2.5.7 Dragging Movements (AA): every drag has a non-drag alternative.** The
  board's drag-to-assign and the picker's drag track each require a keyboard
  path *and* a pointer-click path. This was already the intent; it is now a
  conformance requirement, not a preference to be traded away under deadline.
- **2.1.4 Character Key Shortcuts (A)**: single-character shortcuts are
  **scoped to a focused component**, which satisfies the criterion without
  building a remapping system.
- **3.3.8 Accessible Authentication (AA)**: no cognitive function test in the
  login path — already satisfied by magic links and OIDC.

**Accessibility and keyboard efficiency are treated as one programme.** The
keyboard layer that 2.5.7 requires *is* the power-user layer: selection model,
bulk operations, type-ahead assignment, command palette, undo. Building them
separately would produce two half-implementations.

One further requirement follows, and it is a backend one:
**bulk operations must be individually reversible.** Nobody bulk-edits a roster
without undo, so every mutating operation records a server-side inverse and
`Ctrl+Z` is a compensating transaction, not a client-side rewind.

Gates: `@axe-core/playwright` with zero violations on every route, a
**keyboard-only end-to-end journey** through plan-and-publish, forced-colors and
reflow assertions, and a **manual screen-reader pass as a release gate** for any
change to the board or the form.

## Alternatives considered

**Aim at AA "where practical", no gate.** Rejected — the standard formulation
of a standard nobody meets. "Where practical" is decided under deadline, and
the board is exactly where it would be found impractical.

**Target AAA.** Rejected as not credible for a single-maintainer project. AAA
includes criteria (sign language for media, 7:1 contrast throughout) that are
disproportionate here. Two AAA criteria are adopted individually — 44 px touch
targets on touch-first surfaces, and context-sensitive help on the form — where
they are cheap and clearly valuable.

**Build the board with drag-and-drop first, add keyboard access later.**
Rejected. Retrofitting keyboard interaction onto a pointer-geometry component
means rewriting its interaction model, and it never gets prioritised. The
keyboard path is also the one that gets *tested* automatically, so building it
first makes the drag path the enhancement.

**Use a third-party scheduler component for accessibility.** Rejected in
[ADR-0004](0004-vue3-spa-frontend.md) on layout grounds, and it would not have
helped: general scheduler libraries handle keyboard interaction poorly, and
their accessibility is not auditable from outside.

## Consequences

- The board is an ARIA grid with a documented key map, usable without a mouse
  — which is also the fastest way to use it.
- Mass modification gets a real design (selection, bulk ops, type-ahead, undo)
  instead of being an emergent property of clicking faster.
- Bulk endpoints must return an operation id and record an inverse. That is
  real backend work that would not otherwise have been scoped.
- CI grows accessibility jobs, and the keyboard-only journey test is slow.
- Automated tooling catches perhaps a third of real issues, so a manual pass
  stays in the release path. That is a recurring human cost, accepted, and the
  alternative is believing axe when it says nothing is wrong.
- Some visual ideas will be rejected for being unreachable by keyboard. That is
  the trade being made deliberately.
