# ADR-0036 — A `missions` question: which missions a volunteer could do

**Status:** Accepted · **Date:** 2026-09-30
**Amends:** [09 §1](../09-volunteer-form.md#1-scope) (ten question types become
eleven) and docs/03 §3.11.

## Context

The Soundclash form asked two questions about missions, «Postes préférés lors
des événements» and «postes possibles». The seeded example still carries the
first, verbatim, as free text. Coordinators read it while assigning, and it is
the second most useful input after availability: someone who will not work the
bar should not be offered to it.

docs/09's question types have no way to ask this. The nearest is
`multi_choice` whose options carry a `skill_id`, but a mission is not a skill.
A skill is a standing property of a person that outlives every event ("has
PSC1"). "Would do the bar" is what someone says about one production, and it
names rows that exist per event (ADR-0032). A `multi_choice` with
hand-typed option labels could ask the question, but the answer would be a
string nobody can join to a location, and a mission renamed on the missions
page would silently stop matching.

## Decision

**An eleventh answerable kind, `missions`, at most one per form version.**

- **One level: *possible*.** Each mission is ticked or not. A second
  "preferred" level was considered and dropped by the coordinators: what they
  act on is whether someone is willing, not a ranking, and every extra level is
  a column of ticks on a phone.
- **Options are the scope's missions, frozen per version.** A draft proposes
  the festival's (or event's) missions, folded by name exactly as the missions
  page folds them (`apps/admin/src/plan/missionCatalog.ts`), so "Bar" is one
  option even though it is four `locations` rows. The coordinator may untick
  missions not worth offering (a core-team-only post) and reword labels.
  Publishing stores the list in `options`, and each option's `value` is the
  folded name key.
- **Answers are stored per participation, per location.** Applying a submission
  writes, for each event participation it creates
  ([ADR-0035](0035-a-form-can-cover-a-festival.md)), one row per location in
  that event whose folded name matches a ticked option:

  ```sql
  CREATE TABLE participation_missions (
    participation_id uuid NOT NULL,
    location_id      uuid NOT NULL,
    org_id           uuid NOT NULL,
    source_submission_id uuid REFERENCES submissions(id) ON DELETE SET NULL,
    PRIMARY KEY (participation_id, location_id),
    -- composite FKs to participations and locations, both carrying org_id
  );
  ```

  Event tier: purged with the event, like availability. Replaced wholesale on
  resubmission, for the same reason availability is
  ([08 §8](../08-volunteer-intake.md#8-revisions-and-precedence)): ticking
  fewer missions has to be a way of saying "not those any more".
- **Information, never a constraint.** Assigning someone to a mission they did
  not tick is not refused, and in v1 not even warned about. It becomes an
  input to the candidate list's ordering on the assignments page. A soft
  `mission_not_offered` rule can be added later under ADR-0007 without
  revisiting this.

## Alternatives considered

**`multi_choice` with free-text options.** Rejected above: the answer cannot
be joined to a location, and it breaks silently on a rename.

**Store the chosen names rather than location rows.** Survives a location
being deleted and recreated, but it moves the fold into every query that reads
it and leaves a dangling name when a mission is renamed. Location rows cascade
correctly and are what the assignments page already keys on.

**Treat missions as skills.** Rejected: a skill outlives events and sits in
the pool tier. Folding "would work the bar at Soundclash 26" into a
permanent attribute would keep a per-edition statement for eighteen months.

## Consequences

- One more `form_question_kind` value, one partial unique index, one event-tier
  table with its `retention_scope` row.
- A mission added after publish is not offered until a new version is
  published. That is the versioning rule working as intended
  ([09 §2](../09-volunteer-form.md#2-versioning-replaces-drift-detection)).
- A mission renamed after publish keeps its old label on the form. Answers still
  resolve if the folded key is unchanged, and resolve to nothing (visibly, in
  the submission view) if it is not.
