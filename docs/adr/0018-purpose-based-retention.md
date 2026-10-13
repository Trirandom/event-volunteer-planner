# ADR-0018 — Purpose-based retention: event data purged after one month, pool data by consent

**Status:** Accepted · **Date:** 2026-09-10
**Amended by:** [ADR-0021](0021-retention-tier-follows-table.md) — retention tier
now follows the table, so stable person attributes on `volunteers` (birthdate,
T-shirt size, dietary) are pool-tier rather than event-tier.
**Amended by:** [ADR-0020](0020-retention-periods-are-configuration.md) — the
tier model stands; the pool expiry becomes per-organisation configuration,
defaulting to 18 rather than 24 months, and the legal framing is corrected
(GDPR specifies no numeric maximum).
**Amended by:** [ADR-0025](0025-two-consents-processing-and-pool-retention.md) —
the two independent consents required below are given a shape the schema
enforces: a consent question declares its purpose.
**Amended by:** [ADR-0026](0026-retention-scope-is-a-table-registry.md) — the
tiers stand; the sweep's scope becomes a table-level registry, the purge deletes
rows rather than nulling columns, and the "data dictionary" verification below is
replaced.
**Supersedes** the retention rule previously stated in
[01 §6](../01-product-spec.md#6-privacy) ("volunteer records are flagged for
review 24 months after their last event participation").

## Context

Two requirements were set: a volunteer must be able to have their data removed
at any time, and personal data must be deleted one month after the event.

The second, taken literally, destroys a feature the design is built around. The
separation of `volunteers` from `participations` exists precisely so the
**volunteer pool carries across editions** — next year's event starts from
people who already helped, with their skills and sizes known. Deleting all
personal data a month after each event returns the coordinator to retyping
three hundred people annually, which is one of the things this project exists
to stop.

Meanwhile the retention rule already in the documentation was not defensible.
"Flagged for review after 24 months" is not a lawful basis: it is indefinite
retention contingent on somebody noticing a flag, which is the specific
practice data-protection regulators object to. It also had no mechanism, no
gate, and no test.

## Decision

Retention is by **purpose**, not by table. Three tiers:

| Tier | Purpose | Retention |
| --- | --- | --- |
| **Event data** | Staffing this event | Deleted one month after the event ends. Automated, unconditional, no opt-out. |
| **Pool data** | Being invited to future events | Retained **only with explicit, separate consent**, which expires 24 months after last contact. Without consent, deleted at the same one-month boundary. |
| **Pseudonymised** | Accountability and statistics | Retained. Holds no personal data once the above has run. |

This satisfies both requirements without losing the pool, because it identifies
what the literal reading actually conflicted with: not *retention*, but
retention **without a purpose**. Keeping a name to invite someone next year is a
different purpose from staffing this year's bar, and consent is the basis for
it.

Supporting decisions:

- **Two independent consents.** Processing for this event is mandatory to
  volunteer; pool retention is optional and refusing it must not prevent
  volunteering. A consent that costs you something is not freely given.
- **Consent expires and deletes.** No review flags. Expiry runs the same
  anonymisation the sweep does.
- **Erasure needs two proofs of control.** The self-service path is the
  volunteer's existing form token link, but because a capability URL is
  forwardable, it only *initiates* deletion — a confirmation sent to the address
  on record executes it. Holding the link and receiving mail at the recorded
  address are two independent proofs, and deletion is irreversible.
- **The sweep is tested for emptiness.** A test asserts that every column
  classified as personal in the data dictionary returns nothing for a swept
  event. A retention job that silently stops working has an invisible symptom —
  data that is still there — so it must be verified, not assumed.
- **Backups are in scope.** Restoring a backup resurrects erased volunteers, so
  the restore runbook re-runs the sweep as its first step and backup retention
  is capped at 30 days.

## Alternatives considered

**Literal reading: delete everything one month after the event.** Rejected: it
removes the pool, which is a primary feature. It is also more than the
regulation requires — consented retention for a stated purpose is lawful.

**Keep the pool indefinitely with a review flag** (the previous rule).
Rejected: not a lawful basis, no mechanism, no test, and it degrades into
permanent retention.

**Legitimate interest as the basis for pool retention**, avoiding a consent
question. Arguable for an association contacting past volunteers, and rejected
as the primary basis: it requires a balancing assessment the operator would
have to write and defend, and consent is both clearer to the volunteer and
simpler to implement. An operator who prefers legitimate interest can document
it; the software's default is consent.

**Anonymise rather than delete, everywhere.** Rejected as a blanket answer:
anonymisation is right where referential integrity matters (audit entries,
assignment history) and wrong as a substitute for deleting a dietary note,
which should simply be gone.

**Hard-delete volunteer rows.** Rejected: it breaks roster versions and audit
references, and destroys accountability for who scheduled whom. Nulling
personal fields with an opaque stable label achieves erasure while keeping
history coherent.

## Consequences

- Both stated requirements are met, and the cross-edition pool survives.
- The form's "keep my details for next time" checkbox becomes meaningful rather
  than decorative, and gains a real consequence.
- A volunteer who declines pool retention is deleted a month after the event and
  will need to re-enter their details next year. That is their choice, correctly
  represented.
- New personal columns must be classified in the data dictionary or CI fails —
  otherwise the sweep silently misses them, which is the failure mode with no
  symptom.
- A scheduled sweeper is new operational surface: it needs a last-successful-run
  metric and an alert, since a stalled sweeper is a compliance failure that
  produces no error.
- Anonymisation must redact `submissions.raw`, the largest concentration of
  personal data in the schema, without breaking replay coherence — hence a
  structural placeholder rather than a deletion.
