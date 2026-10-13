# ADR-0015 — Strictness is enforced, not documented

**Status:** Accepted · **Date:** 2026-09-10

## Context

The design documentation specified *what* to build in some detail and said
almost nothing about *how* to write it. Style and quality standards were
scattered across a testing table and a few asides.

The obvious fix is a coding-standards document. The obvious fix does not work.
Written standards without mechanical enforcement decay in a predictable order:
they are read once at onboarding, contradicted under deadline, and then cited
selectively in review as a matter of taste. The end state is a document nobody
believes and a codebase that does not match it.

There is a second, opposite failure. A project that turns on every available
lint at `deny` produces a build that cannot be satisfied, and the response is
a blanket `#![allow]` at the crate root — after which the lints are worse than
absent, because they look present.

## Decision

**Every standard is either enforced by a tool or explicitly labelled
judgement.** No third category.

Concretely:

- Lint configuration lives in **one place per language** — `[workspace.lints]`
  in the root `Cargo.toml`, one shared ESLint config — inherited by every crate
  and package, so a new module cannot start out unchecked.
- **Warnings locally, `-D warnings` in CI.** A lint that blocks local iteration
  gets disabled by the developer; a lint that blocks the merge gets fixed.
- Lints are split by consequence, not by enthusiasm:
  - **`deny`** for constructs that cause a wrong answer or a panic in
    production: `unwrap_used`, `indexing_slicing`, `arithmetic_side_effects`,
    `as_conversions`, `no-explicit-any`, `no-non-null-assertion`.
  - **`warn`** for style and clarity: `clippy::pedantic`, stylistic ESLint
    rules. Visible, never blocking.
  - **`forbid`** for `unsafe_code` only — it cannot be re-allowed by an inner
    attribute, so introducing `unsafe` requires editing the manifest, visibly,
    in review.
- **Suppressions must justify themselves and expire.** `#[expect(lint, reason
  = "…")]` rather than `#[allow]`, so a suppression that is no longer needed
  becomes a warning. In TypeScript, `reportUnusedDisableDirectives: "error"`
  plus a required description on every `eslint-disable`.
- The standards document ends with an **enforcement table** mapping each
  standard to its gate and CI stage. Anything absent from that table is
  explicitly judgement and must not be argued as policy.
- Security controls follow the same rule, one step further: where an invariant
  can be made *structurally impossible* to violate — a database constraint, a
  newtype, an Axum extractor — it goes there rather than into a review
  checklist ([12](../12-security.md)).

Two lint choices are unusual enough to record, because both will feel
excessive and both are deliberate:

**`arithmetic_side_effects`** and **`as_conversions`** are denied. This
application does arithmetic on times and headcounts, where a silent wraparound
or truncating cast yields a schedule that is *wrong* rather than a program that
crashes — and wrong schedules are the failure this project exists to prevent.

**`noUncheckedIndexedAccess`** is on. The planner board indexes arrays of
shifts and time buckets constantly; without it an off-by-one type-checks and
throws at runtime.

## Alternatives considered

**A style guide, enforced by review.** Rejected on the decay argument above.
Review is the right place for architecture and naming, and the wrong place for
anything a machine can decide — it spends reviewer attention on formatting
instead of logic.

**Everything at `warn`, ratcheting to `deny` later.** Honest, and it never
happens. Warnings accumulate until the output is noise, at which point the
signal is gone and the ratchet cannot be turned.

**Maximum strictness everywhere, including `clippy::restriction`.** Rejected:
`restriction` is explicitly not meant to be enabled wholesale, and the result
is a crate-root `allow` that silently disables the useful lints alongside it.

**`unsafe_code = "deny"` rather than `"forbid"`.** Rejected for a two-word
reason: `deny` can be overridden locally by an `allow`, which is exactly the
change least likely to be noticed in a diff.

**Defer standards until there is code.** Rejected as the most expensive
option. Retrofitting `noUncheckedIndexedAccess` or `unwrap_used` onto an
existing codebase means hundreds of mechanical changes and a strong incentive
to suppress them instead; adopting them before the first line costs nothing.

## Consequences

- The standards document is short, because it can only contain things that are
  actually checked.
- Disagreements resolve by pointing at the enforcement table, or by changing
  it in a reviewed commit. Neither is a debate about taste.
- Lints are chosen before the first line of code exists, so there is no
  retrofit cost and no legacy exemption.
- CI grows several jobs, and the pipeline is slower. Accepted.
- Some denied lints will be genuinely wrong in specific places. That is what
  `#[expect(..., reason = "...")]` is for, and the reason string is the point:
  it turns a suppression into a documented, reviewable decision that stops
  compiling once it is obsolete.
- Contributors meet friction earlier — a first patch may fail on lints before
  it fails on logic. Mitigated by the pre-commit hook and by `just check`
  running exactly what CI runs, so failures are local and fast rather than
  discovered in the pipeline.
