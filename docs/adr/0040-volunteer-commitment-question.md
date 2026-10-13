# ADR-0040 — A built-in volunteer-commitment question

**Status:** Accepted · **Date:** 2026-09-30
**Amends:** [09 §1](../09-volunteer-form.md#1-scope) (the built-in table and
the seeded questions), docs/04 §"The volunteer form" and docs/03 §3.11
(`consent_purpose` gains a value). Leaves
[ADR-0025](0025-two-consents-processing-and-pool-retention.md) as it is.

## Context

The organisations running events on the planner are associations, and the
people staffing them are volunteers. An association needs each of them to
say, in so many words, that they take part **unpaid, on the association's
behalf, within the missions they are given**. Without that declaration, a
person who worked a bar shift on a signed-up basis is harder to tell apart
from someone the association employed, and the association has nothing on
file that says otherwise.

Z·est Radio asked for exactly this statement on every form:

> Je confirme participer bénévolement à l'organisation de cet événement pour
> le compte de l'association Z·est Radio, dans le cadre des missions qui me
> sont confiées.
>
> ☑ Je confirme mon engagement bénévole auprès de Z·est Radio pour cet
> événement.

A custom required `boolean` could ask it, but a coordinator could remove it or
make it optional, and nothing would record which answer it was. A declaration
that holds only while nobody edits the form is not one an association can rely
on.

## Decision

**A third `consent_purpose`, `commitment`: required, exactly one per
published version, not removable.** It sits beside `processing` in every rule
that makes `processing` mandatory:

- **Publish** refuses a version without one (`commitment_missing`) or with an
  optional one (`commitment_optional`). `form_one_consent_per_purpose` already
  refuses a second.
- **A submission** must tick it, whatever the stored `is_required` says
  (`consent_required`, the code the `processing` consent already uses).
- **New forms are seeded with it**, just before the `processing` consent, and
  the admin builder locks it as required and offers it from the palette if it
  is missing.
- **It names the organisation.** The wording is the text above, with the
  organisation's name written in when the question is created, in French and
  in English. From then on it is a label like any other, and the coordinator
  may reword it. A later rename of the organisation does not rewrite
  questions volunteers have already answered.

It is a `consent` *kind* because that is the control it needs: a single
checkbox that must be ticked and is never pre-ticked. It is **not** a lawful
basis for processing. ADR-0025's two consents still decide what happens to
the data, and nothing reads `commitment` for retention.

## Alternatives considered

- **A required `boolean`.** Removable, can be made optional, and
  indistinguishable from any other yes/no. Rejected for the reason in the
  context.
- **Hard-coded in the form bundle.** Not stored, invisible to coordinators and
  to the server's submission check, and it would hard-code one association's
  name into a multi-tenant product.
- **A placeholder (`{organization}`) resolved at render time.** Would follow a
  rename, but then a stored version no longer says what the volunteer saw.
  That breaks the rule that a version is immutable (09 §2).

## Consequences

- A form created before this ADR cannot publish a new version until the
  commitment is added. The builder's palette offers it first among the
  missing built-ins. Versions already live are untouched and keep accepting
  submissions.
- `consent_purpose` gains a value by `ALTER TYPE … ADD VALUE`. PostgreSQL
  cannot drop an enum value, so the down migration rebuilds the type and
  fails while any question still uses it.
- The submissions page and exports have not yet been told about the new
  purpose. When they show consents, a ticked commitment belongs with them.
