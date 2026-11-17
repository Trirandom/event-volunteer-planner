# ADR-0051 — Event details save themselves, and their undo is the page's

**Status:** Accepted · **Date:** 2026-11-17
**Amends:** [ADR-0049](0049-missions-autosave-with-editor-undo.md) (its scope),
[14 §4 "Undo"](../14-accessibility-and-interaction.md#undo)

## Context

The details section showed one panel per event, each with "Save changes" and
"Discard", and "add a day" at the bottom of the page. The form builder
(ADR-0048) and the missions page (ADR-0049) now save as they go and take
Ctrl/Cmd+Z. Details was the one plan page left where an edit could be typed,
left and lost. Coordinators asked for it to work like missions: one row per
event that opens, creation at the top, no save button, and undo.

## Decision

ADR-0049's decision, applied to `events`, with the differences a single row
makes:

- **Each event saves itself** about a second after the last edit
  (`plan/useAutosave.ts`), as the same `PATCH /events/{event}` with the
  rendered `version` in `If-Match`. A draft that breaks a rule (end before
  start, doors stated by half, doors outside the event) is not sent. Its row
  says why, and a closed row says it is unsaved.
- **Undo is the page's own history** (`plan/eventHistory.ts`). A step puts an
  event's fields back, and the card then autosaves that like any edit, so the
  write is a new forward `PATCH`, validated and version-checked. Typing in one
  date field is one step. Each colour pick is a step of its own, since a click
  is one decision. Inside a date field, the browser's own undo applies.
- **Not undoable:** creating an event (an explicit submit, a new row) and
  deleting one (owner-only, confirmed, cascades). Both are outside the
  history, as in ADR-0049.
- **Leaving the page** sends what is pending, and asks only when something
  cannot be saved.

The page and its rows follow the missions layout: one list, a row per event
(colour, name, hours, doors) that opens into its fields, the add form above
the list, and a save status with undo/redo buttons kept in view.

## Alternatives considered

**Generalise `useMissionEditing`/`missionHistory` into one module for both
pages.** Deferred. A mission step can be a day write that the server may
refuse. An event step is only ever a draft, so its apply cannot fail except
when the row is gone. One module serving both would carry the mission page's
refusal paths into a page that has none. This is worth revisiting when a
third page needs the pattern. The toolbar and leave guard are the obvious
shared part.

**Snapshot history (`draftHistory.ts`).** Rejected for ADR-0049's reason: the
page is several independent rows, each saved on its own.

**Keep the Save button.** Rejected for ADR-0048's reason: the forgotten save
is the failure.

## Consequences

- Each colour click and each settled date edit is a `PATCH`, an `operations`
  row and a `version` bump. That is the cost ADR-0049 already accepted.
- A reload loses the undo history, not the edits.
- A second tab editing the same event gets a `409`. The row shows the
  server's sentence, and nothing is overwritten without a version check.
