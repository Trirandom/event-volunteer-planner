# ADR-0053 — Deleting a festival ungroups its events and deletes its forms, submissions included

**Status:** Accepted · **Date:** 2026-11-18
**Amends:** docs/04 §"Festivals" (adds `DELETE` and its impact read)

## Context

A festival could be created, and loaded from the worked example, but not
removed. The concrete need is the example itself: a coordinator who has
tried it, or wants a fresh copy after `example.json` changed, has no way to
take it out again short of a new organisation. A festival created by
mistake is the same problem.

A festival owns little of its own. Its events point at it with
`ON DELETE SET NULL (festival_id)` (ADR-0032), so dropping the row already
leaves them standalone. What it does own is its **festival-scoped forms**
(ADR-0035): `forms.festival_id` is `ON DELETE CASCADE`, and so is everything
under a form: versions, questions, the `internal_form` intake source, its
batches and every submission sent to it, with their payloads.

Two facts make that cascade a decision rather than a detail:

- Submissions are volunteers' answers. docs/04 reserves an actual `DELETE`
  for "records created in error that have no history"; a festival whose
  form was answered has history.
- A plain cascade does not even succeed. `availability_windows` keeps the
  submission it was read off in `source_submission_id`, `ON DELETE SET NULL`,
  and `availability_has_provenance` requires exactly one provenance, so
  deleting a submission that produced windows is a `23514`.

## Decision

`DELETE /api/v1/orgs/{org}/festivals/{festival}`, **owner only**, with
`If-Match`, like deleting an event (docs/04 §4).

- **The festival's events are ungrouped, never deleted.** They stay with
  their missions, shifts, participations and assignments, standalone. An
  event is deleted on its own, by its own owner-only `DELETE`, one at a time:
  each has a plan of its own that is worth a separate decision.
- **Its forms are deleted with everything under them**, submissions and
  payloads included. In the same transaction, first, the availability
  windows read off those submissions are deleted: they are what the
  submissions said, and with the submissions gone they have no provenance.
  Windows a coordinator declared stay.
- **Volunteers stay in the pool**, with their participations. The pool is
  the organisation's, not the festival's (docs/03 §3.3).
- **The owner is told the cost before paying it.** `GET
  …/festivals/{festival}/deletion` counts the events that will be ungrouped,
  the forms and the submissions that will be deleted. The admin shows those
  numbers and the owner types the festival's name to confirm.
- **One operation** (`festival.delete`, ADR-0024), with no `event_id`, so it
  outlives the cascade. Its inverse recreates the festival and regroups the
  events it held. It is recorded `undoable = false` when forms or submissions
  were deleted, because no inverse can bring those back, and `true`
  otherwise.

## Alternatives considered

**Refuse (`409`) while the festival's forms have any submission.** The safe
default for real data, and rejected because it fails the case this exists
for: the worked example is loaded with answered submissions, and a test
festival someone filled the form of is just as stuck. The typed
confirmation, with the count in front of it, is the safeguard instead.

**Delete the events too.** One click, empty organisation. Rejected: an
event carries a plan of its own (shifts, assignments, participations), and
deleting it already has its own endpoint and confirmation. Folding six of
those into one cascade makes the most destructive delete in the product the
least deliberate one.

**Keep the forms by rescoping them.** Nothing fits: a form covers one
festival or one event (`forms_one_scope`), and its availability and
missions questions were written against the festival's days. It would need
a schema change for a form nobody can open any more.

**Archive the festival instead.** Events can be archived; a festival could
be. Rejected as the answer to this: an archived festival still blocks
loading the example again (`org_has_any_festival`), and it is not what
"created by mistake" asks for.

## Consequences

- The example can be removed and reloaded: delete the festival, then each
  event (their slugs would collide with the example's), then load it again.
- A real festival's answers can be destroyed by an owner who types its
  name. That is the cost of the example case; the count shown before
  confirming is what makes it a decision.
- `operations` gains its first entry that is not undoable by construction.
- The windows step is needed by any future delete of a submission, not only
  this one; it is written once here, in `evp_db::catalog::delete_festival`.
