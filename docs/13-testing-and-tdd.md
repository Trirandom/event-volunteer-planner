# 13 — Testing and TDD

The single home for testing *discipline*. Where tests run and with what tooling
is [06 §4](06-local-development.md#4-testing-strategy); code standards are
[11](11-engineering-standards.md).

## 1. What can and cannot be enforced

Test-driven development is an *ordering* of work: failing test, then code. Git
records neither order nor intent — tests written afterwards and committed first
are indistinguishable from tests written first. **No automated check can verify
that you practised TDD.**

Pretending otherwise would violate the rule in
[ADR-0015](adr/0015-strictness-is-enforced-not-documented.md): a standard with
no gate is a suggestion. So this document separates the two honestly.

| | |
| --- | --- |
| **Gated** | A behaviour change ships with a test. Tests actually detect injected bugs (mutation testing). Coverage never decreases. No flaky retries. Determinism. |
| **Reviewable, not gated** | Test-first ordering, and the red-green evidence in the pull request. |
| **Judgement** | How finely to slice a red-green cycle. |

The gates measure whether tests are **effective**, not whether they exist —
because a test suite that passes with the implementation deleted is worse than
no suite, and coverage percentages cannot tell the difference.

## 2. Where test-first is mandatory

These share one property: **the correct answer is knowable before the code
exists**, and getting it wrong is expensive or invisible.

| Area | Why test-first works here |
| --- | --- |
| **The constraint engine** (`evp-domain`) | `evaluate(ctx) -> Vec<Violation>` is a pure function and every rule in [05](05-scheduling-rules.md) is already a specification sentence. The test *is* the rule. No database, no clock, no I/O. |
| **Hard database constraints** | Genuinely red-green: write the test that attempts a double-booking and asserts SQLSTATE `23P01`; it fails because no constraint exists; add the migration; it passes. The test is the invariant's specification. |
| **Authorisation** | The route × role matrix is enumerable up front. Write the whole table failing, then implement. A route added later with no extractor fails the suite. |
| **Intake mapping and reconciliation** | Pure functions over stored raw payloads. Every case in [08 §11](08-volunteer-intake.md#11-failure-catalogue) is a test that can be written from the table. |
| **Retention and erasure** | The sweep is specifiable before it exists — the tiers are declared in the schema and the property is "zero rows" ([15 §9](15-privacy-and-retention.md#9-enforcement)). Its failure mode is silence, so a test written afterwards is a test written against whatever the sweep happens to do. |
| **Operation inverses** | For each mutating endpoint the inverse is knowable up front: apply, undo, assert the world is as it was ([ADR-0024](adr/0024-server-side-undo-and-per-item-bulk.md)). |
| **Time, timezone and DST logic** | Correctness is not eyeballable. A duplicated event crossing a DST boundary either keeps local wall-clock times or it does not, and only a test says which. |
| **Any bug fix** | See §4. Non-negotiable. |

For these, a pull request whose implementation predates its tests will be sent
back — not on principle, but because writing the test afterwards reliably
produces a test that asserts what the code *does* rather than what it *should*.

## 3. Where test-first is explicitly not required

Stating this matters as much as §2. Blanket TDD advocacy produces
box-ticking tests for designs that get thrown away, and it teaches people that
the discipline is theatre.

| Area | Instead |
| --- | --- |
| **The planner board's drag geometry** | Exploratory: you cannot specify an interaction you have not felt. Prototype first, then *characterise* the settled behaviour with tests. The pure part — the time↔pixel scale — **is** test-first, because it is arithmetic. |
| **The availability picker's layout** | Same. Its range-merging logic is pure and test-first; its feel is not. |
| **Visual design, spacing, colour** | Not meaningfully unit-testable. Reviewed by looking. |
| **Spikes against a real provider or sheet** | You are discovering an undocumented contract. Write tests once you know it, then keep them as the record of what you learned. |
| **Legacy data migration** | You discover the mess by looking at it. The tests come from the mess. |

The line is: **test-first where the specification precedes the code; test-after
where the code discovers the specification.**

## 4. Bug fixes: regression test first, always

The one unconditional rule, and the easiest to review.

A bug-fix pull request must contain a test that **fails on `main` and passes
with the fix**. Write it before touching the implementation, for three reasons
that all bite in practice:

1. It proves you have actually reproduced the bug, rather than fixed something
   adjacent that made the symptom disappear.
2. It proves the fix addresses *that* bug.
3. It stops the bug returning, which is the only thing that stops a codebase
   accumulating the same defect three times.

The pull request shows the failing output. If a test cannot be written — a
visual glitch, say — it says so explicitly and why.

## 5. A red-green cycle, concretely

Adding the `insufficient_rest` soft rule from
[05 §3](05-scheduling-rules.md#3-soft-rules). This is what the loop looks like
in this codebase, so that "do TDD" is not an abstraction.

**Red** — write the rule as an assertion, from the specification:

```rust
#[test]
fn warns_when_gap_since_previous_shift_is_below_the_event_minimum() {
    let event = EventBuilder::new().min_rest_minutes(480).build();       // 8h
    let previous = AssignmentBuilder::new()
        .period("2026-07-04T18:00+02".."2026-07-05T02:00+02")
        .build();
    let ctx = EvaluationContext::builder()
        .event(&event)
        .shift_period("2026-07-05T06:00+02".."2026-07-05T10:00+02")      // 4h gap
        .existing_assignments(&[previous])
        .build();

    let violations = evaluate(&ctx);

    assert_violation(&violations, RuleCode::InsufficientRest, Severity::Warn);
}
```

It fails to compile — `RuleCode::InsufficientRest` does not exist. That is a
legitimate red.

**Green** — the smallest change that passes. **Refactor** — with the test
holding. Then the two tests that matter as much as the first:

```rust
#[test] fn allows_gap_exactly_equal_to_the_minimum() { … }   // boundary
#[test] fn ignores_cancelled_assignments_when_computing_rest() { … }
```

The boundary case is the one that stops a later "simplification" from flipping
`>=` to `>`. Every rule gets passing, failing and boundary
([11 §5](11-engineering-standards.md#5-testing)).

## 6. Do not mock the database

The most important project-specific rule here.

**The invariants live in PostgreSQL.** Double-booking is prevented by an
exclusion constraint; tenant isolation by row-level security; cross-tenant
references by composite foreign keys. A mocked repository cannot enforce any of
them, so a suite built on mocks would pass while the real system was broken —
it would be testing a fiction that behaves the way we hoped.

So: repository and integration tests run against **real PostgreSQL** — the
Compose database — each inside one transaction, opened as `evp_migrator` and
never committed, so dropping it rolls everything back. Not `sqlx::test`: that
creates a database per test and needs `CREATEDB`, which neither role has on
purpose, and `FORCE ROW LEVEL SECURITY` keeps the owner bound by the same
policies `evp_api` is (`crates/evp-db/tests/catalog.rs` has the full
reasoning). That is fast enough to run on every save.

Mock only at genuine external boundaries, and prefer a real implementation even
there:

| Boundary | In tests |
| --- | --- |
| PostgreSQL | **Real**, always |
| Clock | Injected `Clock` — the one thing always faked |
| SMTP | Mailpit locally; an in-memory sink in unit tests |
| SMS provider | An `SmsSender` fake that records messages |
| OIDC provider | **Dex**, a real OIDC server, not a mock — mocking an auth protocol is how you test your misunderstanding of it |
| Google Sheets / webhooks | Recorded real payloads replayed as fixtures |
| PDF renderer | Asserted on structure, not on bytes |

## 7. What makes a test good here

- **Named for the behaviour**, not the function:
  `refuses_overlapping_assignment_for_same_volunteer`, not `test_assign_2`. The
  name is what you read when it fails at 2 a.m. during an event.
- **Arrange / act / assert**, visibly separated. One `act` per test.
- **One behaviour per test.** Several assertions about one behaviour is fine;
  several behaviours in one test means you cannot tell what broke.
- **Builders, not shared fixtures.** `VolunteerBuilder::new().with_skill(FIRST_AID)`
  states only what the test cares about. A shared fixture couples every test to
  every other, and the first person who needs a slightly different volunteer
  edits it for everyone.
- **No logic in tests** — no loops with conditionals, no helpers that compute
  the expected value the same way the implementation does. A test that reimplements
  the code tests nothing.
- **Failure messages carry the context.** Assert with a message naming the
  volunteer and the period, not `assert!(result.is_err())`.
- **Table-driven for enumerable domains** — the route × role matrix, value
  mappings, the failure catalogues in [08 §11](08-volunteer-intake.md#11-failure-catalogue)
  and [09 §9](09-volunteer-form.md#9-what-can-go-wrong). Those tables were
  written to be transcribed into tests.

## 8. Determinism, and the flaky-test policy

A test may not depend on:

- **the wall clock** — inject `Clock`; otherwise it fails on a DST Sunday six
  months from now with no explanation;
- **unseeded randomness** — seed it and print the seed on failure;
- **the network**;
- **`sleep`** — wait on a condition, with a timeout;
- **execution order**, or on another test's data — the suite runs in parallel;
- **the machine's timezone or locale** — a test that cares about a zone or a
  locale names it explicitly, in the test. The harness deliberately does **not**
  pin the process `TZ`, because the whole suite is re-run under
  `TZ=Pacific/Chatham` to prove the server's timezone is irrelevant
  ([16 §7](16-i18n-and-time.md#7-enforcement)) — pinning it in the harness would
  make that job prove nothing.

**A flaky test is fixed or deleted within one working day.** It is never
retried, and there is no retry annotation available. A suite people do not
believe is worse than a smaller suite they do, because the first red build that
gets re-run "because it's flaky" is the one that was telling the truth.

## 9. Mutation testing: the efficacy gate

This is the honest replacement for a coverage target. Coverage says a line was
*executed*; mutation testing says a bug in that line would have been *caught*.

`cargo-mutants` introduces small changes — flip a comparison, return
`Default::default()`, delete a statement — and reports which ones no test
detected. A surviving mutant is a specific, actionable gap.

Scoped deliberately, because it is slow:

| Target | Requirement |
| --- | --- |
| `evp-domain` — the constraint engine | **No surviving mutants.** Pure, fast, and the place where a wrong answer is a wrong schedule |
| `evp-intake` — mapping and reconciliation | No surviving mutants |
| Authorisation extractors | No surviving mutants |
| Everything else | Run nightly, reported, not blocking |

Stryker does the same for the frontend's pure composables — the time↔pixel
scale and the availability-merge logic — and is not run over components.

## 10. Coverage: a ratchet, not a target

Coverage percentage is a bad goal and a useful trend.

- **It may not decrease.** `cargo-llvm-cov`, compared against the base
  branch (planned; the frontend's `pnpm test:coverage` reports but does not
  ratchet). A pull request that lowers it explains why.
- **Full branch coverage is required for two things only**: the constraint
  engine and the authorisation extractors. Their failure modes are a wrong
  schedule and a data leak.
- **No global percentage target.** Chasing one produces tests for trivial
  getters and leaves the hard branches alone, which is precisely inverted.

## 11. Property-based testing where it pays

For a few pieces, examples are weaker than properties. `proptest` for these:

- **Availability-window merging** is idempotent and order-independent: merging
  a set of ranges twice equals merging it once, and shuffling the input does not
  change the output. This is the logic behind
  [09 §3](09-volunteer-form.md#3-the-availability-picker), and hand-written
  examples will miss the interesting overlaps.
- **Range arithmetic**: for any two shifts, `overlaps(a, b) == overlaps(b, a)`,
  and touching-but-not-overlapping is never an overlap.
- **The engine never contradicts the database**: for any generated assignment
  set the engine accepts as free of `double_booked`, inserting it must not raise
  `23P01`. This one pins the engine and the constraint to each other, which is
  the seam most likely to drift.
- **Schedule rendering round-trips**: contiguous-slot merging never loses or
  invents an hour.

Everything else uses examples. Property tests on business rules with many
special cases produce generators more complicated than the code.

## 12. Enforcement

Status as in [11 §7](11-engineering-standards.md#7-enforcement-summary):
enforced, partial, or planned.

| Rule | Gate | Stage | Status |
| --- | --- | --- | --- |
| Behaviour change ships with a test | Review, plus a warning when `src/**` changes with no test change | check | review only; warning planned |
| Bug fix includes a failing-first regression test | Review — the pull request shows the output | review | review |
| Tests are effective | `cargo-mutants` on domain/intake/authz, zero survivors (`just mutants`) | test | partial — domain and intake, not the authz extractors |
| Coverage does not decrease | `cargo-llvm-cov` against the base branch | test | planned |
| Full branch coverage: engine + authz | `cargo-llvm-cov` thresholds, scoped | test | planned |
| Every hard constraint has a violation-attempt test | Review, and the isolation/constraint suites (`just test`) | test | enforced |
| Route × role matrix complete | Table-driven suite fails on an unlisted route | test | partial — festivals and events, and an unlisted route does not fail it |
| No flaky retries | No retry mechanism exists in the harness (`retry: 0` in Vitest and Playwright) | — | enforced |
| Determinism | Suite runs in parallel; no `TZ` is pinned, so a test that cares names its zone ([16 §7](16-i18n-and-time.md#7-enforcement)) | test | enforced |
| Frontend pure logic | Stryker on composables (`pnpm mutants`) | test | enforced, run by hand |
| The retention sweep does what it claims | Tier registry completeness, event-tier emptiness, accountability survival, both age clocks ([15 §9](15-privacy-and-retention.md#9-enforcement)) | test | planned — no sweep yet |
| Every mutating endpoint can be undone | Inverse round-trip per endpoint; refusal after publication and after a conflicting operation ([ADR-0024](adr/0024-server-side-undo-and-per-item-bulk.md)) | test | planned — inverses are recorded, undo is not built |

Test-first ordering is **not** in this table, and cannot be. It is reviewed,
argued for on its merits in §2, and left to judgement in the areas of §3.
