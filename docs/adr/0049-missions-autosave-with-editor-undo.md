# ADR-0049 — Missions save themselves, and their undo is the page's

**Status:** Accepted · **Date:** 2026-11-17
**Amends:** [ADR-0048](0048-form-draft-autosaves-with-editor-undo.md) (its scope),
[ADR-0024](0024-server-side-undo-and-per-item-bulk.md),
[14 §4 "Undo"](../14-accessibility-and-interaction.md#undo)

## Context

The missions page had one "Save changes" button per mission. With the form
builder now saving as it goes (ADR-0048), the page was the one place in the
plan where an edit could be typed, left, and lost. Coordinators asked for
the same behaviour here, and for Ctrl/Cmd+Z.

ADR-0048 made that exception for the form draft on one argument: a draft is a
working copy that nobody outside the editor sees, so its intermediate states
do not matter. **That argument does not hold here.** A mission is a set of live
`locations` rows, one per day it runs on (ADR-0032). Shifts hang off them, the
public form's missions question reads them, and every save is a fan-out of
`PATCH`es. So whatever this page does needs its own justification.

## Decision

**Each mission saves itself.** Edits are sent about a second after they stop
(`plan/useAutosave.ts`, the form builder's), as the same per-day `PATCH`
fan-out the button used to send. A mission whose fields break a rule (an empty
name, a bad bound) is not sent, and its row says why. A refused day is named,
as before. The next edit tries again. Leaving the page sends what is pending
first, and asks only when something cannot be saved. Creating a mission or a
post stays an explicit submit: it is a new row, not an edit.

**Undo is the page's own history of what this coordinator did here**, not the
`operations` stack. Each step is replayed as a **new forward write** through
the same endpoints. Reverting a field is another `PATCH` that asserts the
row's current version. Re-adding a day is another `POST`. So an undo is
validated by the server like any edit, can be refused, and never restores a
row behind the server's back. Typing in one field is one step. Inside a text
field, the browser's own text undo still applies.

What a step can undo:

- **A field edit:** the mission's fields go back to what they were.
- **Ticking a day:** that day is removed again. This is refused once the day
  has shifts, because removing it would delete work the tick did not create.
- **Unticking a day that held nothing:** the day is ticked again, which
  restores it exactly (`missionDays.ts`).
- **Not** unticking a day that held posts or shifts, nor deleting a mission.
  The cascade took rows that a forward write cannot bring back. Both ask for
  confirmation and say they are irreversible, and neither becomes an undo step.

## Alternatives considered

**Server-side undo through `POST …/operations/{id}/undo` (ADR-0024 as
written).** This is the right end state, and it would survive a reload and
cover a colleague's change. It was rejected for now because the endpoint is
not built, and because a mission edit is N operations, one per day. Grouping
them into one undoable step needs a server-side notion of a batch that does
not exist yet. Nothing here prevents it later. The writes still record their
`operations` rows.

**Restore whole snapshots, as the form builder does (`draftHistory.ts`).**
Rejected. The page's state is many independent rows, and a snapshot would
have to be diffed back into writes anyway. Some of those writes (removing a
day with shifts) are exactly the ones an undo must not send silently. Storing
the steps names each write and makes refusing one explicit.

**Keep the Save button, and add undo only.** Rejected for the reason in
ADR-0048: the forgotten save was the failure, and it is the more expensive
one here, because a briefing that is never saved is a briefing volunteers
never read.

## Consequences

- Reloading the page loses its undo history, but not the edits, which are
  saved. This matches the form builder, and it is a narrower undo than ADR-0024
  promises for domain operations. That gap closes when the operations
  endpoint lands.
- A second tab editing the same mission meets a `409` on the rows it is
  stale on. Those days are named, and the next edit re-reads and tries again.
  Nothing is overwritten without a version check.
- An undo can be refused (a day that has since gained shifts, a name taken
  since). The refusal is announced, and the step stays where it was.
- Unticking a day with shifts and deleting a mission remain the two writes on
  this page that cannot be taken back, and both say so before they happen.
