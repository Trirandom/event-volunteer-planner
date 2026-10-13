# ADR-0035 — A form can cover a whole festival

**Status:** Accepted · **Date:** 2026-09-30
**Amends:** [ADR-0032](0032-festivals-group-events.md) — which grouped events
into festivals but said nothing about forms — and docs/03 §3.11, where
`forms.event_id` was the only scope a form could have.

## Context

docs/03 §3.11 gives a form one optional scope: `event_id`, or `NULL` for pool
recruitment. That was written before festivals existed. Soundclash 26 is one
festival of six events (ADR-0032), and the form it replaces asked about all six
at once — availability for montage/démontage, the Open Air, each club night and
the Afterclash, in five separate questions
([10 §3](../10-prior-art-spreadsheet.md#3-the-other-real-limits)).

Held to one event per form, that production needs six forms, six links, six
submissions per volunteer and six places to look. That is the fragmentation
[ADR-0010](0010-first-party-form-as-primary-intake.md) rejected when it
refused "external form plus a separate availability page": two things to send
volunteers was already one too many.

## Decision

**A form is scoped to a festival, to a standalone event, or to neither.**

```sql
ALTER TABLE forms ADD COLUMN festival_id uuid;
-- FOREIGN KEY (festival_id, org_id) REFERENCES festivals(id, org_id) ON DELETE CASCADE
CONSTRAINT forms_one_scope CHECK (num_nonnulls(event_id, festival_id) <= 1)
```

- **Festival scope** is the normal case for a production like Soundclash. The
  form's events are the festival's events *at the moment it is rendered*, so an
  event added to the festival after publish appears in the picker without a
  new version.
- **Event scope** stays, for a standalone one-day event that belongs to no
  festival. An event that is part of a festival is still allowed a form of its
  own, for a late call-out covering one night.
- **Neither** stays pool recruitment: no availability, no participation.

The single `availability` question (still at most one per version) renders one
group per event, in period order, each headed by the event's name and holding
that event's day rows. A range is clamped to *its own* event's `period`, the
operational window ([ADR-0033](0033-event-period-is-operational-public-hours-are-recorded.md)),
because that is the window shifts can fall inside. `public_period` is shown as
context, not used as a bound.

Applying a submission creates or updates **one `participations` row per event
the volunteer declared any `available` range for**, and writes that event's
windows against it. An event the volunteer declared nothing for, or only
"unavailable all day" for, gets no participation: nobody has volunteered
for it, so there is no row to put `unavailable` windows on and nothing to
staff.

## Alternatives considered

**One form per event, as written.** Rejected for the reason above: six links
per production.

**Make a festival a bigger event for the form's sake.** Rejected for the same
reasons ADR-0032 rejected it for the schema: the sub-events have separate
periods, separate missions and separate policies.

**`event_ids uuid[]` on the form.** More general: any set of events. Rejected
because no array column can carry a composite foreign key, so tenancy and
deletion would have to be enforced by trigger. The only set anyone has asked
for is "the festival", which already exists.

## Consequences

- One nullable column, one composite FK, one CHECK.
- The public form payload (`GET /public/forms/{slug}`) returns a list of events,
  each with its days, rather than one event's days.
- A festival-scoped submission fans out to several participations. What is
  per-participation but asked once — mission choices, custom answers
  ([ADR-0036](0036-missions-question.md),
  [ADR-0037](0037-custom-answers-are-kept-per-participation.md)) — is written
  to each of them.
- A volunteer with no available range at any event gets no participation. Their
  submission still exists and is listed, but only the payload carries their
  answers, so those expire on the payload's clock.
