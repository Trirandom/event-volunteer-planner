# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A multi-tenant volunteer-staffing planner for events, replacing a Google Sheets
workflow. Vue 3 SPA(s) + Rust/Axum API + PostgreSQL 17, all under Docker Compose.

The project is **documentation-first**: `docs/01`–`docs/17` and `docs/adr/` were
written before the code and are the authority on intended behaviour. Before
changing anything structural, read the relevant doc and the ADRs it cites — most
"why is it like this?" questions are already answered there, including the
rejected alternatives. **ADRs are immutable once accepted**; changing a recorded
decision means writing a new ADR that supersedes it (ADR-0001).

Implementation state (see `docs/07-roadmap.md`; the milestones are being built
out of order, driven by the first real festival, Soundclash 26):

- **Built:** config, password sign-in with opaque Postgres sessions and a login
  rate limit, the bootstrap owner (`EVP_BOOTSTRAP_*`, read only while `users`
  is empty), `GET /api/v1/meta`, RLS; festivals and events (ADR-0032/0044) and
  the one-click worked example (`evp_db::catalog::create_example`); the
  zone/post location tree ("missions") with form flags (ADR-0041); shift
  patterns, `shifts/generate` and the shift board; participations, availability
  windows, assignments with the exclusion constraints (create/cancel; each
  mutation writes an `operations` row); per-org OVH SMS settings (ADR-0034).
- **Admin plan pages:** details → missions → shifts → form → assignments →
  submissions (+ `…/submissions/review`) → availability → emails (dry-run
  preview only — nothing is sent), plus `/:org/sms-settings`.
- **First-party form (docs/09):** authoring with
  `forms`/`form_versions`/`form_questions`, draft/publish, festival-scoped forms,
  the `missions` question, per-participation custom answers
  (ADR-0035/0036/0037), per-day availability (ADR-0039) and the commitment
  question (ADR-0040). `apps/form` renders it; `GET/POST
  /api/v1/public/forms/{slug}` serve it (`evp-api/src/public_form.rs`). The slug
  resolves across orgs through the `forms_public_slug_read` policy, and only
  while the form is live and open. Submissions are stored raw, then reconciled
  on the same transaction (ADR-0042, `evp_db::intake` over the pure
  `evp-intake` ladder): matched or created volunteer, `confirmed`
  participations, submitted windows. Ambiguous ones go to `needs_review` and are
  resolved on the review sub-page (`evp-api/src/intake.rs`). Every submission
  carries a self-hosted proof-of-work captcha (ADR-0043,
  `evp_domain::captcha`, `apps/form/src/captcha/solve.ts`). `just reconcile
  <org_id>` backfills `received` rows. `/f/demo` serves the worked example in
  development only.
- **Not built:** magic links, OIDC, invitations and org/member management;
  volunteer pool UI/API, skills, token links, `participation_details`; the
  soft-warning engine (`acknowledge_warnings` is accepted but nothing computes
  warnings; no `/assignments/check` or move), coverage view, event duplication;
  undo endpoints (operations are recorded, nothing reads them), audit-log
  writes; outbox/worker (the OVH `SmsSender` exists, unwired), publishing
  rosters, emails, ICS, PDF; foreign intake sources (CSV/Sheets/webhook);
  retention sweep and rights routes; `/metrics`; OpenAPI and the generated TS
  client; `evp-cli` `create-org`/`seed`/`rotate-app-key` (stubs that `bail!`).
- **CI (`.github/workflows/`, docs/06 §5):** on every push and PR — fmt,
  clippy, nextest (+ `TZ=Pacific/Chatham`) against Compose's `db`, prettier,
  eslint, typecheck, vitest, build, cargo-deny, `pnpm audit --prod`, gitleaks,
  CodeQL, dependency review. On `main` it then builds, Grype-scans and pushes
  `api`/`migrate`/`web` to ghcr.io, only for services whose inputs changed.

## Commands

`just` is the entry point (`just --list`). **Everything touching Rust, SQL or the
database runs inside Compose**; only the frontend recipes run on the host.

```
just up           # whole stack, http://localhost:8080 (Mailpit UI :8025)
just upd          # detached
just down / nuke  # stop; nuke also destroys volumes (only way to re-run docker/db/init/)
just logs [svc]
just up-oidc      # adds Dex, to exercise OIDC offline

just db-reset     # drop, recreate, migrate (restart the API to recreate the bootstrap owner)
just migrate      # apply pending migrations without restarting the API
just migrate-new <name>   # scaffolds <version>_<name>.up.sql + .down.sql
just psql         # psql as evp_api — RLS applies, so you see what the app sees
just psql-admin   # psql as evp_migrator (owner; bypasses RLS)
just reconcile <org_id>   # reconcile `received` submissions into the pool
just dump-example <org> [festival]  # regenerate example.json — mock-volunteer orgs only
# just bootstrap / just seed call evp-cli stubs and fail; use EVP_BOOTSTRAP_* and
# "Load the example festival" instead.

just check        # the local gate (CI runs the same): fmt, prettier, clippy -D warnings, sqlx prepare --check, eslint, tsc/vue-tsc
just test         # cargo nextest + vitest
just test-tz      # whole Rust suite again under TZ=Pacific/Chatham
just mutants      # cargo-mutants over evp-domain + evp-intake (slow; pre-PR only)
just e2e          # Playwright; needs the stack up
just openapi      # planned: regenerate openapi.json + the TS client (fails today)
```

Running one test:

```
docker compose run --rm --entrypoint cargo api nextest run -p evp-domain <filter>
pnpm vitest run packages/shared/src/meta.test.ts      # or: pnpm vitest run -t "<name>"
pnpm exec playwright test e2e/api-meta.spec.ts
```

`just check-web`/`test-web` call the root scripts (`pnpm lint`, `pnpm
typecheck`, `pnpm test`); `typecheck` also runs each package's `vue-tsc`. The
Rust DB tests run inside one rolled-back transaction as `evp_migrator` against
the dev database, not `sqlx::test` (`crates/evp-db/tests/catalog.rs`).

## Architecture

### Crate layering (`crates/`)

```
evp-domain   pure: entities, value objects, constraint engine. No I/O, no sqlx, no axum.
evp-db       the only crate that knows SQL exists: SQLx repos, migrations, RLS session handling
evp-api      Axum routers, extractors, DTOs, OpenAPI, error mapping
evp-intake   mapping/transform/reconciliation — pure over stored raw payloads (depends on domain, NOT db)
evp-worker   outbox consumer: email, SMS, ICS, retention sweep
evp-cli      admin tasks (binary `evp-cli`)
evp-bin      composition root: config, wiring, main() (binary `evp`, at /app/evp)
```

**Dependency direction is strictly inward** and each `Cargo.toml` documents its
own boundary. `evp-domain` depending on an `evp-*` crate, on sqlx, or on axum is
a rejected change. `evp-intake` staying off `evp-db` is what keeps intake
replayable and cheap to mutation-test.

Dependency *versions* are decided only in `[workspace.dependencies]` in the root
`Cargo.toml`; members say `workspace = true`. The rationale register (what was
chosen, what was rejected, why a feature flag is set the way it is) is
`docs/17-backend-stack.md`, and the root `Cargo.toml` comments carry the short
version.

### Request lifecycle (docs/02 §3)

Caddy → tower-http middleware → session extractor (`evp_session` cookie, opaque
session in Postgres) → org extractor (membership check, attaches
`(user_id, org_id, role)`) → **transaction begins with `SET LOCAL
app.current_org_id` / `app.current_role`** → handler → domain service →
repository (persist + audit row + outbox enqueue, same transaction) → commit.
Audit and outbox are the target and not built yet; today a mutation persists
and writes an `operations` row.

Two steps are load-bearing and must not be worked around: the `SET LOCAL` (RLS
keys off it, and `SET` instead of `SET LOCAL` leaks across pooled connections),
and doing side effects through the outbox inside the same transaction.

### Multi-tenancy and the database

Shared schema, `org_id` on every tenant table, **PostgreSQL Row-Level Security
is the enforcing layer** — application `WHERE org_id = …` is belt-and-braces
only. Two roles: `evp_migrator` owns everything and runs migrations as a
separate Compose step; `evp_api` owns nothing, is `NOSUPERUSER` and
`NOBYPASSRLS`. Those three attributes *are* the isolation guarantee (owner,
superuser and `BYPASSRLS` all silently skip RLS).

Correctness lives in the schema where it can be expressed there — the six hard
rules (double-booking via `EXCLUDE USING gist … WITH &&`, duplicate assignment,
cross-tenant FKs, shift-outside-event triggers, …) are listed identically in
`docs/02 §5` and `docs/05 §2` and must not drift apart. Everything merely
*unwise* is a soft warning computed in `evp-domain` and overridable
(ADR-0007) — real events run on exceptions.

### Frontend

Two Vite bundles, deliberately separate: `apps/admin` (coordinator app, session
cookie) and `apps/form` (public volunteer form, no session, minimal bundle),
plus `packages/shared`. **The split is a security boundary before it is a size
optimisation**: the form must not ship admin code or the admin API client. That
is why `pnpm-workspace.yaml` sets `hoist: false` / `shamefullyHoist: false` — an
undeclared import must be a resolution error, not a review comment. Dev runs two
Vite servers (5173 admin, 5174 form) behind Caddy on 8080, so the browser sees
one origin and cookies behave as in production.

API types are meant to be **generated** from OpenAPI (ADR-0030), but that
pipeline is not built: today each admin module in `apps/admin/src/api/` parses
responses with hand-written valibot schemas. Follow that pattern until it lands.

UI text is **never written in a template or a module**: it lives in
`apps/<app>/src/i18n/{fr,en}/<area>.ts` and is read with that app's `t`
(`import { t } from '../i18n'`), whose keys are typed against the French
catalogue. French is the default and fallback, English is lazy-loaded, messages
are ICU (FormatJS), and dates go in pre-formatted by `@evp/shared/intl`.
`vue/no-bare-strings-in-template` and `i18n/catalogue.test.ts` gate it
(docs/16 §6, ADR-0038).

## Non-negotiables

These are policy, not style preferences. Where a gate exists it is `just check`
/ `just test` (and `just e2e`, `just test-tz`), mirrored in CI (docs/06 §5), and
the tables mark what is still planned. `docs/11 §7` maps each standard to its gate;
`docs/13 §12`, `14 §7`, `15 §9`, `16 §7` hold the other four tables. Anything in
none of those five tables is judgement, not policy (ADR-0015).

- **Every source file carries `// SPDX-License-Identifier: AGPL-3.0-or-later`**
  (migrations and `docker/db/` scripts do not yet — add it when touching one).
  Commits need `Signed-off-by` (`git commit -s`, DCO); nothing checks it yet.
- **AGPL §13 is a product requirement.** Both frontends show version + source
  link; `GET /api/v1/meta` is unauthenticated and un-rate-limited. Do not remove
  or gate these.
- **Migrations are forward-only and immutable once applied.** Correct a mistake
  with a new migration; never edit an applied one. One concern per migration.
  A new tenant table is unfinished without, in the same file: `ENABLE` **and**
  `FORCE ROW LEVEL SECURITY`, a policy with both `USING` and `WITH CHECK`,
  composite FKs carrying `org_id`, and a `retention_scope` row (ADR-0026). A
  test asserts this for the form tables; a `pg_class`-wide check is planned. `audit_log` must revoke UPDATE/DELETE from
  `evp_api`.
- **Rust:** `forbid(unsafe_code)`; `unwrap`/`expect`/`panic`/indexing/`todo`
  denied in library code (relaxed in tests via `clippy.toml`, and in `main.rs`
  startup); `arithmetic_side_effects`, `as_conversions`, `float_arithmetic`
  denied — hours are `Decimal`, times are `jiff::Timestamp`/`Zoned`, IDs are
  newtypes, `now()` comes from an injected `Clock`. `thiserror` in libraries,
  `anyhow` only in `main`/CLI, one place maps domain errors to
  `application/problem+json`.
- **TypeScript:** `strict` + `noUncheckedIndexedAccess` +
  `exactOptionalPropertyTypes` + `skipLibCheck: false`. Banned: `any`, `!`,
  `as` assertions, `enum`, `v-html`, `console.log`. Parse (valibot), don't cast,
  at every boundary.
- **Suppressions must justify themselves:** `#[expect(lint, reason = "…")]`
  rather than `#[allow]`; `eslint-disable` requires a description. An unused
  suppression is a warning/failure.
- **SQL:** queries are runtime `sqlx::query*` with bound parameters today (no
  `query!` macros, no `.sqlx/` cache, so `just check-sql` has nothing to check
  yet). No dynamically constructed SQL — use `QueryBuilder` with bound
  parameters; never `format!`/`push_str` SQL.
- **Tests:** never mock the database. No test reads the wall clock. No retries —
  a flaky test is fixed or deleted. Every hard constraint has a test that
  *attempts the violation* and asserts the SQLSTATE (`23P01`, `23505`, `23503`).
  Every engine rule gets passing/failing/boundary cases. A bug fix needs a
  regression test that fails on `main`. Test-first is mandatory for the
  constraint engine, DB constraints, authorisation, intake mapping and anything
  timezone-related; explicitly not for exploratory UI work (docs/13 §2–3).
- **New mutating endpoints record their inverse** and return an operation id
  (ADR-0024).
- **Dependencies** must be AGPL-compatible (`cargo deny check` with
  `deny.toml`, in CI; npm: dependency review on PRs, full-tree check planned). npm packages must be ≥7
  days old (`minimumReleaseAge`). Never commit real volunteer data:
  `docs/googleSheets/example_data/` is gitignored and stays that way, and
  `just dump-example` must only target an org of mock volunteers.

## Conventions worth knowing

- Comments explain **why**, not what — this codebase's comments record why the
  obvious approach is wrong here. Match that density and register; a comment
  restating the code gets deleted.
- Configuration: `EVP_*` env vars parsed once at startup via figment, process
  exits on anything missing or malformed. Any variable may be given as
  `<NAME>_FILE` instead (contents = value); setting both is a startup error.
  Secrets are always files. `docs/06 §2` is the full table; `.env.example`
  covers the Compose-level knobs (ports, DB passwords, log level, bootstrap
  owner, `EVP_SOURCE_URL`). Ports bind to 127.0.0.1 only.
- Time: `timestamptz` only, UTC on every pooled connection, display in the
  *event's* IANA timezone. Never `SELECT now()` in business logic (ADR-0019).
- IDs are UUIDv7. Money is out of scope and staying that way.
- Authorisation is expressed as Axum extractors (`Owner`, `Coordinator`,
  `ZoneLead`) so it cannot be forgotten inside a handler; the route × role
  matrix is also a test.
- Security-relevant changes (`org_id`, an auth extractor, a token, `SET` vs
  `SET LOCAL`) need the justification written in the PR — `docs/12 §9` is the
  review list.
