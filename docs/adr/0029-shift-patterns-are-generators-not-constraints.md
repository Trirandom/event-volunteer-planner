# ADR-0029 — Shift patterns: the slot division is per mission, and it generates rather than constrains

**Status:** Accepted · **Date:** 2026-09-11

## Context

The spreadsheet divides each day into **29 fixed slots**, and that division is
the same for all 18 missions. It is a property of the grid — a column is a
column — so a mission whose work is not shaped like the grid has to be
misrepresented in it.

At least one is. The *artiste* mission runs in five uneven slots: two of 45
minutes, then one of 90, then two more of 45. In the spreadsheet that is either
rounded to the 2-hour grid, which is wrong, or split across cells that mean
something else, which is worse. Nobody noticed it as a defect because there was
no alternative to notice it against.

Two things are therefore needed, and they are easy to conflate:

1. A **reusable, per-mission description** of how a day is cut into slots — 2
   hours for most missions, `45/45/90/45/45` for *artiste*, whatever some future
   mission needs. Without it, laying out a 4-day event across 40 posts is
   hundreds of hand-entered shifts.
2. A decision about whether that description **binds** the shifts made from it.

The data model already permits uneven shifts: `shifts.period` is a `tstzrange`
and has only ever been bounded by "non-empty and at most 24 hours"
([03 §3.4](../03-data-model.md#34-events-locations-shifts)). So this ADR adds no
capability to the schema. It adds a way to *express* a division, and it decides
what that expression means.

## Decision

**A shift pattern is an ordered list of segment durations**, owned by the
organisation and reusable across events and editions. Each segment is either a
`shift` (it produces one) or a `gap` (it produces nothing — a changeover, a
meal, a sound check). A pattern either `tile`s its list across a window, which
is how `2 h` covers a day, or is laid `once`, which is how `45/45/90/45/45` is
laid from 09:00.

**It attaches at three levels, most specific winning:** the argument to a
generation request, then `locations.shift_pattern_id`, then
`events.default_shift_pattern_id`. So "most missions are 2 h, *artiste* is not"
is two rows, not a policy.

**The pattern generates shifts and then has nothing further to do with them.**
A generated shift is an ordinary shift. No column records which pattern made it,
no constraint keeps it aligned, no rule warns when it drifts, and editing one
afterwards is not an exception to anything. Dragging a 45-minute slot to end at
10:20 because that is when the artist actually finishes is a normal Tuesday.

**Generation runs in wall-clock time**, per
[ADR-0019](0019-time-discipline.md): segments are walked in the event's local
calendar and resolved to instants at the end, so a pattern crossing
spring-forward yields a shift that is genuinely shorter in real time, and a
segment landing on a nonexistent local time is refused rather than coerced.

**The picker granularity must divide every segment.** Attaching a pattern whose
durations are not all multiples of the event's `availability_step_minutes` is
refused, naming the step that would work. A 45-minute slot at a 30-minute step
is a shift no volunteer can declare availability against, so
`outside_availability` would warn on a mismatch the form created.

## Alternatives considered

**One uniform slot length per event, configurable.** The obvious reading of the
request, and it covers the 2-hour default in one integer column. Rejected
because it does not cover *artiste*, which is the case that prompted this — and
a configurable-but-uniform division is the spreadsheet's limitation with a
settings page in front of it.

**Make the pattern a constraint: shifts must align to it.** Superficially
attractive — it is what would make the grid "correct", and it would let the
board render fixed columns. Rejected, and firmly. The entire argument for this
project is that the spreadsheet cannot express `14:00–19:30`
([10 §2](../10-prior-art-spreadsheet.md#2-the-actual-flaw) is about eligibility;
[01 §1](../01-product-spec.md#the-rest) is about coarse availability), and a
system that re-imposes a grid on *shifts* has reintroduced the same defect one
layer down. A festival changes its schedule at 2 a.m.; a planner that answers
"that is not a valid slot" gets abandoned for a spreadsheet, which is where this
started.

**A soft rule `off_pattern`, warning when a shift does not align.** The
compromise position, and worse than both ends of it. Every hand-adjusted shift
would warn forever, coordinators would learn to clear the column without reading
it, and that habit would carry over to `double_booked` and
`declared_unavailable`. A warning nobody reads costs more than no warning
([05 §3](../05-scheduling-rules.md#3-soft-rules) depends on warnings being
worth reading).

**A `shifts.source_pattern_id` provenance column.** Harmless-looking, and it
would answer "select everything the Artiste pattern made". Rejected because it
invites the feature behind it — regenerate, re-sync, "the pattern changed, do
you want to update 240 shifts?" — which is the constraint alternative arriving
through a side door. The need it addresses is served by server-side undo
([ADR-0024](0024-server-side-undo-and-per-item-bulk.md)): a generation is one
operation with one inverse, so the wrong pattern is undone in one action.

**Patterns scoped to the event rather than the organisation.** Would model
"this year the artists start at 10:00" more directly. Rejected: per-edition
patterns rot exactly the way per-edition volunteer data rots
([03 §1](../03-data-model.md#the-three-identity-concepts)), and the start time
is an argument to generation, not a property of the division. Reuse across
editions is the point — duplicating an event keeps its patterns because they
were never copies.

## Consequences

- Laying out an event is one request per pattern per set of posts, and the
  *artiste* post is not a special case in the UI — it is a different row in a
  dropdown.
- The planner board cannot assume uniform columns. It already does not: shift
  blocks are absolutely positioned from a continuous time scale
  ([02 §7](../02-architecture.md#the-planner-board)). The axis granularity
  becomes the GCD of the event's segment durations, floored at 15 minutes.
- An event containing any 45-minute pattern must run the availability picker at
  a 15-minute step. That is a visible, explained refusal at attach time rather
  than a warning storm during assignment.
- Nothing keeps generated shifts aligned to anything, which is the decision.
  Coordinators who want the grid back get it by regenerating, not by being
  prevented from leaving it.
- `just seed` must include a post with a non-uniform pattern, so that any code
  assuming equal slot lengths fails in development rather than at the event.
