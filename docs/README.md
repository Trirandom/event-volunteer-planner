# Event Volunteer Planner — documentation

Design documentation for the application that replaces the volunteer-planning
spreadsheet. It was written before the code and remains the reference for
intended behaviour, so parts of it describe features that are not built yet;
[07 — Roadmap](07-roadmap.md) and the [repository README](../README.md#status)
say what works today.

Read in this order:

| Doc | What it answers |
| --- | --- |
| [01 — Product spec](01-product-spec.md) | Who uses it, what problem it solves, what is explicitly out of scope |
| [02 — Architecture](02-architecture.md) | Stack, components, request lifecycle, deployment topology |
| [03 — Data model](03-data-model.md) | Entities, relationships, schema DDL, tenant isolation |
| [04 — API surface](04-api.md) | REST resources, conventions, error format |
| [05 — Scheduling rules](05-scheduling-rules.md) | The constraint engine — the actual reason this beats a spreadsheet |
| [06 — Local development](06-local-development.md) | Docker Compose topology, workflows, testing strategy |
| [07 — Roadmap](07-roadmap.md) | Milestones, sequencing, migration off Google Sheets |
| [08 — Volunteer intake](08-volunteer-intake.md) | The pipeline: raw answers → reconciled domain data. Also the spreadsheet migration |
| [09 — Volunteer form](09-volunteer-form.md) | Our own form: question types, the availability picker, token links |
| [10 — Prior art](10-prior-art-spreadsheet.md) | How the spreadsheet worked, what it got right, and the one thing it cannot do |
| [11 — Engineering standards](11-engineering-standards.md) | Lints, type discipline, testing, and what is enforced versus judgement |
| [12 — Security](12-security.md) | Threat model, and the invariants made structurally impossible to violate |
| [13 — Testing and TDD](13-testing-and-tdd.md) | Where test-first is mandatory, and how test effectiveness is gated |
| [14 — Accessibility and interaction](14-accessibility-and-interaction.md) | WCAG 2.2 AA, the keyboard grid, and mass-modification shortcuts |
| [15 — Privacy and retention](15-privacy-and-retention.md) | What personal data is held, for how long, and how a volunteer removes it |
| [16 — i18n and time](16-i18n-and-time.md) | Storing instants, displaying in the event timezone, fr/en |
| [17 — Backend stack](17-backend-stack.md) | Dependency register: what was chosen, what was rejected, and why |
| [ADRs](adr/) | Individual decisions, with the alternatives that were rejected |

## Licence

AGPL-3.0-or-later. §13 makes source availability to network users a **product
requirement**, not merely a repository file — see
[CONTRIBUTING.md](../CONTRIBUTING.md).

## Decisions at a glance

| Area | Choice |
| --- | --- |
| Frontend | Vue 3 + TypeScript, Vite, Pinia, TanStack Query. Two bundles: admin, public form |
| Backend | Rust, Axum, SQLx, Tokio |
| Database | PostgreSQL 17 (single instance, `btree_gist`) |
| Tenancy | Shared schema, `org_id` everywhere, enforced by Row-Level Security |
| Auth | Magic links by default; any OIDC provider by configuration (no bundled identity provider). Opaque server-side sessions. **Organisation members only.** |
| Volunteer data in | Our own form, with precise per-day availability. Reached by capability URL, no logins. CSV for migration. |
| Volunteer data out | Schedule email + SMS, per-participation ICS capability URL, PDF rosters |
| Volunteer rights | See, correct, export and erase, self-service from the same capability URL; erasure confirmed by mail |
| Slot division | Per-mission shift patterns — 2 h by default, `45/45/90/45/45` where a mission needs it. Reusable across editions, and they *generate* shifts rather than constrain them |
| Mass editing | Per-item bulk operations, and server-side undo of any operation until it is published |
| Jobs & email | Transactional outbox in Postgres, worker in-process |
| Local deploy | Docker Compose: Caddy, API, Postgres, Mailpit |
| Strictness | `forbid(unsafe_code)`, clippy `deny` on panicking and truncating constructs, TS `strict` + `noUncheckedIndexedAccess`, all gated by `just check` |
| Accessibility | WCAG 2.2 AA; every drag has a keyboard equivalent; axe + keyboard-only journey in the Playwright suite |
| Time | `timestamptz` instants, UTC session, display in the **event's** timezone; suite re-run under `TZ=Pacific/Chatham` |
| Retention | Tier follows table, declared per table in the schema (`retention_scope`). Event-tier rows deleted 30 days after the event, `volunteers` kept only by explicit consent expiring at 18 months, verbatim form answers deleted 30 days after they arrive. Periods per-org configurable and hard-capped |
| Consent | Two questions: processing (mandatory, covers email and SMS) and pool retention (optional, names the sensitive categories) |
