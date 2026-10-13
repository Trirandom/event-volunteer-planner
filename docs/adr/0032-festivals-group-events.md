# ADR-0032 — `festivals` groups events; a new entity, not an `events` property

**Status:** Accepted · **Date:** 2026-09-15

## Context

The first organisation to sit down with this planner runs Soundclash 26, and
it does not fit the data model as written. docs/03 has one entity between an
organisation and its locations: `events`. An event is one `period`, one
`timezone`, one set of locations, one set of shifts. Soundclash 26 is not
that — it is a production spanning ten days that the coordinators plan and
staff as several distinct things, each with its own hours and its own zones:

- **Montage Molo** — Thursday, 13:00–20:00, build only, one post.
- **Open Air** — Saturday, six slots across a single day, its own locations
  (bar, entrées, prévention VHSS, …), plus its own montage/démontage time
  inside that day.
- **Dub & 2step**, a club night that runs from Friday afternoon through
  Saturday morning — 13:00 to 08:00 the next day — with its own seven-slot
  division and its own uneven slot lengths (documented in the "document
  uneven slot length" commit).
- **Dnb & Dubstep**, the following night, same shape, different hours.
- **After** — Sunday, 10:00–01:00 Monday.
- **Démontage Molo** — Monday, 10:00–18:00, strike only.

Six periods, six sets of locations (a "Bar" at the Open Air and a "Bar" at
Dub & 2step are staffed separately and need separate shifts), one production
that a coordinator plans, staffs and reports on as a whole. Nothing in
docs/03 names that whole. A coordinator today would have to either misrepresent
it as one event or track "these six events belong together" by convention —
naming, a shared prefix, a spreadsheet on the side — which is exactly the kind
of thing this planner exists to replace.

This is also the shape the product needs for the empty-org "load an example"
feature: the worked example *is* Soundclash 26, and it is a festival of six
events or it is not the real structure at all.

## Decision

**Add `festivals`, org-owned, one level above `events`:**

```sql
CREATE TABLE festivals (
  id         uuid PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name       text NOT NULL,
  slug       citext NOT NULL,
  timezone   text NOT NULL,
  period     tstzrange NOT NULL,
  status     event_status NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version    int NOT NULL DEFAULT 1,
  UNIQUE (org_id, slug),
  UNIQUE (id, org_id)
);

ALTER TABLE events ADD COLUMN festival_id uuid;
ALTER TABLE events ADD CONSTRAINT events_festival_id_org_id_fkey
  FOREIGN KEY (festival_id, org_id) REFERENCES festivals(id, org_id)
  ON DELETE SET NULL (festival_id);
```

(As migrated, `festival_id` is a column on `events` from its first migration
rather than a later `ALTER`, since both land together — the `ALTER` form
above is illustrative of the relationship, not the literal migration.)

`events.festival_id` is **nullable**. A standalone one-day event — most
organisations, most of the time — is not required to belong to a festival,
and `POST …/events` omits the key entirely to mean exactly that (never an
explicit `null`, so "not sent" and "explicitly cleared" are not conflated on
the wire).

`festivals` reuses `event_status` rather than inventing a parallel enum: a
festival's lifecycle (draft → planning → published → running → archived) is
the same vocabulary as an event's, and coordinators do not need to learn two.

**A festival is a grouping, not a scheduling authority.** Its `period` is the
outer window a coordinator plans against and reports within; it is not
enforced to cover its events the way `events.period` is enforced to cover its
shifts (docs/03 §3.4's `shift_outside_event` triggers). Adding that trigger
pair is legitimate future work — this ADR does not rule it out — but it is not
required for the feature this ADR was written for, and adding an enforced
invariant nobody asked for yet is exactly the kind of scope this project's
"soft rules are explicit, hard rules earn their place" posture (ADR-0007)
warns against.

**Locations and shifts stay on `events`, not on `festivals`.** A festival has
no locations of its own; "Soundclash 26's Bar" is not one row, it is one row
per event that has a bar, because Open Air's bar and Dub & 2step's bar are
staffed, scheduled and reported on independently. This is the structural
reason a festival cannot be modelled as a bigger event (see Alternatives).

## Alternatives considered

**One long event, sub-events expressed as locations or shift groupings.**
Rejected on the data itself: `events.period` is one `tstzrange`, and
Soundclash 26's real footprint — Thursday 13:00 through the following
Monday 18:00, with two genuinely separate club-night sub-periods inside it
running through the small hours — is not one contiguous span anybody staffs
uniformly. Forcing it into one event's period means either padding the period
to cover dead time nobody is scheduled during (which breaks
`max_consecutive_days` / `max_hours_per_day` reasoning, both computed per
event) or lying about the boundary. Modelling the six sub-events as locations
under one event fares no better: `locations` is a strict two-level zone/post
tree (docs/03 §3.4, "intentionally exactly two levels"), and "Open Air" is not
a zone or a post, it is a thing with its own zones and posts. Reusing
`locations` for it would either break that invariant or require a third
level, which docs/03 already rejected for the zone/post tree on its own
merits.

**`events.duplicated_from` as the grouping mechanism.** `duplicated_from`
(docs/03 §3.4) already exists and records provenance — "this event was copied
from that one," the mechanism behind `POST …/events/{event}/duplicate`. It
was considered as a way to avoid a new table: chain six events with
`duplicated_from` pointing at a notional first one, and call the chain a
festival. Rejected because it answers a different question. `duplicated_from`
is "what was this event cloned from," which is provenance about *one* event's
history and is meaningful even for two events that have nothing to do with
each other's schedule (an organisation might duplicate last year's Open Air
as the template for an unrelated one-day event next month). "Which events are
part of Soundclash 26" is not a history question, it has no natural root
(none of the six was copied from another), and a coordinator needs to query it
directly ("show me every event in this festival") rather than by walking a
chain that was never designed to be walked that direction. Overloading
`duplicated_from` to mean two things would make neither query obvious from the
schema.

## Consequences

- One new table, `festivals`, org-owned, RLS-policed exactly like every other
  tenant table (`ENABLE`/`FORCE ROW LEVEL SECURITY`, a `USING`+`WITH CHECK`
  policy, `UNIQUE (id, org_id)` as the anchor for `events.festival_id`'s
  composite FK), and one nullable column on `events`.
- `GET /api/v1/orgs/{org}/festivals/{festival}` inlines its events
  (`events: [Event]`) so a coordinator's festival view is one request, not
  N+1.
- The worked example (`POST …/festivals/example`, `POST …/events/example`)
  is a real instance of this shape: one festival, six events, each with its
  own locations and shifts, no volunteers — see docs/04 for the routes and
  docs/03 for the schema as amended.
- A future "does this festival's period cover its events" invariant, if a
  coordinator workflow turns out to need it, is a new migration and does not
  need a new ADR to add — it is additive to what is decided here, not a
  reversal of it.
- Soft-constraint fields that are computed **per event**
  (`max_hours_per_day`, `max_consecutive_days`, `min_rest_minutes`,
  night-shift window) stay on `events`, not on `festivals`. A volunteer
  working Open Air and then Dub & 2step two days later is two separate
  events' worth of scheduling policy, which is correct — a festival grouping
  does not imply one set of fairness rules across sub-events with entirely
  different shapes.
