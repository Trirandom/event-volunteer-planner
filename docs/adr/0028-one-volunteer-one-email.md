# ADR-0028 — One volunteer, one email address per organisation

**Status:** Accepted · **Date:** 2026-09-10
**Amends:** [ADR-0009](0009-form-agnostic-intake-pipeline.md) — the
reconciliation ladder is unchanged; what changes is the documented outcome when
two people claim the same address.

## Context

The schema has always said this: `volunteers_email_unique_per_org UNIQUE
(org_id, email)` in [03 §3.3](../03-data-model.md#33-the-volunteer-pool).

The intake failure catalogue said something else.
[08 §11](../08-volunteer-intake.md#11-failure-catalogue) listed "two volunteers
share an email address (a couple)" as a supported case: "exact-email match wins
for the first; the second is a review item. Documented limitation." It is not a
limitation, it is an impossibility — resolving that review item by creating a
second volunteer raises a unique violation, so the documented behaviour cannot
happen and the coordinator meets a constraint error instead of the queue entry
they were promised.

The case is real. Couples do share an address, and the previous system tolerated
it because identity there was a name string.

## Decision

**An email address identifies at most one volunteer within an organisation.**
The constraint stands, and the pipeline is made honest about it.

- A submission whose email matches an existing volunteer is a **revision of
  that volunteer**, never the creation of a second one
  ([08 §6](../08-volunteer-intake.md#6-identity-reconciliation) step 2).
- A submission that claims an existing address **while asserting a different
  person** — the name does not corroborate — enters `needs_review` with the
  conflict named: *this address already belongs to another volunteer*. The
  coordinator either confirms it is the same person, or gives the new volunteer
  their own address, or records them with **no** address at all.
- A volunteer with no email address is fully supported and always was: `email`
  is nullable, the pool "works for people who have no email address"
  ([01 §3](../01-product-spec.md#3-personas)), and the unique constraint permits
  any number of NULLs. What such a volunteer loses is the things that are
  delivered by email — a token link, a schedule mail, an ICS URL, and
  self-service rights ([ADR-0027](0027-volunteer-self-service-rights.md)) — so
  a coordinator enters and maintains their data.
- The public form therefore requires an email, and the second member of a couple
  who submits on the same address is refused with an explanation rather than
  queued: *that address is already in use; ask the organisation to add you*.
  The response does not confirm **whose** address it is
  ([12 §5](../12-security.md#error-responses)).

## Alternatives considered

**Drop the unique constraint and allow shared addresses.** Rejected. Email is
the corroborating identity on the public route, the delivery address for the
capability links, and the two-proof channel for erasure
([ADR-0027](0027-volunteer-self-service-rights.md)). If two volunteers share it,
a form token emailed to one reaches the other, an erasure confirmation could
delete the wrong record, and step 2 of the reconciliation ladder becomes
ambiguous — turning the strongest signal in the ladder into a guess.

**Keep it unique but auto-create the second person with `email = NULL`.**
Rejected: it silently discards the one identifier the volunteer supplied, and
produces a record that cannot receive anything, without anyone deciding that.
The review queue exists precisely so a human makes that call.

**Sub-addressing** (`name+alice@`, `name+bob@`). Rejected as a suggestion the
software makes: it depends on the provider, it is opaque to the volunteers, and
[08 §6](../08-volunteer-intake.md#6-identity-reconciliation) deliberately does
*not* treat plus-addresses as equivalent, so relying on them here would
contradict that.

**A household or contact-group concept.** The thorough answer, and rejected as
disproportionate for the reasons ADR-0011 rejected structured name parts: it is a
volunteer roster of a few hundred people, and the output is a shift sheet.

## Consequences

- Step 2 of the ladder is exact and unambiguous, which is what makes token-less
  submissions tractable at all.
- One documented case in [08 §11](../08-volunteer-intake.md#11-failure-catalogue)
  changes from "supported with a limitation" to "refused with an explanation",
  which is the behaviour that actually occurs.
- A couple sharing an inbox needs one of them recorded without an address, and
  that person is served by a coordinator rather than by self-service. This is a
  genuine and accepted narrowing, and it is visible in the pool list rather than
  discovered when a link does not arrive.
- The public form's error message is a small enumeration surface, so it says
  that the address is in use without saying anything about who holds it.
