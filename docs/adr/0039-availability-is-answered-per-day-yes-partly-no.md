# ADR-0039 — Availability is answered per day: «Oui» / «En partie» / «Non»

**Status:** Accepted · **Date:** 2026-09-30
**Amends:** [09 §3](../09-volunteer-form.md#3-the-availability-picker) (the
picker's input paths and day rows) and [14 §5](../14-accessibility-and-interaction.md#5-the-volunteer-form).

## Context

docs/09 §3 specified the picker as zero or more ranges per day, entered three
ways at once: suggested chips, a drag track, and two always-visible `HH:MM`
inputs. It was written before the real festival was loaded.

The Soundclash 26 worked example (`crates/evp-domain/src/example.json`) says
something the spec did not anticipate: **every event is a single operational
day.** Open Air 10:00 → 01:00, Dub & 2step 13:00 → 08:00, Dnb & Dubstep
14:00 → 09:00. The volunteers' actual answers are coarse — most often the whole
event, otherwise a block such as the evening or the night. A form covering the
festival is therefore six questions of the form "can you do this night?", and
the common answer is one word.

Measured against that, the §3 control asks too much of everyone to serve the
few. Three input paths on each of six rows is a long page on a phone, and the
drag track is the costliest part — a slider pair for 2.5.7, pointer handling
that fights page scroll — for the least used answer.

Two other shapes were considered and rejected. **Per-shift checkboxes** give
~30 boxes a night on the Dub & 2step, too small at 400 px, and they tie the
answer to shifts that may not be planned yet (09 §9). **Fixed
morning/afternoon/evening/night toggles as the only answer** cannot say
«20h → 5h», which is why the old form's labels were unusable (docs/10).

## Decision

**Each day row is one native radio group, «Oui» / «En partie» / «Non»,
neither preselected.**

- **«Oui»** writes one `available` window covering the row. **«Non»** writes
  one `unavailable` window covering the row (the former "not available at all
  on this day"). An unanswered row writes nothing.
- **«En partie»** reveals chips and, behind a native `<details>` «Autre
  horaire…», two text inputs that accept `14h30`, `14:30`, `14.30` and `1430`.
  Typed ranges snap *inward* to `availability_step_minutes`, are clamped to the
  row, and the volunteer is told when either happened. Ranges merge as §3
  already requires (overlapping and touching).
- **Chips** are the event's `intake_slot_options` clipped to the row. With
  none, the row is cut at 06:00 / 12:00 / 18:00 / 00:00 into Matin /
  Après-midi / Soir / Nuit; a piece under two hours joins its neighbour, and a
  row under four hours offers no chips. Un-pressing a chip subtracts its range.
- **Day rows start at the event's opening wall-clock time**, not at midnight
  and not at a fixed dawn cutoff: a 13:00 → 08:00 night is one row of the day
  it starts on. A multi-day event gets one row per day and a «Tous les jours :
  Oui / Non» shortcut.
- **The drag track is dropped.** Typed entry remains the precise path, which
  was already the accessible one (2.5.7 is met without dragging at all).
- A required availability question needs at least one `available` window
  somewhere in scope. «En partie» with nothing chosen is an error on its row.

The output is unchanged: exact `availability_windows` bounds per event, so
nothing downstream resolves labels, and `outside_availability` stays soft.

## Consequences

- The common festival form is answered in one tap per event.
- 09 §3's "numeric inputs always present, never behind a mode switch" is
  relaxed to "one tap away, and always present when the row has no chips". The
  inputs are still native text fields with visible labels.
- A time that does not exist or is ambiguous on a DST night resolves with
  `compatible` disambiguation rather than being refused at the field
  (docs/16 §5). Festivals do not open at 02:30 on the last Sunday of October;
  if one does, this is the line to revisit.
- Implemented in `apps/form/src/availability/`.
