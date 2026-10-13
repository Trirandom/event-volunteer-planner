# 05 — Scheduling rules

This is the part that justifies the project. A spreadsheet stores a schedule;
this application knows whether the schedule is *possible*.

## 1. Hard versus soft

Every rule is classified as **hard** or **soft**, and the classification is a
product decision, not a technical one.

- **Hard** — represents a physical or logical impossibility. Cannot be
  overridden by anyone. Enforced by a database constraint, so it holds even
  against a bug, a direct SQL session, or a future endpoint nobody thought
  about.
- **Soft** — represents a policy, a preference, or a risk. Blocks the write
  *by default*, but a coordinator can proceed by explicitly acknowledging it.
  The acknowledgement is recorded on the assignment.

The temptation is to make everything hard, because every rule feels important
while writing it. That produces a tool that coordinators fight at 2 a.m. when
someone has not shown up and the bar needs covering. Real events are full of
justified exceptions; a planner that cannot express them gets abandoned for a
spreadsheet, which is where this started. So: hard means *impossible*, not
*undesirable*.

### Prior art on this exact split

The spreadsheet already enforced eligibility hard, per cell: a name outside the
computed list was rejected outright (`setAllowInvalid(false)`). What it could
not enforce was *non-overlap*, because that depends on other cells' current
values and a validation range cannot see them
([10 §2](10-prior-art-spreadsheet.md#2-the-actual-flaw)).

So the classification below is not theoretical. It inverts what the previous
system could do: it makes the one rule that was impossible (`double_booked`)
into the strongest guarantee in the schema, and relaxes the rules that were
enforced too rigidly (skills, availability) into warnings a coordinator can
override — because in the spreadsheet, an over-strict eligibility list was
routinely worked around by editing the list.

## 2. Hard rules

Six rules, and every one of them has a mechanism in
[03 — Data model](03-data-model.md). Four are declarative constraints; two have
to read another row, which in PostgreSQL means a constraint trigger. Nothing
here is enforced only in application code.

| Code | Rule | Enforced by |
| --- | --- | --- |
| `double_booked` | A volunteer cannot hold two overlapping assignments — across all events, not just this one | `EXCLUDE USING gist (volunteer_id WITH =, period WITH &&)` on `assignments` ([03 §3.6](03-data-model.md#36-assignments--where-the-invariants-live)) |
| `duplicate_assignment` | A volunteer cannot be assigned twice to the same shift | Partial unique index on `(shift_id, volunteer_id)` |
| `cross_tenant` | An assignment cannot reference a shift or volunteer from another organisation | Composite foreign keys carrying `org_id`, plus RLS |
| `shift_outside_event` | A shift cannot fall outside its event's period | Constraint trigger, both directions — moving the shift *and* shrinking the event ([03 §3.4](03-data-model.md#34-events-locations-shifts)) |
| `unknown_participation` | A volunteer must be enrolled in the event before being assigned | Foreign key `(participation_id, volunteer_id)` |
| `withdrawn_participant` | A withdrawn or declined participant cannot hold an assignment | Constraint trigger, both directions — assigning them *and* withdrawing someone already rostered ([03 §3.6](03-data-model.md#36-assignments--where-the-invariants-live)) |

The last two are triggers rather than `CHECK` constraints for the same reason:
the value they compare against lives on a different row, and a `CHECK`
expression cannot leave its own. They raise `23514` with a named constraint, so
the API maps them into the same `violations` shape as the rest and a client
cannot tell which mechanism caught it.

Supporting constraints exist alongside these — a shift's period is non-empty
and at most 24 hours, an assignment's period is trigger-synced from its shift,
availability windows cannot self-overlap, roster versions are unique per
event — but they are structural hygiene rather than scheduling rules, and they
are not part of the six.

Note the scope of `double_booked`: it is deployment-wide per volunteer, so a
volunteer enrolled in two overlapping events of the same organisation cannot be
booked in both. That falls out of the exclusion constraint being on
`volunteer_id` rather than on `(event_id, volunteer_id)`, and it is
intentional — a person is in one place at a time regardless of which event
believes it has them.

## 3. Soft rules

| Code | Rule | Default | Rationale for softness |
| --- | --- | --- | --- |
| `skill_missing` | The volunteer lacks a skill the shift requires | warn | The lead on shift may vouch for them; requirements are often aspirational. The spreadsheet enforced this hard, and coordinators bypassed it by editing the eligibility list — which is the definition of a rule that should be soft |
| `skill_expired` | The volunteer holds the skill but it lapsed before the shift starts | warn | Renewal paperwork lags reality; coordinator decides |
| `outside_availability` | The shift is not covered by a declared `available` window | warn | Many volunteers never return the form; absence of data is not unavailability |
| `declared_unavailable` | The shift overlaps a declared `unavailable` window | warn (prominent) | The volunteer may have changed their mind by phone since submitting the form |
| `over_capacity` | The shift already has `max_count` assignments | warn | Deliberate over-staffing before a peak is normal |
| `insufficient_rest` | Less than `min_rest_minutes` since the volunteer's previous shift ends | warn | Short turnarounds happen and are the coordinator's call |
| `over_daily_hours` | Total assigned hours that day exceed `max_hours_per_day` | warn | Same |
| `over_consecutive_days` | More consecutive working days than `max_consecutive_days` | warn | Same |
| `outside_stay` | The shift falls outside the volunteer's declared arrival/departure | warn | Travel plans change |
| `minor_night_shift` | The volunteer declared they are under 18 and the shift overlaps the event's night window | warn | Restricted by law in some jurisdictions, advisory in others — so it is a default, not a universal truth ([ADR-0023](adr/0023-adult-declaration-boolean.md)) |

### On `minor_night_shift`

Its input is `participations.is_adult` — a boolean answering «J'ai 18 ans ou
plus», declared per edition. Not a birthdate: none is collected
([ADR-0022](adr/0022-no-birthdate-collected.md),
[ADR-0023](adr/0023-adult-declaration-boolean.md)). The night window is
`events.night_starts_at` / `night_ends_at`, local wall-clock times defaulting
to 22:00–06:00, so it wraps midnight and survives DST like every other
wall-clock pattern here ([§5](#5-timezones-and-days)).

Two properties of this rule are deliberate and easy to get wrong later:

- **`NULL` does not warn.** Only an explicit `false` does. Everywhere else in
  this engine, missing data warns — `outside_availability` exists precisely
  because absence of an answer is not an answer. The difference is prevalence:
  a form that never asks the age question leaves *every* participation `NULL`,
  so warning on `NULL` would warn on every night shift in the deployment and
  teach coordinators to clear the warning column without reading it.
- **So the rule reports itself as unarmed.** When no published form version has
  a question targeting `participation.is_adult`, the organisation's rule list
  shows `minor_night_shift` as **unarmed**, and the form editor names the rule
  a question feeds. A safeguard that depends on a question nobody added must
  say so rather than appear to be working.

It is a self-declaration, unverified. It feeds a warning; it is not evidence of
compliance with anything.

### Tenant-configurable severity

Some rules are policy rather than physics, and the right severity differs by
organisation. So severity is a per-organisation setting that can turn a soft
rule off, or promote it to hard — the `org_rule_policies` table in
[03 §3.8](03-data-model.md#38-policy-and-delegation).

The motivating case is `minor_night_shift`. In France, night work by under-18s
is restricted by the Code du travail; in other jurisdictions the same rule is
advisory. Encoding either as the universal default would be wrong, so the
default is `warn` and an organisation that needs it absolute promotes it to
`hard` — after which no volunteer who declared they are under 18 can be
assigned to a night shift, with no acknowledgement available.

The same mechanism covers safety-critical posts: an organisation may want
nobody without a valid PSC1 assignable to first aid, which is `skill_missing`
promoted to `hard`. And it runs the other way — an organisation whose
volunteers never return the form can set `outside_availability` to `off` rather
than acknowledge it a hundred times.

Promotion is enforced in the domain layer rather than by a database constraint,
since the rule set is per tenant. **This is a documented weakening**:
tenant-configurable hard rules do not get the database backstop that the six
universal ones do ([§2](#2-hard-rules)), so they hold only as long as every
write goes through the domain service. They are a strong default, not a
guarantee.

## 4. Evaluation

The engine is a pure function in `evp-domain`. It has no database access; it is
given everything it needs.

```rust
pub struct EvaluationContext<'a> {
    pub event: &'a Event,                       // carries timezone + policy thresholds
    pub shift: &'a Shift,
    pub requirements: &'a [SkillRequirement],
    pub participation: &'a Participation,
    pub volunteer_skills: &'a [VolunteerSkill],
    pub availability: &'a [AvailabilityWindow],
    pub existing_assignments: &'a [AssignmentSummary], // this volunteer, see below
    pub current_fill: u16,
    pub policies: &'a RulePolicies,
    pub now: jiff::Timestamp,
}

pub struct Violation {
    pub code: RuleCode,
    pub severity: Severity,       // Hard | Warn
    pub message: String,
    pub context: ViolationContext, // structured, for UI rendering
}

pub fn evaluate(ctx: &EvaluationContext<'_>) -> Vec<Violation>;
```

Being pure buys three things: the whole rule set is unit-testable without a
database, `/check` and the write path provably run identical logic, and the
same code can later be compiled to WebAssembly for client-side pre-validation
if hover latency ever matters.

`participation` carries the volunteer's per-edition declarations, including
`is_adult` — in the database those live on `participation_details`
([03 §3.5](03-data-model.md#35-participation-and-availability)), loaded with the
participation and presented to the engine as one value. A purged edition has no
details row, so the declaration reads as `NULL` and the rule does not fire,
which is the same behaviour as never having asked.

`now` is a `jiff::Timestamp`, per [ADR-0019](adr/0019-time-discipline.md);
day-bucketing converts it into the event's zone rather than doing arithmetic on
the instant ([§5](#5-timezones-and-days)).

**The window on `existing_assignments` is derived, not fixed.** It has to cover
the longest reach of any rule that looks at neighbouring shifts:

```
[ shift.start - (max_consecutive_days + 1) days ,
  shift.end   + (max_consecutive_days + 1) days ]
```

with a floor of 72 hours. A fixed `±72h` — which this document previously
specified — is enough for `insufficient_rest` and `over_daily_hours`, and
silently too narrow for `over_consecutive_days`: at the default
`max_consecutive_days = 5` the rule needs six days of history on each side to
see a run at all, so it could never have fired. The window is computed from the
event's own policy for that reason, and the test for the rule uses a run longer
than three days precisely so that a regression to a constant fails.

### Order of operations for a write

```
BEGIN
  SET LOCAL app.current_org_id = …
  load context (single query with joins, FOR UPDATE on the shift row)
  violations = evaluate(ctx)
  if any violation is Hard                              → 422, ROLLBACK
  if any Warn code not in acknowledge_warnings          → 422, ROLLBACK
  INSERT assignment (acknowledged_warnings = …)
  -- the exclusion constraint is the final arbiter and may still fire here,
  -- if a concurrent transaction committed between the load and the insert
  INSERT audit_log
COMMIT
```

The `FOR UPDATE` on the shift row serialises concurrent assignments to the same
shift, which is what makes `current_fill` trustworthy. The exclusion constraint
still backstops the volunteer-overlap case, because that spans shifts and
cannot be covered by a single row lock. A `23P01` (exclusion violation) from
the driver is translated into the same `double_booked` violation shape the
engine produces, so the client cannot tell whether it was caught early or late.

## 5. Timezones and days

"Hours per day" and "consecutive days" require a definition of *day*, and it
is the calendar day in the **event's** timezone — not UTC, and not the
coordinator's browser.

A shift running 22:00–02:00 spans two local days. Hours are apportioned to each:
2 hours to the first, 2 to the second. Splitting rather than attributing the
whole shift to its start date matters for overnight-heavy events, where
attributing by start date lets someone work 20 hours across a "day" boundary
without tripping the cap.

DST is handled by doing all day-bucketing on local wall-clock values converted
from the stored instants. On a spring-forward day, a 23-hour local day is
correct and the hour cap should see 23 hours of available time, not 24.

## 6. Slot granularity is not a rule

Shifts are not all the same length, and nothing here assumes they are. Most
missions run on 2-hour slots; *artiste* runs on `45 / 45 / 90 / 45 / 45`. That
division is described by a **shift pattern**, which is a generator: it produces
shifts and is then done ([ADR-0029](adr/0029-shift-patterns-are-generators-not-constraints.md),
[03 §3.4](03-data-model.md#34-events-locations-shifts)).

**There is no rule code for it, and there will not be one.** Alignment to a
pattern is not a hard rule — an unaligned shift is possible and ordinary — and
it is not a soft rule either, because a warning that fires on every
hand-adjusted shift is a warning coordinators learn to dismiss, and that habit
transfers to `double_booked`. The soft rules in [§3](#3-soft-rules) are worth
reading only for as long as none of them is noise.

Three places in the engine have to be right about uneven slots, and each has a
test for it:

- **`over_daily_hours`** sums real durations, never a count of slots. Six
  45-minute slots is 4.5 hours, and hours are `Decimal` throughout
  ([11 §2](11-engineering-standards.md#types)).
- **`insufficient_rest`** measures from the previous shift's `upper(period)`,
  which for a 45-minute slot is not on the hour. A rest calculation that rounds
  to the slot grid is the bug this note exists to prevent.
- **`outside_availability`** tests containment against declared windows, so a
  shift ending at 09:45 needs a volunteer able to *say* 09:45. That is why the
  event's `availability_step_minutes` must divide every segment duration of
  every pattern the event uses, and why attaching a pattern that breaks it is
  refused at attach time rather than warned about at assignment time
  ([09 §3](09-volunteer-form.md#3-the-availability-picker)).

The third is the only one that constrains configuration, and it constrains the
*picker*, not the shift: the remedy is always to lower the step, never to round
the slot.

## 7. What is not being built

No automatic assignment. No solver, no optimiser, no "fill the gaps for me"
button.

It is tempting — the problem is a recognisable constrained-assignment problem
and there are good solvers for it. It is out of scope because assignment
quality here depends overwhelmingly on information the system does not hold:
who works well together, who is reliable at 6 a.m., who is quietly avoiding
someone else. A solver optimising over the encoded constraints would produce
schedules that are formally valid and socially wrong, and coordinators would
override them until they stopped using the feature.

What the system does instead is make the coordinator fast: rank candidates,
surface gaps, and refuse the impossible. If auto-assignment is ever revisited,
the honest version is a *suggestion* list for a single shift, never a bulk
solve — and the constraint engine above is already the right foundation for it.
