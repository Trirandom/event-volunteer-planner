# ADR-0022 — Birthdate is not collected; the minor night-shift rule is removed

**Status:** Accepted · **Date:** 2026-09-10
**Amended by:** [ADR-0023](0023-adult-declaration-boolean.md) — the boolean this
ADR recommends in its alternatives has been adopted, so `minor_night_shift` is
back as a soft rule. **Birthdate is still not collected**; that part stands.
**Amends:** [ADR-0021](0021-retention-tier-follows-table.md), which had retained
`volunteers.birthdate` as a pool-tier attribute, and
[ADR-0007](0007-hard-vs-soft-scheduling-constraints.md), whose worked example
for tenant-configurable rule severity was `minor_night_shift`.

## Context

`volunteers.birthdate` existed for exactly one purpose: the `minor_night_shift`
soft rule, which warned when a volunteer under 18 was assigned between 22:00
and 06:00.

[ADR-0021](0021-retention-tier-follows-table.md) reclassified it as pool-tier,
so it would be retained for 18 months rather than purged monthly. That prompted
the question of whether it was needed at all — a date of birth is a strongly
identifying attribute, and a full date is far more than the rule required. The
answer from the data controller was that it is not needed.

Under Article 5(1)(c), data that is not necessary should not be collected. A
field kept because it *might* be useful, for a rule nobody asked to enforce, is
the clearest case of that.

## Decision

**`volunteers.birthdate` is removed from the schema, and the
`minor_night_shift` rule is removed from the constraint engine.**

The form loses its birthdate question. `date` remains among the question types
— it is a generic capability, now illustrated by an arrival date rather than a
birthdate.

Two consequential edits:

- **Reconciliation** loses birthdate as a corroborating field
  ([08 §6](../08-volunteer-intake.md#6-identity-reconciliation)). Step 3 now
  corroborates on `last_name` or phone. This costs little, because
  [ADR-0012](0012-name-parts-asked-not-parsed.md) had already established
  `last_name` as the more reliable corroborator — a form always asks for a
  surname, while birthdate was frequently skipped.
- **`org_rule_policies` keeps its rationale but changes its worked example.**
  It existed because `minor_night_shift` is legally binding in some
  jurisdictions and merely advisory in others, so severity had to be a per-org
  setting. That motivation is intact for other rules: an organisation may
  reasonably want `skill_missing` promoted to **hard** for a first-aid post, so
  nobody without a valid PSC1 can be assigned there. That is the example now
  documented, and it is closer to how these events actually operate.

## Alternatives considered

**Keep birthdate, keep the rule.** Rejected: not needed, and a full date of
birth is a disproportionate thing to hold for a volunteer roster.

**Replace the date with a birth *year*.** Sufficient for the rule and much less
identifying. Rejected because the rule itself is not wanted — a year would be
minimising an unnecessary field rather than removing it.

**Replace it with a boolean — «J'ai 18 ans ou plus» — on `participations`.**
The most interesting option, and the one to revisit if the safeguard is ever
wanted: it stores the answer to the question actually being asked rather than
the raw data it is derived from, it is barely identifying, and putting it on
`participations` means it is re-asked each event so it cannot go stale as a
retained birthdate would. Not adopted now because no minor-related safeguard
was requested, and adding an unrequested field would repeat the mistake this
ADR corrects. **This is the recommended route if it comes back.**

**Keep the rule, deriving age from something else.** Nothing else in the schema
implies age, and inferring it would be worse than asking.

## Consequences

- One fewer personal field, and the most identifying of the remaining ones is
  gone. The consent text shortens accordingly.
- The soft-rule set drops from ten rules to nine.
- No safeguard against scheduling a young volunteer on a night shift. That is
  now a matter for the coordinator's judgement, as it was in the spreadsheet.
  If the association later takes on under-18 volunteers at scale, the boolean
  option above is the way back, and it needs a new ADR rather than a quiet
  schema change.
- `date` survives as a question type with no current use in the default form.
  Kept deliberately: removing a generic capability to reflect one deployment's
  current questions would be the wrong trade.
