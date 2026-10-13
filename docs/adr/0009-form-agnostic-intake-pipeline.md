# ADR-0009 — A form-agnostic, replayable intake pipeline

**Status:** Accepted · **Date:** 2026-09-10
**Amended by:** [ADR-0010](0010-first-party-form-as-primary-intake.md) — the pipeline stands, but a first-party form is now the primary source; external forms and CSV are demoted to migration and escape hatches.
**Amended by:** [ADR-0028](0028-one-volunteer-one-email.md) — the ladder is
unchanged, but an address identifies at most one volunteer, so a second person
claiming a known address is refused with an explanation rather than queued as a
supported duplicate.

## Context

With no volunteer login ([ADR-0008](0008-no-volunteer-authentication-in-v1.md)),
every fact a volunteer supplies arrives from a form the organisation already
uses — most likely Google Forms, possibly Typeform or Tally, possibly a CSV
someone assembled by hand.

The naive implementation is an import function: read the CSV, parse the
columns, write the rows. It fails in four specific ways, all of which corrupt
data quietly rather than erroring:

1. **Mapping mistakes are unrecoverable.** Realising a column went to the wrong
   field means re-exporting, or repairing rows by hand.
2. **Schema drift is silent.** A question inserted into the form shifts every
   column after it, and the next import writes plausible-looking rubbish.
3. **Re-imports duplicate or clobber.** Including clobbering the corrections a
   coordinator just made by hand.
4. **Identity is guessed, and the guess is invisible.** Two people named Martin
   Dupont get merged, and nothing records that a decision was made.

## Decision

A staged pipeline with **raw submissions stored immutably, and separately from
the mapping that interprets them.**

```
source → submissions (raw jsonb) → map → validate → reconcile → apply
```

Four elements carry the design:

- **`submissions.raw`** is never modified. Mapping derives from it, so
  correcting a mapping and replaying is the normal repair path — no re-export,
  no manual data fixing.
- **Two mapping layers.** `intake_field_mappings` says where an answer goes;
  `intake_value_mappings` says what an answer *means* (`"Large"` → `"L"`,
  `"Oui"` → grant `first_aid`, `"Samedi matin"` → a slot option). The value
  layer is what is normally hard-coded and then becomes unmaintainable.
- **`intake_slot_options`** — a per-event catalogue of named windows with
  concrete `tstzrange` values. This is the only sane bridge from a checkbox
  label to a time range, and it doubles as the generator for the form's own
  options.
- **`schema_fingerprint`** per source. New questions hold a batch for review;
  a vanished required question refuses the batch outright.

Sources are pluggable and all land in the same table: CSV upload, Google Sheet
poll, HMAC-verified webhook, generic API key endpoint, and later an internal
form.

Identity reconciliation is an explicit ladder ending in a review queue, and
**never auto-matches on name alone** — a second corroborating field is
required, because wrongly merging two people is much worse, and much harder to
undo, than a duplicate a coordinator merges in seconds.

## Alternatives considered

**A direct import function per source.** Less code today. Rejected on the four
failure modes above; each of them costs more to repair once than the pipeline
costs to build.

**Build our own form immediately, and support nothing else.** Removes the
entire mapping and drift problem — the fields are known because we defined
them. Rejected as the *starting* point: it is a large surface (question types,
conditional logic, i18n, anti-spam, accessible rendering) that must be finished
before any data can be collected, and it forces the organisation to abandon a
form that already works. Deliberately kept reachable, though: because
`intake_fields` is already a typed form description, an internal form is a
source whose fields are authored rather than discovered, with mapping and drift
handled by construction. See [08 §9](../08-volunteer-intake.md#9-our-own-form-as-a-source).

**Direct Google Forms API integration.** Rejected in favour of reading the
*Sheet* the form writes to: it needs no Forms-specific API, works with sheets
that were never a form, and is the same connector that migrates the existing
spreadsheet.

**A mapping DSL or user-supplied transform scripts.** More expressive, and a
sandboxing and debugging problem. The declarative transform set (trim, split,
case, date format, empty-as-null) covers the observed cases; anything stranger
is better fixed in the form.

**Learned/fuzzy matching that improves from coordinator decisions.** Rejected:
a matcher that changes behaviour silently produces mistakes nobody can explain,
in a system whose value proposition is that it is trustworthy.

## Consequences

- Any form tool works on day one, via CSV, with no integration work.
- Mapping errors are recoverable by replay rather than by data repair. This is
  the single biggest practical benefit.
- Form changes are detected and halt the import instead of corrupting records.
- Re-imports are idempotent, via `UNIQUE (source_id, external_id)`.
- Coordinator corrections survive re-import, via `volunteers.locked_fields`.
- Every identity decision is auditable and attributable.
- Costs: seven additional tables, a mapping UI that is a genuine piece of
  frontend work, and raw payloads retained indefinitely — which is also
  personal data, so it falls under the same retention and erasure rules as
  `volunteers` and must be included in anonymisation.
- `submissions` is the largest table in the schema by row count. Still trivial
  at this scale: a few thousand rows per campaign.
