# ADR-0026 — Retention scope is a table-level registry; per-edition attributes leave `participations`

**Status:** Accepted · **Date:** 2026-09-10
**Amends:** [ADR-0018](0018-purpose-based-retention.md),
[ADR-0020](0020-retention-periods-are-configuration.md) and
[ADR-0021](0021-retention-tier-follows-table.md) — the tiers, the periods and
the caps all stand. What changes is how the sweep's scope is *derived*, because
as specified it could not be derived at all.

## Context

[ADR-0021](0021-retention-tier-follows-table.md) made retention tier follow the
table, so that "the rule cannot drift from the data model", and explicitly
rejected a hand-maintained column-level classification list. The mechanism it
described does not hold up against the schema it was written for, in four ways.

**1. The purge was specified as nulling columns.**
[15 §5](../15-privacy-and-retention.md#5-the-one-month-sweep) lists the
`participations` columns the sweep sets to `NULL`. That list is a column-level
classification — the thing ADR-0021 rejected — and it had already drifted:
`participations.is_adult` is absent from it, although
[ADR-0023](0023-adult-declaration-boolean.md) and
[04 §4](../04-api.md#4-permissions) both say it is purged with the edition.

**2. The verification was specified against a data dictionary.** 15 §5 asserted
"every column marked as personal in the data dictionary returns nothing" —
again the rejected mechanism, in the one place that was supposed to prove the
sweep works.

**3. The derivation does not reach three of the tables ADR-0021 names.** It
classifies "`participations` and everything referencing it — `availability_windows`,
`assignments`, `submissions`, tokens" as event-tier, and
[15 §9](../15-privacy-and-retention.md#9-enforcement) gates that with a test
over "every table with a `participation_id`". In the schema, `submissions`,
`calendar_feed_tokens` and `form_invite_tokens` reference `volunteers`, `events`
or `forms` and have **no `participation_id`**. The largest concentration of
personal data in the system is outside the scope of the check meant to catch it.

**4. Taken literally, the derivation destroys the roster.** ADR-0021's own
enforcement property — "no row in `participations` or its dependents survives"
— combined with `ON DELETE CASCADE` from `assignments` and `schedule_snapshots`,
deletes the assignment history and the published rosters. The same documents
promise that history survives, and that anonymisation "preserves integrity".

The root cause is a table that is doing two jobs. `participations` is both the
**join** that assignments and rosters hang off — which must survive — and the
**container** for per-edition personal attributes, which must not. No rule about
tiers can be honest while one table is in two tiers.

## Decision

### 1. Per-edition personal attributes move to `participation_details`

`participations` becomes a skeleton: identity, the event, the volunteer, the
participation status, and timestamps. Every per-edition attribute — the T-shirt
override, meal plan, accreditation code, arrival and departure, notes, and
`is_adult` — moves to a new `participation_details` row, one per participation,
`ON DELETE CASCADE`.

The purge then deletes rows. It never nulls a column. **If a column has to be
nulled, it is on the wrong table**, and moving it is the fix. `is_adult` lands
in the event tier by construction rather than by remembering to list it, which
is what ADR-0021 was reaching for.

### 2. Every table declares a tier, in the schema, checked by CI

```sql
CREATE TABLE retention_scope (
  table_name regclass PRIMARY KEY,
  tier       text NOT NULL CHECK (tier IN ('event','pool','accountability','ephemeral')),
  reason     text NOT NULL
);
```

| Tier | Meaning | Members |
| --- | --- | --- |
| `event` | Rows deleted when the event's data is purged | `participation_details`, `availability_windows`, `schedule_snapshots`, `calendar_feed_tokens`, `operations` |
| `pool` | Kept only with `pool_retention` consent, deleted at expiry | `volunteers`, `volunteer_skills`, `form_invite_tokens` |
| `accountability` | Retained; holds identifiers, not personal content | `participations`, `assignments`, `roster_versions`, `submissions`, `submission_batches`, `audit_log` |
| `ephemeral` | Deleted on its own purpose clock, independent of any event | `submission_payloads`, `login_tokens`, `sessions` |

A CI test asserts that **every table in the schema has exactly one
`retention_scope` row with a non-empty reason**. A new table fails the build
until someone classifies it. This is a table-level registry of about thirty
rows, not a column-level list of several hundred: it is enumerable, reviewable
in a diff, and — unlike a column list — it cannot be *silently* incomplete,
because the completeness check is over `pg_class` rather than over someone's
memory.

### 3. Verbatim answers are their own row, so they can be deleted rather than redacted

`submissions.raw` becomes `submission_payloads(submission_id, org_id, raw)`,
tier `ephemeral`, deleted `submission_raw_days` after receipt (default 30,
capped at 180, per-organisation like the other periods). `submissions` keeps
`raw_keys text[]` — the field names that were present, no values — which is the
structural placeholder ADR-0021 asked for, obtained by keeping a non-personal
column rather than by overwriting a personal one.

This also fixes a gap nobody had noticed: a **pool-level** submission
(`event_id IS NULL`) belongs to no event, so an event-scoped sweep never reached
it. Redaction by age reaches every submission, whatever it was attached to.
Replay stays available for as long as the payload does, which ADR-0021 already
accepted as the right window — "only available shortly after import, which is
when it is needed".

### 4. Tokens follow the thing they serve

- `calendar_feed_tokens` is re-keyed on `participation_id`. An ICS feed is
  exactly "this volunteer's shifts at this event", so it *is* per
  participation — which makes it event-tier structurally, and makes the feed
  stop working when the event's data goes.
- `form_invite_tokens` stay **pool**-tier and survive as long as the volunteer
  record does. They are the route by which a volunteer exercises their rights
  ([ADR-0027](0027-volunteer-self-service-rights.md)), so deleting them at the
  event boundary would remove the only self-service path to erasure from the
  people whose data is retained longest. They are deleted with the volunteer
  row, and revoked when it is anonymised.

### 5. Anonymisation reaches the accountability tier by join, not by list

`audit_log` gains `subject_volunteer_id`. Anonymising a volunteer rewrites
`actor_label` **and** redacts `before`/`after` on rows whose subject is that
volunteer — those payloads are the one place in the accountability tier that
holds personal values. It is a join on a foreign key, so it cannot miss rows the
way a list of tables-to-visit could.

### 6. The sweep triggers on the event ending, not on its status

The trigger is every event whose `period` upper bound is more than
`event_data_days` in the past, whatever its `status`. The previous condition —
`archived` or `running`-and-ended — silently exempted any event left in
`published`, which is the state an event is actually in when it finishes.

## Alternatives considered

**Keep the columns on `participations` and null them.** Rejected: it is a
column list by another name, it had already drifted (`is_adult`), and its test
can only ever assert "these columns are null", which is exactly the assertion
that stops being true when someone adds a column.

**Derive the purge purely from the foreign-key graph** — delete everything
reachable from `participations`. Genuinely appealing, since it needs no registry
at all. Rejected: it deletes `assignments` and the published rosters, and the
tables that most need purging (payloads, tokens) are not reachable from
`participations` in the first place. The graph describes referential structure,
not purpose, and retention is about purpose.

**A column-level classification list, corrected.** Rejected again, for
ADR-0021's reason and one more: the failure mode is invisible. A missing column
produces data that is still there, with no error. The registry's failure mode is
a failed build.

**Split `volunteers` the same way**, into skeleton and personal detail.
Rejected as unnecessary: the whole `volunteers` row is pool-tier and lives or
dies together, so there is nothing for the split to separate. The `participations`
split exists only because that table genuinely has rows in two tiers.

**Retain `schedule_snapshots` for history.** Rejected: `payload` is the schedule
as it was sent, including the volunteer's name — it is a personal record, not an
identifier. What accountability needs is who was assigned to what, and that is
`assignments` plus `audit_log`. Keeping the snapshot would be keeping a copy of
an email for years to prove it was sent.

**Give `sessions` and `login_tokens` no retention rule**, as before. Rejected
once the registry demanded a tier for every table: expired sessions and consumed
login tokens are personal data (IP, user agent) with no purpose after expiry, and
nothing was deleting them.

## Consequences

- The sweep's scope is derived from a schema object, its action is uniform
  (delete rows), and its test is "zero rows in the event tier for this event"
  rather than a list of columns that must be null.
- Roster and assignment history survive a purge, which is what the privacy
  documentation always claimed and the specified mechanism would have broken.
- `is_adult`, pool-level submissions, expired sessions, undo payloads and ICS
  tokens are all now covered — four holes closed by classification rather than
  by four new rules.
- Costs: one new table on the read path for logistics reports (meals, sizes,
  accreditation all join `participation_details`), one for payloads, one
  registry, and a migration that moves six columns. The reports are the only
  query shape that gets more complex.
- Replay is explicitly time-bounded. A mapping error found six months later is
  no longer replayable, and the honest answer is that the data it would have
  repaired has been deleted anyway.
- `participations` now holds nothing personal but the link between a volunteer
  and an event. That link is itself information — it says someone volunteered —
  which is why the row is pseudonymous rather than anonymous, and why erasure
  anonymises the `volunteers` row it points at rather than pretending the
  participation never happened.
