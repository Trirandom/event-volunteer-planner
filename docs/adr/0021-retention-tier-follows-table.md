# ADR-0021 — Retention tier follows the table; explicit consent covers dietary data

**Status:** Accepted · **Date:** 2026-09-10
**Amended by:** [ADR-0022](0022-no-birthdate-collected.md) — `birthdate` is no
longer collected at all, so it is neither tier. The consent wording quoted below
still names a date of birth for that reason; the current text is
[15 §4](../15-privacy-and-retention.md#4-consent).
**Amended by:** [ADR-0025](0025-two-consents-processing-and-pool-retention.md) —
the two consents this ADR relies on are declared by purpose on the question, and
the "exactly one consent question" publish rule it left in place is replaced.
**Amended by:** [ADR-0026](0026-retention-scope-is-a-table-registry.md) —
tier-follows-table stands and is made derivable: per-edition attributes move off
`participations` into `participation_details`, every table declares its tier in
the schema, and the enforcement property below ("no row in `participations` or
its dependents survives") is corrected, since as written it deleted the
assignment and roster history this ADR meant to keep.
**Amends:** [ADR-0018](0018-purpose-based-retention.md) and
[ADR-0020](0020-retention-periods-are-configuration.md) — the tiers and periods
stand; which columns sit in which tier is corrected, and the consent basis for
dietary data is made explicit.

## Context

[ADR-0018](0018-purpose-based-retention.md) put "event data" in the 30-day
purge and "pool data" behind consent, then listed the columns each contained.
That list classified `volunteers.birthdate`, `volunteers.tshirt_size` and
`volunteers.dietary` as event data, to be nulled 30 days after every event.

That was wrong, and it contradicted the schema this project already had.
[03 §1](../03-data-model.md#the-three-identity-concepts) states the design
intent plainly: *"Stable facts (name, phone, allergies) live on `volunteers`.
Per-edition facts live on `participations`."* The retention rule then swept
columns from `volunteers` as though they were per-edition.

The operational consequence made it obvious. The association runs **one large
event plus one or two smaller ones each year**, and the same information serves
all of them. A T-shirt size does not change between March and September. A
birthdate never changes. "Vegetarian" does not lapse. Re-asking three hundred
people for the same three facts three times a year is worse for everybody: more
forms, lower response rates, and *more* copies of the data in circulation
rather than fewer.

## Decision

**Retention tier follows the table.**

| Table | Tier |
| --- | --- |
| `volunteers`, `volunteer_skills` | **Pool** — retained with consent, deleted at expiry |
| `participations` and everything referencing it — `availability_windows`, `assignments`, `submissions`, tokens | **Event** — purged after `event_data_days` |

This is not a new classification to maintain; it is the classification the
schema already encodes. The two tables exist *precisely* to separate stable
person facts from per-edition facts, so deriving the retention tier from the
table means the rule cannot drift from the data model — and a column added to
`participations` lands in the event tier automatically, with no list to update.

`tshirt_size` demonstrates why this works: it appears on **both** tables, the
stable value on `volunteers` and a per-event override on `participations`. Tier
follows table, so the override purges and the stable value persists, which is
exactly right and would have needed a special case under a column list.

What this changes concretely: the 30-day sweep **no longer touches
`volunteers`** for a volunteer who consented to pool retention. Their record —
including birthdate, T-shirt size, dietary requirements and coordinator notes —
survives until `pool_consent_expires`, then is deleted outright. Non-consenting
volunteers are anonymised at 30 days exactly as before, so the default is still
deletion.

**Raw submissions remain event-tier and are still redacted at 30 days.** The
structured `dietary` value that catering actually needs is kept; the verbatim
form response containing it, alongside everything else the person typed, is
not. That is the minimising choice, and it means mapping replay
([08 §2](../08-volunteer-intake.md#2-design-a-staged-replayable-pipeline)) is
only available shortly after import — which is when it is needed.

### Dietary data needs *explicit* consent

`volunteers.dietary` is free text and may contain data revealing religion
("halal", "kosher") or health ("coeliac", "nut allergy"). Under GDPR Article 9
such special-category data is prohibited from processing unless an Article 9(2)
exception applies, and the applicable one here is **9(2)(a), explicit
consent** — a higher bar than the ordinary consent that covers a name and a
phone number.

So the pool-retention question **names the sensitive categories rather than
saying "your details"**:

> ☐ Je souhaite faire partie de l'équipe pour les prochains événements.
> We keep your name, contact details, skills, T-shirt size, date of birth and
> **any dietary requirements or allergies you told us** so we do not have to ask
> again. You can withdraw at any time; we delete everything after 18 months
> without contact.

Naming the data is what makes the consent explicit, and it costs one sentence.

One further point that follows from retaining `volunteers.notes`: **coordinator
notes about a volunteer are visible to that volunteer** in their data export
under the right of access. They should be written on that assumption. This is
not a new obligation — it was always true — but retaining them for 18 months
makes it likelier to matter.

## Alternatives considered

**Keep the original classification** and re-ask each event. Rejected: it
contradicts the schema, and it is worse for volunteers and coordinators alike
for the reasons above.

**Move the stable attributes onto `participations` instead**, making the
original retention rule correct. Rejected: it would duplicate a T-shirt size
per event, lose the pool's usefulness, and invert the model described in
[03](../03-data-model.md) for no benefit.

**A separate consent just for dietary data.** More minimising, and genuinely
arguable: someone might want to be on the list without their allergy on file.
Rejected as disproportionate for now — catering needs it at every event, so a
volunteer who withholds it will be asked again each time, which is the outcome
this decision exists to avoid. Revisit if volunteers actually ask.

**Keep dietary data but with a shorter fuse** than the rest of the pool record
— say 6 months. Rejected as arbitrary: either the purpose (catering our events)
justifies retention or it does not, and it does not expire faster than the
purpose does.

**Retain a column-level classification list**, corrected. Rejected in favour of
tier-follows-table: a hand-maintained list is a thing to forget, and the sweep
silently missing a column is a failure with no symptom.

## Consequences

- A returning volunteer is asked once, not once per event — the point of having
  a pool.
- The retention rule and the data model can no longer disagree, because one is
  derived from the other.
- More data survives the 30-day sweep for consenting volunteers than
  [ADR-0018](0018-purpose-based-retention.md) implied. That is a deliberate
  relaxation of the original "delete everything after one month" requirement,
  made by the data controller, and the non-consenting default is unchanged.
- The consent text is longer and names sensitive categories. That is the
  requirement, not a cost.
- `pool_consent_expires` now gates deletion of health-adjacent data, so the
  expiry sweep matters more than before and its last-successful-run metric
  is correspondingly more important.
- The enforcement test changes shape: instead of asserting a list of columns is
  empty, it asserts that **no row in `participations` or its dependents survives**
  the sweep, and that `volunteers` rows survive if and only if consent is valid
  and unexpired. That is a stronger property and a simpler test.
