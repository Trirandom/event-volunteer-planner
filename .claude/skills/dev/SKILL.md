---
name: dev
description: How to develop in event-volunteer-planner — a branch per change, test-first red-green cycles, micro commits, the local gates, when to write an ADR, and which docs to update alongside the code. Use when starting any feature, bug fix, refactor, migration or dependency change in this repo, before writing the first line of code, and again before committing or opening a PR.
---

# Developing in event-volunteer-planner

This skill is the working loop. The rules themselves live in the docs, which
win on any disagreement: `CLAUDE.md`, `CONTRIBUTING.md`, `docs/11`
(engineering standards), `docs/13` (testing and TDD), `docs/12 §9` (security
review), `docs/adr/0001` (ADRs). Read the doc an area cites before changing
it; most "why is it like this?" questions, and the rejected alternatives, are
already written down.

The loop, in order:

1. **Branch** off an up-to-date `main`.
2. **Read** the governing doc and ADRs. Decide whether the change needs an ADR.
3. **Red → green → refactor** in small cycles. Commit each green step.
4. **Docs** move in the same branch as the code.
5. **Gate** with `just check` and `just test`, then open a PR.

## 1. One branch per change

Never commit to `main`. Every feature, fix, doc change or dependency bump gets
its own branch, cut from a fresh `main`:

```
git switch main && git pull --ff-only
git switch -c feature/<short-slug>      # new behaviour
git switch -c fix/<short-slug>          # bug fix (regression test first, §3)
git switch -c docs/<short-slug>         # docs or ADR only
git switch -c chore/<short-slug>        # deps, CI, tooling
```

- One concern per branch. If a second concern turns up halfway through (a
  refactor, an unrelated bug), note it and finish the current branch first, or
  stash and open another branch. Don't mix them.
- If you're already on a branch that isn't for this task, stop and ask before
  piling unrelated work onto it.
- Keep branches short-lived. Rebase onto `main` (`git rebase main`) rather
  than merging `main` in, so history stays linear and bisectable.
- Merging happens through a GitHub PR (`gh pr create`), never by pushing to
  `main`. CI runs on every push, so pushing a branch is cheap feedback.

## 2. Before writing code: read, then decide on an ADR

1. Find the doc that owns the area (`docs/README.md` has the map) and every
   ADR it cites. Check `docs/07-roadmap.md` and the "Implementation state" in
   `CLAUDE.md` to see what's actually built and what's still only specified.
2. Check whether the change contradicts or extends a recorded decision. If it
   does, it needs an ADR (§5) **before** the code, written in the same branch.
3. If it touches `org_id`, an auth extractor, a token, a session, or `SET`
   vs `SET LOCAL`, it's security-relevant. Go through `docs/12 §9` and plan the
   justification you'll write in the PR.

## 3. TDD: red, green, refactor

Test-first is **mandatory** where the spec comes before the code
(`docs/13 §2`):

- the constraint engine (`evp-domain`): every rule gets passing, failing and
  **boundary** tests
- hard DB constraints: a test that *attempts the violation* and asserts the
  SQLSTATE (`23P01`, `23505`, `23503`) before the migration exists
- authorisation: write the route × role rows failing first
- intake mapping and reconciliation (`evp-intake`, `evp_db::intake`)
- retention and erasure, operation inverses (apply, undo, assert unchanged)
- anything touching time, timezones or DST
- **every bug fix**: a regression test that fails on `main`, written before
  touching the implementation. Keep the failing output for the PR. This rule
  is unconditional.

Test-first is **not** required where the code discovers the spec
(`docs/13 §3`): drag geometry, layout and feel, visual design, spikes against a
real provider, legacy-data exploration. Prototype, then characterise the
settled behaviour with tests. The pure parts inside them (time↔pixel scale,
range merging) are still test-first.

### The cycle

1. **Red.** Write one test for one behaviour, named for the behaviour
   (`refuses_overlapping_assignment_for_same_volunteer`, not `test_assign_2`).
   Run it and **watch it fail for the right reason**. A compile error on the
   missing type counts as red; a test that passes immediately means it isn't
   testing the new behaviour.
2. **Green.** Write the smallest change that passes. Re-run that test.
3. **Refactor** while the test holds. Run the crate's or package's tests.
4. **Commit** (§4). Then the next case: boundary, cancelled or ignored inputs,
   the other side of the rule.

Run single tests fast:

```
docker compose run --rm --entrypoint cargo api nextest run -p <crate> <filter>
pnpm vitest run <path>            # or: pnpm vitest run -t "<name>"
pnpm exec playwright test <spec>  # needs `just up`
```

### What a test here looks like

- **Never mock the database.** Repo and integration tests run against the
  Compose Postgres, inside one rolled-back transaction as `evp_migrator` (see
  `crates/evp-db/tests/catalog.rs`). Fake only real external boundaries:
  `Clock` (always), `SmsSender`, the in-memory mail sink. OIDC uses Dex.
- **No wall clock, no unseeded randomness, no network, no `sleep`, no order
  dependence, no reliance on the host `TZ`.** A test that cares about a zone
  names it. The suite also runs under `TZ=Pacific/Chatham` (`just test-tz`).
- **No retries.** A flaky test gets fixed or deleted.
- Arrange / act / assert, one act per test. Use builders, not shared fixtures.
  No logic that recomputes the expected value. Failure messages carry context.
- Table-driven tests for enumerable domains (role matrices, the failure
  catalogues in `docs/08 §11` and `docs/09 §9`).
- For `evp-domain` / `evp-intake` work, finish with `just mutants` (or
  `cargo mutants` scoped to the module). Zero surviving mutants is the bar.
  Frontend pure composables: `pnpm mutants`.

## 4. Micro commits

Each commit is **one small, coherent, green step**: a test plus the code that
makes it pass, a refactor, a migration, a doc update. Think of a single red →
green → refactor cycle per commit, not a day's work.

- **Every commit builds and passes the tests it touches.** Don't commit a red
  test on its own: CI runs on every push and `git bisect` needs every commit
  green. The red step's evidence goes in the commit body or the PR.
- Separate mechanical changes (renames, moves, formatting) from behaviour
  changes, so each diff can be reviewed on its own.
- A migration goes in its own commit, one concern per migration.
- Doc updates go in the commit whose behaviour they describe, or straight
  after it. They don't get batched for the end.
- Stage deliberately (`git add <paths>`, or `git add -p` reviewed by eye).
  Never use `git add -A` blindly: `.env`, `target/`, `node_modules/` and
  `docs/googleSheets/example_data/` must never land in a commit.

Message format, matching the history:

```
<Imperative subject, ≤ ~65 chars, no trailing period>

Why, not what. The diff shows what changed. The body records why the obvious
approach was wrong here, what was rejected, doc sections it implements or
corrects, and any evidence (mutants: N, 0 missed; the red output for a fix).

Signed-off-by: …            ← always: git commit -s (DCO, CONTRIBUTING.md)
```

Commits made by Claude also end with the Co-Authored-By trailer from the
session's attribution instructions. Only commit when the user has asked for
commits on this task.

## 5. Architecture decisions (ADRs)

Write an ADR when a decision is **hard to reverse, affects more than one
component, or has a plausible alternative someone will later ask about**
(ADR-0001). Typical triggers: a new table or a change to an entity's meaning,
a new dependency with alternatives, a change to auth, tenancy, retention or
time handling, or relaxing a non-negotiable.

- **Accepted ADRs are immutable.** To change one, write a new ADR that
  **supersedes** or **amends** it. The only edit allowed on the old file is
  its status line (`**Status:** **Superseded by [ADR-NNNN](…)**`) and, if
  useful, a short blockquote pointing at the successor (see 0011 and 0033).
- File: `docs/adr/NNNN-kebab-case-decision.md`, with the next free number.
  Shape (copy from a recent one such as 0044):

  ```
  # ADR-NNNN — <the decision, stated as a sentence>

  **Status:** Accepted · **Date:** YYYY-MM-DD
  **Supersedes:** / **Amends:** [ADR-XXXX](…), docs/NN §x   (if any)

  ## Context
  ## Decision
  ## Alternatives considered     ← each one with why it was rejected
  ## Consequences
  ```

- Add the row to `docs/adr/README.md`, and update the Status column of every
  ADR it amends or supersedes (`Accepted (amended by NNNN)`).
- Cite the ADR from the numbered doc it affects, and from code comments where
  the non-obvious choice is made.
- The ADR goes in its own commit, before the code that implements it.
- If code already diverged from an ADR, record the decision the code made in
  a new ADR (that's how 0044 came about). Don't leave the old one quietly
  wrong.

## 6. Documentation maintenance

The docs are the authority on intended behaviour, so they have to stay true.
A branch isn't done while any of these is stale:

| You changed… | Update |
| --- | --- |
| What's built (a feature lands, or a stub becomes real) | `CLAUDE.md` "Implementation state", the milestone **Status** line in `docs/07-roadmap.md`, the README status |
| Behaviour a numbered doc specifies | That doc (`docs/01`–`17`). If the change contradicts a decision, write an ADR first (§5) |
| A hard rule / DB constraint | `docs/02 §5` **and** `docs/05 §2`, kept identical |
| Schema or an entity | `docs/03`. New tenant table: RLS `ENABLE`+`FORCE`, a policy with `USING`+`WITH CHECK`, composite FKs with `org_id`, and a `retention_scope` row, all in the same migration |
| An API route or payload | `docs/04` |
| A dependency, or a feature flag on one | `docs/17` register + root `Cargo.toml` comment; `deny.toml` if a licence exception is needed |
| A gate (lint, check, CI job) moved from planned to enforced | The enforcement table that owns it (`11 §7`, `13 §12`, `14 §7`, `15 §9`, `16 §7`) and `docs/06 §5` |
| An env var or Compose knob | `docs/06 §2` table and `.env.example` |
| A `just` recipe | The Commands block in `CLAUDE.md` |
| UI text | `apps/<app>/src/i18n/{fr,en}/<area>.ts` only, never inline in a template |

When you find a doc that was already wrong, fix it in the same branch and say
so in the commit body (e.g. "docs/17 §7 said lettre had no native-roots path;
it has one").

## 7. Non-negotiables to keep in view while coding

These are summarised in `CLAUDE.md`, and the details are in the docs above.

- SPDX header `// SPDX-License-Identifier: AGPL-3.0-or-later` on every new
  source file (and on a migration or `docker/db/` script you touch).
- Crate layering points inward. `evp-domain` takes no `evp-*`, sqlx or axum;
  `evp-intake` takes no `evp-db`.
- Rust: no `unsafe`, `unwrap`/`expect`/`panic`/indexing in libraries, `as`
  casts, float maths or unchecked arithmetic. Use `Decimal`, `jiff`, an
  injected `Clock`, ID newtypes, and `thiserror` in libraries.
- TypeScript: no `any`, `!`, `as`, `enum`, `v-html` or `console.log`. Parse
  with valibot at every boundary.
- Suppressions use `#[expect(lint, reason = "…")]`, and `eslint-disable`
  carries a description.
- SQL: bound parameters only. Use `QueryBuilder`, never `format!`.
- Migrations are forward-only. Never edit an applied one. Scaffold with
  `just migrate-new <name>`.
- RLS keys off `SET LOCAL` inside the request transaction. Never plain `SET`.
- A new mutating endpoint records its inverse and returns an operation id
  (ADR-0024).
- Never commit real volunteer data.
- Comments explain *why*, never *what*.

## 8. Before opening the PR

```
just check     # fmt, prettier, clippy -D warnings, sqlx check, eslint, tsc/vue-tsc
just test      # nextest + vitest
just test-tz   # if anything touches time
just e2e       # if the UI or an API flow changed (needs `just up`)
just mutants   # if evp-domain / evp-intake changed
```

Then:

1. `git rebase main` onto a fresh `main`, re-run the gates if anything moved.
2. Read your own diff (`git diff main...`), checking for leftover debug code,
   commented-out code, comments that restate code, and stale docs (§6).
3. Push and `gh pr create`. The description covers:
   - what changed and why, linking the doc sections and ADRs
   - **test evidence**: for a fix, the failing output from before the fix;
     for test-first areas, the red step; mutation results if run
   - the security justification if `docs/12 §9` applies
   - anything irreversible (a data-losing migration, an action with no
     inverse), called out explicitly for reviewer sign-off
4. Wait for CI to go green. A red CI job is fixed, not retried.
