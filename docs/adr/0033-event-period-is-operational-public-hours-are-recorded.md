# ADR-0033 — `events.period` is the operational window; the public hours are a column of their own

**Status:** **Superseded by [ADR-0044](0044-event-period-is-operational-doors-are-stated.md)** · **Date:** 2026-09-16

> The operational-window half of this decision stands and is restated in
> ADR-0044. The rule that *records* `public_period` on the first widening of
> `period` was reversed by migration `20260917120000_events_doors_are_manual`:
> the doors are now stated by a coordinator and never inferred.

## Context

`events.period` has carried two meanings since docs/03 was written, and
nothing made a coordinator choose between them. It is the window the doors are
open — what the programme says, what a volunteer reads on the form — and it is
also the window every shift must fall inside, which is one of the six hard
rules and a constraint trigger in both directions (docs/02 §5, docs/05 §2,
`shifts_within_event_check` / `events_period_covers_shifts_check`).

Those are not the same window and never were. The bar staff arrive before the
doors open; the technique crew leave after they close. Soundclash 26's own
Open Air already records "its own montage/démontage time inside that day"
(ADR-0032), which is that fact stated as a workaround: the day was declared
wider than the event so there would be somewhere to put the setup, and the
published hours were lost in the process.

The mission board is where this stopped being theoretical. A bar on that board
is a run of shifts and nothing else (ADR-0029), and every bar is *born*
spanning its whole event — a mission nobody has cut is drawn across the day,
and `Cut` tiles the day. So the first edge a coordinator pulls outwards is
already sitting on `period`'s end, the drag is clamped, the plan is empty, and
nothing happens. Dragging inwards works. The board could be dragged shorter and
never longer, which read as a broken editor and was in fact the schema
declining to represent setup time.

Three ways out were on the table.

**Leave the clamp and explain it.** Tell the coordinator the day ends here and
that they must edit the event elsewhere first. Honest, cheap, and it keeps the
rule untouched — but it answers a coordinator who is right with a form. The
gesture is the correct one; "the bar runs two hours past closing" is a true
statement about every event anyone has run, and sending them to a different
screen to say it is the Google Sheets workflow this project exists to replace.

**Let shifts fall outside their event.** Rejected outright. The rule is one of
the six, it is enforced by a trigger rather than by convention precisely
because the application must not be trusted with it, and an event whose period
does not bound its work stops being able to answer "what does this day cost in
volunteer hours" — the question docs/01 opens with.

**Let the work move the day, and remember what the day was.** Taken.

## Decision

**`events.period` is the operational window.** It is what shifts are bounded
by, and it grows when work is scheduled past its edge. The mission board plans
that growth itself: an edge dragged past the end of the day emits an
`extend-event` operation *before* the slot creates, because both halves of the
shift-inside-event rule are `DEFERRABLE INITIALLY IMMEDIATE` constraint
triggers and a slot written first is refused at the statement rather than at
the commit.

**`events.public_period` records the hours the event is open to the public.**

```sql
ALTER TABLE events ADD COLUMN public_period tstzrange;

ALTER TABLE events ADD CONSTRAINT events_public_period_valid CHECK (
  public_period IS NULL OR (
    NOT isempty(public_period)
    AND lower(public_period) IS NOT NULL
    AND upper(public_period) IS NOT NULL
    AND public_period <@ period
  )
);
```

`NULL` means the two are still the same thing — not "unknown" — so no existing
row changes meaning and no backfill is needed.

**The first widening records it, and no later one touches it.** The rule lives
in `update_event`'s one `UPDATE`, not in the board:

```sql
public_period = CASE
  WHEN $period IS NULL              THEN public_period   -- not a period patch
  WHEN public_period IS NOT NULL    THEN public_period   -- already recorded
  WHEN period <@ $new AND period <> $new THEN period     -- a strict widening
  ELSE public_period END
```

A `SET` clause reads the pre-`UPDATE` row, so `period` there is the period as
it stood. It belongs in the column's own statement rather than in the caller
because it is a property of the data: an event form that widens the period by
typing must not lose the published times for want of remembering to.

**The axis reaches past the days on it.** `PlanMissionsView` draws a fixed
two-hour margin beyond the first and last day, shaded. Without it the decision
above is unreachable — the edge a coordinator grabs is the last pixel of the
axis, and there is nowhere to drag to. The margin is also the outer limit of
one gesture: a bar may not be planned somewhere the board does not draw, and a
coordinator who needs four hours does the same drag twice, because the margin
moves out with the day each time.

## Consequences

- The six hard rules are unchanged, and docs/02 §5 and docs/05 §2 keep their
  identical wording. A shift still may not fall outside its event; what
  changed is that the board now moves the event rather than refusing the
  coordinator.
- `events_public_period_valid` also closes the other direction: a period
  shrunk back inside the published hours is refused, in the same breath as
  `events_period_covers_shifts` refusing one shrunk away from its shifts.
- `EventResponse` gains an optional `public_period`. It is omitted rather than
  null while the two windows coincide, so a client that does not know about it
  reads exactly what it read before.
- The undo inverse for `event.update` carries the previous `public_period`,
  including when it was absent: widening *sets* the column, and an inverse
  that left it alone would restore the narrow period with the published hours
  still pinned inside it (ADR-0024).
- A drag that widens a day invalidates the event, the events list and the
  festival — not just the day's shifts. The axis of a festival-wide board is
  the union of its days' periods, so one day growing redraws a page that never
  asked for that day on its own.
- The volunteer form and the programme should read `public_period` where they
  mean "when is this event", falling back to `period` when it is absent. That
  is not built yet — the form is M2 — and this ADR is what it should be built
  against.
- `festivals.period` is untouched and stays "the outer window a coordinator
  plans against". Whether it should grow with its days is a real question and
  deliberately not answered here; today a day may grow past its festival's
  period and nothing refuses it.
