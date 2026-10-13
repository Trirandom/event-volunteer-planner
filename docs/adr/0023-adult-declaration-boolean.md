# ADR-0023 — «J'ai 18 ans ou plus» as a boolean on `participations`

**Status:** Accepted · **Date:** 2026-09-10
**Amends:** [ADR-0022](0022-no-birthdate-collected.md), which removed the
`minor_night_shift` rule along with the birthdate it depended on, and named
this boolean as the recommended route back. This is that route being taken.
Also amends [ADR-0007](0007-hard-vs-soft-scheduling-constraints.md) again: the
worked example for tenant-configurable severity returns to the minors case.
**Amended by:** [ADR-0026](0026-retention-scope-is-a-table-registry.md) —
`is_adult` moves with the other per-edition attributes onto
`participation_details`, so it is purged by row deletion rather than by being
remembered in a list of columns to null.

## Context

[ADR-0022](0022-no-birthdate-collected.md) removed `volunteers.birthdate` and,
with it, the only rule that consumed it. Its "alternatives considered" section
recorded what to do if the safeguard was ever wanted:

> Replace it with a boolean — «J'ai 18 ans ou plus» — on `participations`. […]
> it stores the answer to the question actually being asked rather than the raw
> data it is derived from, it is barely identifying, and putting it on
> `participations` means it is re-asked each event so it cannot go stale as a
> retained birthdate would.

The safeguard is wanted. Nothing about the birthdate decision changes — a date
of birth is still not collected.

## Decision

**Add `participations.is_adult boolean` (nullable), and reinstate
`minor_night_shift` as a soft rule reading it.**

Three properties follow from the shape of the field rather than from anything
the application does:

- **It is the answer, not the input.** No derivation, no age arithmetic, no
  timezone question about when a birthday lands. The stored value is what the
  volunteer said about the thing being decided.
- **It is event-tier by construction.** It lives on `participations`, so
  [ADR-0021](0021-retention-tier-follows-table.md) purges it 30 days after the
  event with everything else on that table. No entry in a retention list, no
  possibility of the list drifting.
- **It cannot go stale.** The question is asked per edition, so a volunteer who
  was 17 last September answers again this September. A retained birthdate is
  the only version of this that stays correct without being re-asked, and it is
  also the only version that keeps identifying data between events.

`NULL` means *not asked or not answered*, and the rule does not fire on it.
See the consequences below — this is the significant trade in the design.

## Alternatives considered

**Birth year.** Enough for the rule, less identifying than a full date. Still
rejected: it is data to derive the answer from, when the answer itself is one
column and one question.

**Warn on `NULL` as well as on `false`.** Superficially the safer default —
absence of data is not evidence of adulthood, and the constraint engine
elsewhere treats missing availability as *unknown* and warns
([05 §3](../05-scheduling-rules.md#3-soft-rules)). Rejected here because the
two cases differ in prevalence. Missing availability is a minority of
volunteers; a missing age answer is *every* volunteer on any form that does not
ask, so the rule would warn on every night shift in the deployment. A warning
that is always present is a warning that is never read, and it would train
coordinators to acknowledge the whole warning column by reflex — which would
degrade the nine rules that do work. Instead the rule is **visibly unarmed**
when nothing feeds it (below), which turns a silent gap into a stated one.

**Put it on `volunteers`.** Would be answered once and reused, sparing the
volunteer a question. Rejected: it is then pool-tier, retained 18 months, and
wrong within a year of being collected for exactly the people it protects.

**A `minor` boolean instead of `is_adult`.** Same information, but the form
question has to be the one a volunteer can answer plainly, and the natural
phrasing is the positive one. Storing the negation of what was asked
reintroduces a derivation step, small as it is, and inverted booleans are read
wrongly in code review.

**Make it hard by default.** Rejected: it would be encoding one jurisdiction's
labour law as universal truth. Default `warn`, promotable per organisation.

## Consequences

- The soft-rule set returns to ten rules
  ([05 §3](../05-scheduling-rules.md#3-soft-rules)).
- `events` gains `night_starts_at` / `night_ends_at` (`time`, defaulting to
  22:00 and 06:00) beside the other scheduling thresholds. Local wall-clock
  values in the event's timezone, per [16 §3](../16-i18n-and-time.md), so the
  window means the same thing across a DST boundary.
- **`org_rule_policies` recovers its motivating case.** In France, night work
  by under-18s is restricted by the Code du travail; elsewhere the same rule is
  advisory. We encode no jurisdiction: the default is `warn`, and an
  organisation that needs it absolute promotes it to `hard`. Note that
  promoted rules are enforced in the domain layer only, with no database
  backstop ([05 §3](../05-scheduling-rules.md#tenant-configurable-severity)).
- **The safeguard is only as present as the question.** An organisation that
  never adds the question gets no warnings. To keep that from being silent, the
  rule list shows `minor_night_shift` as **unarmed** when no published form
  version has a question targeting `participation.is_adult`, and the form
  editor says which rule a question feeds.
- **A required boolean must not render as a single checkbox.** An unticked box
  is indistinguishable from an unanswered one, so a checkbox would make every
  minor look like a `NULL` and the rule would never fire. It renders as an
  explicit two-option group ([09 §1](../09-volunteer-form.md#1-scope)).
- **It is a self-declaration and it is not evidence.** Nobody checks
  identity documents. It feeds a warning, not a compliance record; an operator
  who needs to demonstrate compliance to a labour inspectorate cannot do it
  with this field, and should not believe otherwise because the software has a
  column for it.
- Declared-once-per-edition granularity means a volunteer who turns 18 during
  the event is treated as they answered. A birthdate would resolve that
  precisely; that precision is what [ADR-0022](0022-no-birthdate-collected.md)
  declined to hold, and a warning a coordinator can dismiss is the right
  resolution for the ambiguity.
- No change to `EvaluationContext`: it already carries `participation` and the
  event's timezone and thresholds, so the rule is a pure addition to
  `evp-domain` with no new inputs to thread.
