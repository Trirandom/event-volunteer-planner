# ADR-0048 — A form draft saves itself, and its undo is the editor's

**Status:** Accepted · **Date:** 2026-11-16
**Amends:** [ADR-0024](0024-server-side-undo-and-per-item-bulk.md) (its scope),
[14 §4 "Undo"](../14-accessibility-and-interaction.md#undo), [09 §2](../09-volunteer-form.md)

## Context

The form builder had a Save button, a "Discard changes" button and a Publish
button side by side. Once publishing moved to its own tab, the explicit save
guarded nothing the draft/publish split does not already guard: a draft is
invisible to volunteers until it is published, so saving it is not a decision
worth a button. What it did add was a step to forget, and an unsaved-changes
dialog on every tab switch. A builder that reorders by drag also needs an undo,
and Ctrl/Cmd+Z is where a coordinator will look for it.

[ADR-0024](0024-server-side-undo-and-per-item-bulk.md) and docs/14 say that
Ctrl/Cmd+Z works on a server-side stack of **domain operations**, and they
reject client-side undo over optimistic state. Taken literally, that covers
the form draft too, because each `PUT …/versions/{v}` already writes an
`operations` row.

## Decision

**The draft saves itself.** About a second after the last edit, the builder
sends the whole draft (`PUT …/versions/{v}`, the same atomic replacement as
before). There is no Save button and no Discard button. A draft that breaks a
save rule (an empty French label, say) is not sent; the toolbar says how many
problems block saving until they are fixed. A concurrency conflict stops
autosave until the coordinator reloads, so a second tab is never silently
overwritten. Leaving the page saves what is pending first, and only asks when
that is impossible.

**Undo in the builder is the editor's own history**, not the operations
stack. Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (or Ctrl+Y) step through the draft's
states in this page, with matching buttons in the toolbar. Typing in one field
is one step, not one per keystroke. Inside a text field the browser's own text
undo still applies. An undo is just another edit, so it is autosaved like any
other.

**ADR-0024's undo is unchanged for domain operations.** An unpublished draft is
a working copy: volunteers never see it, nothing depends on any of its
intermediate states, and the domain action is **publishing**, which freezes a
version (docs/09 §2). The `operations` rows draft saves write stay as they are,
for the audit trail ADR-0024 builds on.

## Alternatives considered

**Server-side undo of draft saves through `POST …/operations/{id}/undo`.**
Faithful to ADR-0024, and it would survive a reload. Rejected for now. With
autosave, one operation is one save window, so an undo step would be
"whatever happened in that second" rather than one edit. It also needs the undo
endpoint, which is not built, for something that is never seen by anyone
outside the editor. It can come later on top of this; nothing here prevents it.

**Keep the Save button and add undo only.** Rejected: the explicit save was the
part coordinators got wrong, and with a separate Publication tab it guards
nothing that the draft/publish split does not already guard.

**Save on every keystroke.** Rejected: it is a `PUT` of the whole form per
character, and the etag would move under the coordinator's own feet.

## Consequences

- Reloading the page loses the undo history (not the draft, which is saved).
  This is the property ADR-0024 rejected for domain operations; for a working
  copy it is what every editor does.
- Two tabs on the same draft: the second save meets a `409`, autosave stops,
  and the coordinator chooses to reload. Nothing is overwritten unasked.
- The "leave without saving?" dialog now appears only when the draft cannot
  be saved (problems or a failed request), not on every unsaved edit.
