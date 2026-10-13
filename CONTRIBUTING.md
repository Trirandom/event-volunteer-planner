# Contributing

Thanks for looking. This is a volunteer-planning tool for events, built to
replace a spreadsheet that outgrew itself. Design documentation is in
[`docs/`](docs/) — start with [`docs/README.md`](docs/README.md), and read the
[ADRs](docs/adr/) before proposing anything structural. Most "why is it done
this way?" questions are answered there, including the alternatives that were
rejected.

## Licence and sign-off

The project is **AGPL-3.0-or-later**. By contributing you agree your work is
licensed under those terms.

We use the **Developer Certificate of Origin** ([DCO](https://developercertificate.org/))
rather than a CLA. There is nothing to sign — just certify each commit:

```
git commit -s -m "planner: keyboard equivalent for shift drag"
```

which appends:

```
Signed-off-by: Your Name <your.email@example.org>
```

That line asserts you wrote the patch, or have the right to submit it under the
project licence. Commits without it will not be merged. Set it up once:

```
git config user.name  "Your Name"
git config user.email "your.email@example.org"
```

If you contribute from a work machine, check that your employer does not claim
ownership of what you write on their time or equipment. Using a personal email
address for commits keeps provenance clean.

## Source file headers

Every source file carries a short header. AGPL relies on notices being present,
and a per-file header survives copy-paste in a way a single `LICENSE` does not.

```rust
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors
```

`SPDX-License-Identifier` alone is sufficient and is what tooling reads. Do not
add your own copyright line to an existing file for a small change; add it if
you write a substantial new file.

## §13: the network-use obligation is a feature, not paperwork

AGPL §13 requires that anyone interacting with a deployed instance **over a
network** can obtain its source. That includes coordinators using the admin
application *and* volunteers filling in the form.

So it is a product requirement, not a licence footnote:

- Both frontends expose the source URL and the running version — the admin
  application on its home page, the public form in its footer.
- `GET /api/v1/meta` returns `{ version, commit, source_url }` unauthenticated.
- The build stamps the real commit. **A deployment running modified code must
  point at the modified source**, so `EVP_SOURCE_URL` is configurable and
  defaults to the upstream repository.

If you change the frontends, do not remove those links. A deployment without
them is out of compliance, and the person running it probably will not notice.

## Dependencies

Runtime dependencies must be AGPL-compatible. For Rust, `cargo deny check`
enforces the allow-list in [`deny.toml`](deny.toml) — run it locally, as it is
not yet wired into `just check`. An equivalent frontend licence check is
planned; until then, check new npm packages by hand.

**Allowed:** MIT, MIT-0, Apache-2.0, BSD-2/3-Clause, ISC, Zlib, MPL-2.0,
Unicode-3.0, CC0-1.0, AGPL-3.0(-or-later), GPL-3.0, LGPL-3.0.

**Denied outright:** SSPL, BUSL, Elastic, Commons Clause, and anything
source-available-but-not-free. These are not open source and cannot be
combined. This is why the stack avoids Redis and MongoDB — see
[ADR-0006](docs/adr/0006-postgres-backed-job-queue.md) and
[ADR-0003](docs/adr/0003-postgresql-with-row-level-security.md), which rejected
both on other grounds and happen to keep us clear here too.

Adding a dependency under any other licence needs discussion first.

## Coding standards

[docs/11 — Engineering standards](docs/11-engineering-standards.md) is the
reference for language and build standards, and it ends with a table mapping
each one to the gate that enforces it, or marks it as planned. Four other areas keep their own
enforcement tables, listed at the end of that section: testing
([13 §12](docs/13-testing-and-tdd.md#12-enforcement)), accessibility
([14 §7](docs/14-accessibility-and-interaction.md#7-enforcement)), privacy
([15 §9](docs/15-privacy-and-retention.md#9-enforcement)) and time
([16 §7](docs/16-i18n-and-time.md#7-enforcement)).

Anything in none of those five tables is judgement, not policy
([ADR-0015](docs/adr/0015-strictness-is-enforced-not-documented.md)).

The short version: no `unsafe`, no `unwrap`/`expect`/indexing in library code,
no `as` casts, no `any`, no `!` non-null assertions, no `v-html`. TypeScript
runs `strict` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
Suppress a lint with `#[expect(..., reason = "…")]` or an `eslint-disable` that
carries a description — a suppression without a reason fails the build, and one
that is no longer needed becomes a warning.

Security-relevant changes have their own review list in
[docs/12 — Security §9](docs/12-security.md#9-reviewing-security-relevant-change).
If your change touches `org_id`, an authorisation extractor, a token, or `SET`
versus `SET LOCAL`, say in the pull request why it is safe.

## Before opening a pull request

```
just check      # rustfmt, prettier, clippy -D warnings, sqlx prepare --check, eslint, tsc/vue-tsc
just test       # cargo nextest (against the dev database) + vitest
just e2e        # Playwright; needs the stack up (`just up`)
```

There is no hosted CI yet, so these are the gate: run them before opening a
pull request.

- A change to behaviour needs a test. A change to a **hard constraint** needs a
  test that *attempts the violation* and asserts the database refuses it.
- **A bug fix needs a regression test that fails on `main`** and passes with the
  fix. Show the failing output in the pull request. This one is unconditional
  ([13 §4](docs/13-testing-and-tdd.md#4-bug-fixes-regression-test-first-always)).
- Test-first is **required** for the constraint engine, database constraints,
  authorisation, intake mapping and anything touching timezones — and
  deliberately **not** required for exploratory UI work. The dividing line and
  the reasoning are [13 §2–3](docs/13-testing-and-tdd.md#2-where-test-first-is-mandatory).
- Don't mock the database. Don't retry a flaky test — fix or delete it.
- A change to the data model is a new migration, never an edit to an applied
  one.
- **A new table needs a `retention_scope` row** with a real reason
  ([ADR-0026](docs/adr/0026-retention-scope-is-a-table-registry.md)). If a
  column would have to be *nulled* by the retention sweep rather than deleted
  with its row, it is on the wrong table.
- **A new mutating endpoint records its inverse** and returns an operation id
  ([ADR-0024](docs/adr/0024-server-side-undo-and-per-item-bulk.md)). An action
  that cannot be undone is a decision, and it needs saying in the pull request.
- A change to a decision recorded in an ADR needs a new ADR that supersedes or
  amends it. ADRs are immutable once accepted — see
  [ADR-0001](docs/adr/0001-record-architecture-decisions.md).
- Personal data: never commit real volunteer data. The spreadsheet export in
  `docs/googleSheets/example_data/` is gitignored and must never be committed,
  and the worked example (`crates/evp-domain/src/example.json`) must only ever
  be dumped from an organisation of mock volunteers.

## Reporting a security issue

Do not open a public issue. Report it privately as described in
[SECURITY.md](SECURITY.md), with enough detail to reproduce. Tenant isolation, the OIDC callback, the public form
endpoint and the capability URLs (ICS feeds, form token links) are the areas
where a report is most valuable.
