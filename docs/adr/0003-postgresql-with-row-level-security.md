# ADR-0003 — PostgreSQL, with Row-Level Security for tenant isolation

**Status:** Accepted · **Date:** 2026-09-10

## Context

The brief asked for a database that is "super fast and light". The workload is
500 volunteers and a few thousand shifts per event — trivial for any modern
database. The actual demands are different from speed:

1. **Overlap detection.** Preventing double-booking is the core value of the
   product, and it is a range-overlap constraint.
2. **Multi-tenant isolation** that does not depend on every query being right.
3. **A background queue**, without adding a second stateful component.

## Decision

PostgreSQL 17, single instance, with `btree_gist`, `citext` and `pg_trgm`.
Tenant isolation via `org_id` on every tenant-owned table, enforced by
Row-Level Security keyed on a `SET LOCAL app.current_org_id` GUC, with the API
connecting as a non-owner role without `BYPASSRLS`.

The deciding capability is exclusion constraints. This:

```sql
EXCLUDE USING gist (volunteer_id WITH =, period WITH &&) WHERE (status <> 'cancelled')
```

makes double-booking *unrepresentable* — not merely checked. No amount of
application code, concurrent requests, or future endpoints can produce one. No
other candidate offers this.

PostgreSQL also supplies the job queue (`FOR UPDATE SKIP LOCKED`), session
storage, full-text and trigram search, and JSONB for audit payloads. Each of
those would otherwise be a separate component.

## Alternatives considered

**SQLite.** Genuinely the fastest and lightest option: no network hop, one file
to back up, one less container. Rejected on three counts. It has no range types
and no exclusion constraints, so the central invariant would move into
application code and stop being a guarantee. It has no row-level security, so
tenant isolation would rest entirely on query discipline. And its single-writer
model, while ample for this workload, forecloses a second API replica. Litestream
would have handled durability well; the correctness gap is what decided it.

**MySQL / MariaDB.** No range types, no exclusion constraints, no RLS. Same
objection as SQLite without the compensating lightness.

**MongoDB or another document store.** The domain is relational — volunteers,
shifts, assignments and skills are joins, and the invariants are cross-document.
Enforcing them would mean transactions across documents, which is the relational
model with extra steps.

**CockroachDB / distributed SQL.** Solves a scale problem that does not exist,
at meaningful operational cost.

**Schema-per-tenant or database-per-tenant.** Stronger isolation and easy
per-tenant restore. Rejected because at a few dozen organisations it multiplies
migration runs and connection-pool pressure, and cross-tenant admin queries
become painful — for isolation that RLS already provides at the row level.

## Consequences

- Double-booking, cross-tenant references and duplicate assignments are
  structurally impossible, not merely tested for.
- One stateful component: one backup, one restore drill, one thing to monitor.
- Around 40 MB idle for the container. Heavier than SQLite, negligible in
  absolute terms.
- RLS costs a `SET LOCAL` per transaction and requires care with pooling —
  `SET` instead of `SET LOCAL` would leak across requests. Enforced by code
  review and by the isolation test suite.
- Tenant-configurable rules (see [ADR-0007](0007-hard-vs-soft-scheduling-constraints.md))
  cannot use static constraints and therefore do not get this backstop.
