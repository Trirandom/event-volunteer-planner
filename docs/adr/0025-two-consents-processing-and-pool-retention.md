# ADR-0025 — Two consent questions: processing (mandatory) and pool retention (optional)

**Status:** Accepted · **Date:** 2026-09-10
**Amends:** [ADR-0018](0018-purpose-based-retention.md) and
[ADR-0021](0021-retention-tier-follows-table.md) — both require two independent
consents; this ADR gives them a shape the schema can enforce, and replaces the
"exactly one `consent` question" publish rule that contradicted them.

## Context

[ADR-0018](0018-purpose-based-retention.md) decided that processing for *this
event* is mandatory to volunteer, and pool retention is optional and
independent — "a consent that costs you something is not freely given".
[ADR-0021](0021-retention-tier-follows-table.md) then required the pool question
to name the special categories it covers, so that Article 9(2)(a) explicit
consent is actually obtained.

The form specification followed that: [09 §1](../09-volunteer-form.md#1-scope)
describes a mandatory consent plus "a **second, optional** consent [that] asks
about pool retention".

The invariant written into the data model and the API did not. Both
[03 §3.11](../03-data-model.md#311-the-first-party-form) and
[04](../04-api.md#the-volunteer-form) required a published version to contain
**exactly one** `consent` question. As written, publish validation refuses every
form that implements the consent model the retention ADRs mandate — the
validator and the privacy design cannot both be satisfied.

The cause is that `consent` was treated as a question *kind* when the thing that
matters is the *purpose* the answer records. Two questions of the same kind mean
two different lawful bases, two different retention consequences, and two
different rules about whether the volunteer may say no.

## Decision

**A consent question declares its purpose, and the invariants are stated per
purpose rather than per kind.**

```sql
CREATE TYPE consent_purpose AS ENUM ('processing', 'pool_retention');
```

`form_questions` gains a nullable `consent_purpose`, non-NULL exactly when
`kind = 'consent'`. Each purpose may appear at most once per form version, by
partial unique index; the presence of `processing` is validated at publish,
because "at least one" is a condition on a set of rows.

| Purpose | Required to submit | Covers | Recorded on |
| --- | --- | --- | --- |
| `processing` | **Yes.** The form cannot be submitted without it | Handling the volunteer's answers to staff this event, and contacting them about it **by email and SMS** | The submission, against the version's `privacy_notice_version` |
| `pool_retention` | **No.** Refusing it must not block volunteering | Keeping the `volunteers` record — contact details, skills, T-shirt size, and **any dietary requirements or allergies** — to invite them to future events | `volunteers.pool_consent_at` / `pool_consent_version` / `pool_consent_expires` |

Rules that follow:

- **Publish is refused** unless the version has exactly one `processing`
  consent, and it is marked required. A `pool_retention` question is optional;
  if present it must **not** be marked required, which is the mechanical
  expression of "refusing it must not prevent volunteering".
- Neither may be pre-ticked, and neither renders as part of another question.
- The `processing` consent is what makes the schedule email and SMS lawful, so
  it names both channels. Per-channel opt-out afterwards
  (`notify_email`, `notify_sms`) is a preference, not a withdrawal of this
  consent, and is available without confirmation
  ([ADR-0027](0027-volunteer-self-service-rights.md)).
- The `pool_retention` question names the sensitive categories verbatim, per
  [ADR-0021](0021-retention-tier-follows-table.md). That is what makes the
  consent *explicit* rather than merely given.
- Withdrawing `pool_retention` later triggers the deletion the sweep would have
  performed. Withdrawing it does not withdraw `processing`: the event still
  happened and the roster is still evidence of it.
- A form with no `pool_retention` question is valid and means no volunteer
  reaching it consents to pool retention — so their records are anonymised at
  the event-purge boundary. Silence is never consent.

## Alternatives considered

**Keep one `consent` question covering both purposes.** Rejected, and it is the
option the old invariant implied: bundling a mandatory basis with an optional
one makes the optional half unfree, which is precisely what
[ADR-0018](0018-purpose-based-retention.md) refused. It would also make
withdrawal incoherent — withdrawing would have to mean withdrawing consent to
the event that already ran.

**Two distinct question *kinds*** (`consent` and `retention_consent`). Same
enforcement power, and rejected because it duplicates rendering, validation and
localisation for a control that is identical apart from what it records. A
purpose discriminator keeps one renderer and one accessibility treatment.

**Keep "exactly one `consent`" and put pool retention on a `boolean`
question.** Rejected: `boolean` carries no privacy-notice version, is not
covered by the never-pre-ticked rule, and would let a form mark it required —
which would make consent a condition of volunteering by accident, through a
control nobody would notice.

**Enforce "exactly one `processing` consent" by database constraint.** Not
possible for the same reason the old rule was validated at publish: it is a
condition on a *set* of rows. At most one per purpose is a partial unique index
and is enforced structurally, including across drafts.

**Ask for pool retention after the event instead, by email.** Considered in
[ADR-0020](0020-retention-periods-are-configuration.md) and rejected there; the
reasoning is unchanged — it needs an extra mail cycle and gives
silence-means-deletion semantics to people who simply did not read their email.

## Consequences

- The publish validator and the privacy design agree, so a compliant form can
  actually be published.
- The two consents are separately versioned and separately withdrawable, and
  the difference is visible in the schema rather than living in prose.
- The form editor must show which retention consequence each consent question
  carries, in the same way it names the rule a question arms
  ([ADR-0023](0023-adult-declaration-boolean.md)).
- One more enum, one more nullable column, two partial unique indexes.
- A coordinator can build a form that collects no pool consent at all. That is a
  legitimate configuration — a one-off event — and it means the pool does not
  grow from that form. Stated in the editor rather than discovered at the sweep.
