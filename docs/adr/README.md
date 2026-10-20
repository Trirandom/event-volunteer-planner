# Architecture Decision Records

Immutable once accepted. A change of mind is a new ADR that supersedes the old
one — never an edit. See [ADR-0001](0001-record-architecture-decisions.md).

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-rust-axum-backend.md) | Rust and Axum for the backend | Accepted |
| [0003](0003-postgresql-with-row-level-security.md) | PostgreSQL, with RLS for tenant isolation | Accepted |
| [0004](0004-vue3-spa-frontend.md) | Vue 3 SPA, TanStack Query for server state | Accepted |
| [0005](0005-magic-link-authentication.md) | Email magic links, server-side sessions | Accepted |
| [0006](0006-postgres-backed-job-queue.md) | Transactional outbox in PostgreSQL, no broker | Accepted |
| [0007](0007-hard-vs-soft-scheduling-constraints.md) | Two-tier constraints: hard in the DB, soft in the domain | Accepted (amended by 0022, 0023, 0029) |
| [0008](0008-no-volunteer-authentication-in-v1.md) | Volunteers do not authenticate in v1 | Accepted (amends 0005; amended by 0010, 0027) |
| [0009](0009-form-agnostic-intake-pipeline.md) | A form-agnostic, replayable intake pipeline | Accepted (amended by 0010, 0028) |
| [0010](0010-first-party-form-as-primary-intake.md) | A first-party form is the primary intake channel | Accepted (amends 0009; amended by 0027) |
| [0011](0011-single-display-name-not-first-last.md) | One display name, not a first and last name | Superseded by 0012 |
| [0012](0012-name-parts-asked-not-parsed.md) | Verbatim display name, plus optional parts that are asked, never parsed | Accepted (amended by 0037) |
| [0013](0013-google-oidc-without-an-identity-provider.md) | Sign in with Google, implemented directly, no identity provider | Accepted (amends 0005, amended by 0014) |
| [0014](0014-pluggable-oidc-providers.md) | Any OIDC provider, declared in configuration | Accepted (amends 0013) |
| [0015](0015-strictness-is-enforced-not-documented.md) | Strictness is enforced, not documented | Accepted |
| [0016](0016-test-first-where-specifiable-mutation-over-coverage.md) | Test-first where specifiable; mutation testing over coverage targets | Accepted |
| [0017](0017-accessibility-target-wcag22-aa.md) | WCAG 2.2 AA; every drag has a keyboard equivalent | Accepted (amended by 0024) |
| [0018](0018-purpose-based-retention.md) | Purpose-based retention: event data purged at one month, pool data by consent | Accepted (amended by 0020, 0025, 0026) |
| [0019](0019-time-discipline.md) | Instants stored; event timezone for display; wall-clock for patterns | Accepted |
| [0020](0020-retention-periods-are-configuration.md) | Retention periods are configuration; default 18 months, hard-capped | Accepted (amends 0018, amended by 0021, 0026) |
| [0021](0021-retention-tier-follows-table.md) | Retention tier follows the table; explicit consent covers dietary data | Accepted (amends 0018, 0020; amended by 0022, 0025, 0026) |
| [0022](0022-no-birthdate-collected.md) | Birthdate is not collected; minor night-shift rule removed | Accepted (amends 0021, 0007; amended by 0023) |
| [0023](0023-adult-declaration-boolean.md) | «J'ai 18 ans ou plus» as a boolean on `participations` | Accepted (amends 0022, 0007; amended by 0026) |
| [0024](0024-server-side-undo-and-per-item-bulk.md) | Server-side undo; bulk operations report per item | Accepted (amends 0017) |
| [0025](0025-two-consents-processing-and-pool-retention.md) | Two consents: processing mandatory, pool retention optional | Accepted (amends 0018, 0021) |
| [0026](0026-retention-scope-is-a-table-registry.md) | Retention scope is a table registry; per-edition attributes leave `participations` | Accepted (amends 0018, 0020, 0021) |
| [0027](0027-volunteer-self-service-rights.md) | Volunteers read, correct and erase their own data via their capability link | Accepted (amends 0008, 0010) |
| [0028](0028-one-volunteer-one-email.md) | One volunteer, one email address per organisation | Accepted (amends 0009) |
| [0029](0029-shift-patterns-are-generators-not-constraints.md) | Per-mission shift patterns, which generate rather than constrain | Accepted (amends 0007) |
| [0030](0030-backend-dependency-selection.md) | Backend dependency selection | Accepted |
| [0031](0031-password-bootstrap-credential.md) | Password bootstrap credential | Accepted |
| [0032](0032-festivals-group-events.md) | `festivals` groups events; a new entity, not an `events` property | Accepted (amended by 0033, 0035, 0044) |
| [0033](0033-event-period-is-operational-public-hours-are-recorded.md) | `events.period` is the operational window; the public hours are a column of their own | Superseded by 0044 |
| [0034](0034-per-org-ovh-sms-credentials.md) | Per-org OVH SMS credentials, coordinator-managed, encrypted in Postgres | Accepted (narrows 06 §2) |
| [0035](0035-a-form-can-cover-a-festival.md) | A form can cover a whole festival | Accepted (amends 0032) |
| [0036](0036-missions-question.md) | A `missions` question: which missions a volunteer could do | Accepted |
| [0037](0037-custom-answers-are-kept-per-participation.md) | Untargeted answers kept per participation; requiredness is the coordinator's | Accepted (amends 0012) |
| [0038](0038-vue-i18n-with-icu-messageformat.md) | vue-i18n for the runtime, FormatJS for ICU MessageFormat, keys typed against French | Accepted |
| [0039](0039-availability-is-answered-per-day-yes-partly-no.md) | Availability is answered per day: «Oui» / «En partie» / «Non» | Accepted (amends 09 §3) |
| [0040](0040-volunteer-commitment-question.md) | A built-in volunteer-commitment question, required and naming the organisation | Accepted (amends 09 §1) |
| [0041](0041-zone-form-flags.md) | Zones say how the form offers them: pre-ticked or opt-in, 18+ | Accepted (amends 0036) |
| [0042](0042-public-submissions-reconciled-inline.md) | Public form submissions are reconciled inline, and strangers join the pool | Accepted (amends 0028, 08 §6, 09 §5) |
| [0043](0043-form-captcha-is-a-self-hosted-proof-of-work.md) | The form's captcha is a self-hosted proof of work, always on | Accepted (amends 09 §5) |
| [0044](0044-event-period-is-operational-doors-are-stated.md) | `events.period` is the operational window; the doors are stated, never inferred | Accepted (supersedes 0033; amends 0029, 0032) |
| [0045](0045-platform-backoffice-behind-a-deployment-key.md) | A platform backoffice, behind a key the deployment holds | Accepted (amends 0031) |
