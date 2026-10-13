# Event Volunteer Planner

A multi-tenant web application for planning volunteer staffing at events —
built to replace a Google Sheets workflow that outgrew the tool.

Coordinators lay out an event's missions and shifts, volunteers apply through
a public form with precise per-day availability, and assignments are checked
by the database itself: **a volunteer cannot be double-booked**, no matter
which screen, request or bug tries.

> **Status: early, under active development.** The planning core and the public
> volunteer form work and are being used to prepare a first real festival.
> Notifications (email, SMS, calendar feeds), magic-link/OIDC sign-in and the
> constraint engine's soft warnings are not built yet — see [Status](#status).
> Not ready for production use.

## The problem

Volunteer planning ran on Google Sheets with a substantial Apps Script layer.
It was more capable than "a spreadsheet" suggests — per-cell eligibility
dropdowns, coverage pivots, per-volunteer schedule emails and SMS with change
detection, ICS invites and a PDF export.

It has one defect that cannot be fixed in that medium.

**Data validation cannot prevent double-booking.** To stop it, an assigned
volunteer would have to disappear from every other dropdown covering the same
time — but a validation rule is a static range, and a cell whose value falls
outside its range is marked invalid. Removing someone from the 14h–16h lists
invalidates the cell that just assigned them.

*Show only assignable people* and *keep existing assignments valid* cannot both
hold. So the system can check that a name is **eligible**, but never that it is
still **free**. Alongside that: eligibility lists go stale, identity is a
lowercased name string (a rename silently orphans someone's shifts),
availability is coarse because no general-purpose form can ask for a time
range, and nothing records who changed what.

[Full analysis of the prior system →](docs/10-prior-art-spreadsheet.md)

## The approach

Make invalid schedules **structurally impossible**, and keep everything the
spreadsheet got right.

- **Hard rules live in PostgreSQL.** Double-booking is an `EXCLUDE USING gist`
  constraint; duplicate assignments, cross-tenant references and shifts outside
  their event are constraints or triggers too. No bug, concurrent request or
  future endpoint can violate them. Merely *unwise* choices are meant to be
  warnings a coordinator can override deliberately
  ([ADR-0007](docs/adr/0007-hard-vs-soft-scheduling-constraints.md)) — real
  events run on exceptions.
- **Tenant isolation is Row-Level Security**, not a `WHERE` clause someone has
  to remember. The API's database role owns nothing and cannot bypass RLS
  ([ADR-0003](docs/adr/0003-postgresql-with-row-level-security.md)).
- **Volunteers never log in.** They answer [our own form](docs/09-volunteer-form.md),
  which asks for exact per-day availability. Submissions are stored raw, then
  reconciled into the volunteer pool; ambiguous matches are queued for a
  coordinator ([08](docs/08-volunteer-intake.md),
  [ADR-0042](docs/adr/0042-public-submissions-reconciled-inline.md)).

## Status

**Works today**

- **Planning:** festivals and events; missions (a zone/post tree with
  min/max volunteers); shift patterns that generate shifts; a shift board;
  participations, availability windows and assignments, with exclusivity
  enforced by the database. A one-click worked example loads a complete
  festival (6 events, missions, shifts, 27 mock volunteers).
- **Public volunteer form:** authored in the admin with draft/publish versions,
  festival-wide forms, a missions question and per-day Yes/Partly/No
  availability. Served at `/f/{slug}`, protected by a self-hosted
  proof-of-work captcha, a honeypot and a rate limit. Submissions join the
  volunteer pool inline; ambiguous ones go to a review queue.
- **Admin:** a plan workflow — details → missions → shifts → form →
  assignments → submissions (+ review) → availability → emails (dry-run preview
  only) — and per-organisation SMS provider settings (encrypted). French and
  English UI.
- **Accounts:** password sign-in, opaque server-side sessions, login rate
  limiting. The first owner is created from environment variables.

**Not built yet**

- Magic-link and OIDC sign-in, invitations, organisation and member management
- Sending anything: email, SMS, roster publishing, ICS calendar feeds, PDF
- The soft-warning constraint engine, coverage view, event duplication, undo
- Volunteer token links and self-service rights (export, correction, erasure)
- CSV / Sheets / webhook intake, skills, retention sweep, audit log, metrics
- OpenAPI and a generated TypeScript client

The [roadmap](docs/07-roadmap.md) has the milestones. The documentation in
[`docs/`](docs/) was written before the code and describes the intended
system; where it describes something unbuilt it says so.

## Quick start

Requirements: **Docker** with Compose, and [**just**](https://github.com/casey/just).
Everything — Rust, PostgreSQL, Node — runs in containers.

```sh
cp .env.example .env
# In .env, uncomment and set the first owner:
#   EVP_BOOTSTRAP_USERNAME=you@example.org
#   EVP_BOOTSTRAP_PASSWORD=<at least 12 characters>
just up
```

Then open <http://localhost:8080>, sign in with that address and password, and
use **Charger le festival d’exemple** (*Load the example festival* — the UI
defaults to French) to get a populated plan. Outgoing mail is
caught by Mailpit at <http://localhost:8025>. The public form's worked example
is at <http://localhost:8080/f/demo> in development.

The bootstrap variables are read only while no user exists; remove them once
you have signed in. All ports bind to `127.0.0.1`, and every key and password
in `.env.example` and `docker/dev-secrets/` is a **public development fixture**
— never reuse them for a reachable deployment.

Useful recipes (`just --list` for all):

```sh
just up / upd / down     # run the stack (attached / detached), stop it
just nuke                # stop and destroy the database volume
just migrate             # apply pending migrations
just psql                # psql as the API role — RLS applies
just check               # format, clippy, eslint, type checks
just test                # Rust tests (against the dev database) + Vitest
just e2e                 # Playwright; needs the stack up
```

[docs/06 — Local development](docs/06-local-development.md) covers the Compose
topology, configuration variables and testing in detail.

## Stack

Vue 3 + TypeScript (two Vite bundles: the admin app and the public form) ·
Rust (Axum, SQLx, Tokio) · PostgreSQL 17 · Caddy · Docker Compose

```
apps/admin        coordinator app (session cookie)
apps/form         public volunteer form — deliberately ships no admin code
packages/shared   shared TS: design tokens, formatting, meta
crates/           evp-domain (pure) · evp-intake (pure) · evp-db · evp-api ·
                  evp-worker · evp-cli · evp-bin (composition root)
migrations/       forward-only SQL; RLS, constraints, retention registry
docs/             specification, architecture and ADRs
```

PostgreSQL is the load-bearing choice: its exclusion constraints and row-level
security turn the product's two central guarantees into database invariants
rather than hopeful application code. Every choice, with the alternatives that
were rejected, is in the [ADRs](docs/adr/).

**Scale target:** 500 volunteers, ~5000 assignments per event, ~20 concurrent
coordinators. One API process, one database, no cache, no broker.

## Documentation

| Doc | |
| --- | --- |
| [Product spec](docs/01-product-spec.md) | Scope, personas, user stories, non-goals |
| [Architecture](docs/02-architecture.md) | Stack, components, request lifecycle, deployment |
| [Data model](docs/03-data-model.md) | Entities, schema DDL, tenant isolation |
| [API surface](docs/04-api.md) | REST resources, conventions, permissions |
| [Scheduling rules](docs/05-scheduling-rules.md) | The constraint engine |
| [Local development](docs/06-local-development.md) | Compose topology, configuration, testing |
| [Roadmap](docs/07-roadmap.md) | Milestones and their status |
| [Volunteer intake](docs/08-volunteer-intake.md) | The pipeline: raw answers → reconciled domain data |
| [Volunteer form](docs/09-volunteer-form.md) | Our own form and its availability picker |
| [Prior art](docs/10-prior-art-spreadsheet.md) | The spreadsheet it replaces, and why |
| [Engineering standards](docs/11-engineering-standards.md) | Lints, type discipline; what is enforced vs. judgement |
| [Security](docs/12-security.md) | Threat model and the structurally-enforced invariants |
| [Testing and TDD](docs/13-testing-and-tdd.md) | Test-first scope, mutation testing, determinism rules |
| [Accessibility](docs/14-accessibility-and-interaction.md) | WCAG 2.2 AA, keyboard grid, mass-modification shortcuts |
| [Privacy and retention](docs/15-privacy-and-retention.md) | What is held, for how long, and how it is erased |
| [i18n and time](docs/16-i18n-and-time.md) | Instants, event timezones, fr/en |
| [Backend stack](docs/17-backend-stack.md) | Dependency register: chosen, rejected, and why |
| [ADRs](docs/adr/) | Decisions, with the alternatives that were rejected |

## Self-hosting

Self-hosting shaped several decisions:

- **No required external service.** The stack runs with no Google account,
  OAuth client or identity provider.
- **One deployable, one database.** No broker, no cache, no IdP to operate;
  background jobs are meant to use a Postgres-backed queue
  ([ADR-0006](docs/adr/0006-postgres-backed-job-queue.md)).
- **Pluggable sign-in, by design.** Any OIDC provider is meant to be a config
  entry ([ADR-0014](docs/adr/0014-pluggable-oidc-providers.md)); this is not
  built yet.

`compose.prod.yaml` describes a production topology (secrets as files under
`./secrets/`, Caddy with TLS, a backup sidecar), but no images are published
yet — build your own and set `EVP_REGISTRY` and `EVP_VERSION`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Contributions are under the
[DCO](CONTRIBUTING.md#licence-and-sign-off) — a `Signed-off-by` line, no CLA.
Please report security issues privately as described in
[SECURITY.md](SECURITY.md).

## Licence

**[AGPL-3.0-or-later](LICENSE)** · Copyright (C) 2026 Tristan Grunert and contributors

Chosen because this is a network-deployed application. GPL-3.0 would not have
covered it: running a modified web app on a server is not "distribution", so
GPL imposes nothing on a commercial hosted fork. AGPL §13 closes that gap — if
you let people use a modified version over a network, you owe *them* the
source. For an association self-hosting this, that costs nothing.

**If you deploy a modified version, §13 applies to you**, and the application
is built to make compliance automatic: both frontends link to the source and
show the running version, and `GET /api/v1/meta` returns it unauthenticated.
Point `EVP_SOURCE_URL` at your fork and you are compliant. Do not remove those
links.
