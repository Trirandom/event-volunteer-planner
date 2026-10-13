# ADR-0044 — `events.period` is the operational window; the doors are stated, never inferred

**Status:** Accepted · **Date:** 2026-10-13
**Supersedes:** [ADR-0033](0033-event-period-is-operational-public-hours-are-recorded.md)

## Context

[ADR-0033](0033-event-period-is-operational-public-hours-are-recorded.md)
split an event's two windows. `events.period` became the *operational* window —
what every shift is bounded by, and what grows when the mission board schedules
work past its edge — and `events.public_period` was added for the hours the
doors are open. That half of the decision stands and is built: the board emits
an `extend-event` operation before the slot that needs it
(`apps/admin/src/board/edit.ts`), and the axis reaches a two-hour margin past
each day so the outward drag has somewhere to land
(`apps/admin/src/board/folds.ts`).

The other half did not survive contact with real data. ADR-0033 *inferred* the
public hours: the first time `period` strictly widened, `update_event` froze
the period as it stood into `public_period`, and no later widening touched it.

That guess records the wrong fact. What an event's period happened to be the
first time somebody dragged a bar past its end is not when the doors open — it
is the last state of a number a coordinator had been editing for other
reasons, frozen by an unrelated gesture. An event created with a rough
12:00–23:00 placeholder and refined later was published at the placeholder,
and because the rule fired only once, the wrong answer was the permanent one.
Migration `20260917120000_events_doors_are_manual` and the current
`evp_db::catalog::update_event` already reversed it; this ADR records the
decision those changes made, since ADR-0033 is immutable and still says
otherwise.

## Decision

**`events.period` is the operational window**, unchanged from ADR-0033. It
bounds every shift (one of the six hard rules, enforced by the
`shifts_within_event_check` / `events_period_covers_shifts_check` constraint
triggers), and the mission board widens it — `extend-event` first, then the
slot, because both triggers are `DEFERRABLE INITIALLY IMMEDIATE` — rather than
refusing a coordinator who is scheduling setup or teardown.

**`events.public_period` is a fact somebody states.** It is set and cleared by
a coordinator (the *Doors open / Doors close* fields on the plan's details
page, `PATCH …/events/{event}` with `public_period`), and nothing derives it.
`NULL` means no public hours have been stated — **never** "same as `period`".
Widening or narrowing `period` does not touch it.

The schema is unchanged from ADR-0033: `events_public_period_valid` still
requires a non-empty, bounded range contained in `period`, so the doors are
open during the event, and a period shrunk back inside the stated hours is
refused.

## Alternatives considered

- **Keep the first-widening rule and let coordinators correct it.** Rejected:
  a value that is silently wrong until someone notices is worse than an empty
  one, and nothing would prompt the correction.
- **Default `public_period` to `period` when absent.** Rejected for the same
  reason in a different place: many editions never publish door times at all,
  and "the doors are open whenever volunteers are working" would be shown to
  volunteers as if someone had said it.

## Consequences

- Readers that mean "when is this open to the public" — the volunteer form's
  availability rows, the emails preview, the programme — show `public_period`
  as context when it is present and show nothing when it is not. They never
  fall back to `period` and present it as door times. Availability itself is
  still clamped to `period` (docs/09 §3).
- `EventResponse.public_period` is omitted when `NULL`, so a client that does
  not know about it reads what it read before.
- The undo inverse for `event.update` carries the previous `public_period`,
  including its absence, so restoring an event restores what was stated
  (ADR-0024).
- `festivals.period` is still untouched, as in ADR-0033: whether a festival
  grows with its days remains unanswered, and a day may grow past its
  festival's period today.
