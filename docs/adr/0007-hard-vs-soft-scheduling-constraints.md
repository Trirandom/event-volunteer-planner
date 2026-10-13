# ADR-0007 — Two-tier constraints: hard in the database, soft in the domain

**Status:** Accepted · **Date:** 2026-09-10
**Amended by:** [ADR-0022](0022-no-birthdate-collected.md) — the `minor_night_shift`
rule used here as the worked example for tenant-configurable severity was
removed — then [ADR-0023](0023-adult-declaration-boolean.md), which reinstates
that rule on a declared boolean rather than a birthdate, restoring the example.
The two-tier decision itself is unchanged throughout.

## Context

The spreadsheet enforces nothing, which is its central failure. The obvious
overcorrection is to enforce everything: refuse any assignment that breaks any
rule.

That would be worse. Events run on exceptions. Someone does not turn up, the
bar needs covering, and the only person free is a volunteer whose first-aid
certificate lapsed last month and who has already worked nine hours. A tool
that refuses is a tool that gets bypassed — and the bypass is a spreadsheet,
which is where this project started.

Meanwhile, some rules genuinely admit no exception. A volunteer cannot be in
two places at once. No signature, no override, no manager approval changes
that.

## Decision

Classify every rule as **hard** or **soft**, on one criterion: *is the state
physically or logically impossible, or merely undesirable?*

**Hard rules are enforced by database constraints.** Exclusion constraints,
composite foreign keys, partial unique indexes, triggers. They cannot be
overridden by anyone, including a bug, a future endpoint, or a direct `psql`
session. There are six of them.

**Soft rules are evaluated by a pure function in `evp-domain`.** They block the
write by default, but the client may retry with
`acknowledge_warnings: ["skill_expired", "over_daily_hours"]`. The
acknowledged codes are stored on the assignment row, so the exception is
visible afterwards and attributable to whoever made it.

The engine is pure — no I/O, everything passed in — so that `/check` and the
write path provably run the same logic, and so the entire rule set is testable
without a database.

## Alternatives considered

**Everything hard.** Rejected: guarantees abandonment, as argued above.

**Everything soft, in application code.** Simpler and uniform, and it is what
most such tools do. Rejected because the double-booking guarantee is the
product's central claim, and an application-level check is not a guarantee —
it is a check that holds until the first concurrent request, the first missed
code path, or the first bulk import that skips the service layer.

**Warnings that never block, shown only as advisory UI.** Rejected: a warning
with no friction is a warning nobody reads. Requiring the acknowledgement to be
sent back makes the exception deliberate, and makes it a record.

**A general rules engine, tenant-configurable from the start.** Over-built for
a known, small rule set, and it would prevent any rule from being a database
constraint, since constraints cannot be conditional on tenant configuration.
The middle path taken instead: a fixed set of universal hard rules, plus
`org_rule_policies` allowing a tenant to promote specific soft codes to hard —
enforced in the domain layer, and documented as not carrying the database
backstop.

## Consequences

- Six invariants are structurally impossible to violate, whatever the
  application does.
- Coordinators keep the escape hatch real events require, and every use of it
  is recorded with its reason code and its author.
- Two enforcement mechanisms means two places to look when something is
  rejected. Mitigated by translating PostgreSQL's `23P01` exclusion violation
  into the same `Violation` shape the engine emits, so the API response is
  identical whether a rule was caught early or by the database.
- Tenant-promoted hard rules are weaker than universal ones. Stated explicitly
  in [05 — Scheduling rules](../05-scheduling-rules.md) rather than glossed.
- A rule's classification is a product decision. Reclassifying soft → hard
  later requires a migration *and* a data audit, since existing rows may
  already violate it.
