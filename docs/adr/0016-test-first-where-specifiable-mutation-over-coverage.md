# ADR-0016 — Test-first where the specification precedes the code; mutation testing over coverage targets

**Status:** Accepted · **Date:** 2026-09-10

## Context

Test-driven development was requested as the project's strategy. Adopting it
wholesale runs into two problems that are worth stating before the practice is
written down.

**TDD is an ordering of work, and orderings are not verifiable.** Git records
neither the sequence in which files were written nor the author's intent. Tests
written after the implementation and committed first are indistinguishable from
tests written first. No CI job can establish that TDD was practised. A document
mandating it, with no gate, is exactly the kind of standard
[ADR-0015](0015-strictness-is-enforced-not-documented.md) rejected — read once,
contradicted under deadline, cited selectively in review.

**Blanket TDD is wrong for part of this codebase.** The constraint engine is a
pure function whose rules are already written as specification sentences: TDD
there is nearly free and clearly correct. The planner board's drag interaction
and the availability picker's feel are the opposite — you cannot specify an
interaction you have not felt, so test-first produces tests for a design that
gets discarded, and teaches contributors that the discipline is theatre.

Meanwhile the usual proxy for "we test properly" is a coverage percentage,
which measures whether a line *executed*, not whether a bug in it would be
*caught*. A suite can hold 90% coverage and still pass with the implementation
deleted.

## Decision

**Enforce the outcome, not the ordering.** Three parts.

**1. Test-first is mandatory where the specification precedes the code**, and
explicitly not required where the code discovers the specification. The
dividing line, with both lists enumerated in
[13](../13-testing-and-tdd.md#2-where-test-first-is-mandatory):

- *Mandatory*: the constraint engine, hard database constraints, the
  authorisation matrix, intake mapping and reconciliation, time/DST logic, and
  every bug fix.
- *Not required*: drag geometry, picker feel, visual design, provider spikes,
  legacy data migration — though the **pure** parts of those (a time↔pixel
  scale, a range merge) are arithmetic and therefore mandatory.

**2. A regression test that fails first is unconditional for bug fixes.** This
is the one test-first rule that is cheap to review: the merge request shows the
test failing on `main` and passing with the fix. It proves the bug was
reproduced rather than a symptom made to disappear.

**3. Mutation testing replaces coverage as the efficacy gate.**
`cargo-mutants` must find **no surviving mutants** in `evp-domain`,
`evp-intake` and the authorisation extractors — pure, fast to mutate, and the
places where an undetected bug means a wrong schedule or a data leak. The rest
of the workspace is mutated nightly and reported, not blocked. Coverage is kept
as a **ratchet** (it may not decrease) rather than a target, with full branch
coverage required only for the engine and the extractors.

A supporting decision that follows from where the invariants live: **the
database is never mocked.** Double-booking, tenant isolation and cross-tenant
integrity are enforced by PostgreSQL, so a mocked repository would let the
suite pass while the system was broken. Integration tests use real PostgreSQL
via `sqlx::test`. The clock is the one thing always faked; even the OIDC
provider is real (Dex) in tests, because mocking an auth protocol tests one's
misunderstanding of it.

## Alternatives considered

**Mandate TDD everywhere, enforce by review.** Rejected: unenforceable, and
wrong for the exploratory UI work. It would also make the standard easy to
dismiss wholesale the first time it was obviously inapplicable.

**A coverage threshold** (80%, 90%). Rejected: it measures execution, not
detection; it is trivially satisfied by tests that assert nothing; and chasing
a number produces tests for trivial accessors while the hard branches stay
uncovered. Kept only as a non-decreasing ratchet, where the trend is
informative.

**Require a test file change whenever `src/**` changes**, as a hard gate.
Rejected as a hard gate, kept as a CI *warning*: it is trivially gamed by
touching a test, and it produces false failures for refactors, renames and
comment changes. As a warning it prompts the right question in review without
blocking honest work.

**Mutation testing across the whole workspace, blocking.** Rejected on runtime.
Mutating the Axum layer and the SQL repositories is slow and yields mutants
that are mostly equivalent or uninteresting. Scoping it to the pure crates is
where nearly all the value is.

**Property-based testing as the primary technique.** Rejected as primary, and
adopted for four specific places where examples are genuinely weaker: range
overlap symmetry, availability-merge idempotence, schedule-rendering
round-trips, and an engine-versus-database agreement property. Applied more
broadly it produces generators more complex than the code under test.

**Allow retrying flaky tests.** Rejected, and no retry mechanism is provided.
The first red build re-run "because it's flaky" is the one that was telling the
truth, and a suite nobody believes is worse than a smaller one they do.

## Consequences

- The rules that carry this product's value — the constraint engine and the
  authorisation layer — are specified by tests before they exist, and proven
  effective by mutation rather than asserted by percentage.
- Contributors get a clear, defensible answer to "must I write the test first?"
  that is *yes* or *no* per area, not a slogan.
- Exploratory UI work is not slowed by tests for designs that will change.
- Costs: mutation runs are slower than the unit suite, so they sit in the test
  stage rather than in `just check`. Zero surviving mutants is a demanding bar
  in the two target crates and will occasionally require a test that feels
  pedantic — which is the point, since the alternative is a mutant that
  represents a real undetected bug.
- The database being real in tests means the suite needs PostgreSQL to run.
  Accepted: it is already in Compose, `sqlx::test` isolates per test, and the
  alternative is a suite that tests a fiction.
- Test-first ordering remains unenforceable, and the documentation says so
  plainly rather than implying a rigour that does not exist.
