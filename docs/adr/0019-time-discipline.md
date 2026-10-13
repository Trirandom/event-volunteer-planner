# ADR-0019 — Instants in the database, event timezone for display, wall-clock for patterns

**Status:** Accepted · **Date:** 2026-09-10

## Context

Time correctness is this application's core competence. An hour's error puts a
volunteer at the wrong post, and the bug appears twice a year on a Sunday
morning when nobody is looking.

The rules were scattered: `timestamptz` in the data model, "display in the
event's timezone" in the architecture, DST rebasing in the API document, day
bucketing in the scheduling rules. Scattered rules get followed inconsistently,
and the specific requirement raised — that storage must not depend on the
server's timezone — was nowhere stated as an invariant or tested.

## Decision

**One invariant, stated once:**

> The database stores instants. The server's timezone is irrelevant and must
> never affect a result.

Enforced by: `timestamptz` only (never `timestamp without time zone`),
`SET TIME ZONE 'UTC'` on every pooled connection, parameters bound as typed
values rather than formatted literals, and `tstzrange` for periods.

**Three concepts, never conflated:** *instant* (a point on the timeline, what
is stored), *wall-clock* (a calendar reading with no offset, what humans mean),
and *zoned* (the bridge). Store instants; derive wall-clock for display;
**operate in wall-clock for patterns** — event duplication, bulk shift
generation and day bucketing all work in the event's local calendar and then
resolve to instants. Never calendar arithmetic on an instant.

**Display is always in the event's timezone, never the viewer's**, and every
time-bearing field is visibly labelled with that zone. Language, locale and
timezone are three independent axes and no code may assume they agree.

**Libraries:** `jiff` in Rust and `Temporal` in the browser, both chosen because
their types make the instant/wall-clock distinction unignorable. `Date` is
banned except as a transport for an instant.

**The gate that makes this real:** CI runs the entire test suite a second time
under `TZ=Pacific/Chatham` — +12:45 with its own DST rules. If the server's
timezone is genuinely irrelevant, the suite passes identically. One extra job,
and it verifies an invariant that cannot be established by inspection.

## Alternatives considered

**`timestamp without time zone`, storing UTC by convention.** Common, and
rejected: the convention lives in developers' heads, so any value that arrives
without being converted is silently wrong and indistinguishable from a correct
one. `timestamptz` makes the type system carry the guarantee.

**Store the local wall-clock time plus the zone, instead of an instant.** Has
real appeal — it is what the user actually said, and it survives a tzdb update
that changes a zone's rules. Rejected because every query in the system asks
"what overlaps this range", which requires comparable instants; the exclusion
constraint preventing double-booking depends on it. The wall-clock intent is
recoverable from the instant plus the event's zone, so nothing is lost.

**Display in the viewer's timezone**, as most calendar applications do.
Rejected: an event happens in one place, and a coordinator travelling or a
volunteer whose phone is set wrong must not see different times from everyone
else. It is the single most likely cause of somebody arriving an hour late.

**`chrono` + `chrono-tz`.** Works, is more established, and would be the
conservative choice. Rejected because it makes the wall-clock/instant
distinction the developer's responsibility on every call, and DST gaps and folds
are resolved silently. `jiff` being newer is a real risk, accepted in exchange
for types that make the distinction impossible to ignore.

**Luxon instead of Temporal.** Reasonable, and Temporal is the platform
direction with the same conceptual model. Polyfilled until Baseline.

## Consequences

- Storage is provably independent of the deployment host, and there is a CI job
  that proves it rather than a comment claiming it.
- Duplicating an event across a DST boundary keeps local start times — the bug
  the naive implementation would have.
- Hours-per-day and consecutive-day rules bucket by local calendar day, so an
  overnight shift is apportioned across two days rather than attributed wholly
  to its start date.
- Nonexistent and ambiguous local times must be handled explicitly at input
  rather than coerced. That is extra UI work and it is the correct behaviour.
- `jiff` is a newer dependency in the most correctness-critical position in the
  codebase. Mitigated by the DST test set and the hostile-timezone CI run,
  which would catch a regression regardless of its source.
- Every time-bearing UI element must carry a timezone label, which costs screen
  space and removes an entire class of support question.
