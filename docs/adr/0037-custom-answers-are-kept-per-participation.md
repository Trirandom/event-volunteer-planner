# ADR-0037 — Answers with no domain column are kept per participation; a question's requiredness is the coordinator's

**Status:** Accepted · **Date:** 2026-09-30
**Amends:** docs/03 §3.11 (`form_question_target`), and
[ADR-0012](0012-name-parts-asked-not-parsed.md) on who decides whether
`last_name` is required.

## Context

A real form asks things no column exists for. Soundclash's asked «Je souhaite
faire partie de l'équipe de fly / affichage en ville», «Niveau d'expérience au
bar et en évent», «Précisions éventuelles sur vos disponibilités», attendance
at the info meeting on 2 September, and whether to be added to the WhatsApp
group. Coordinators filter on these for weeks.

docs/03 §3.11 requires every answerable question except `availability` and
`consent` to carry a `target_path`, and every target is a column. A
question with no column to target therefore cannot exist. Worse, the only
record of its answer would be `submission_payloads.raw`, which is deleted
30 days after arrival ([ADR-0026](0026-retention-scope-is-a-table-registry.md)).
Recruitment opens months before the event, so the answer would be gone
before anyone assigned the shifts it was asked for.

Separately, ADR-0012 made `last_name` optional because mononyms are real, and
the form docs present that as fixed. Some organisations need a surname
(accreditation lists sent to a venue, a bar licence roster). The mononym
argument is about the default, not about forbidding a coordinator who has a
reason.

## Decision

**A question may have no `target_path`. Its answers are kept per
participation, pinned to the question that asked them.**

```sql
CREATE TABLE participation_answers (
  participation_id uuid NOT NULL,
  question_id      uuid NOT NULL,          -- form_questions(id): the version's own question
  org_id           uuid NOT NULL,
  value            jsonb NOT NULL,         -- typed by the question's kind
  source_submission_id uuid REFERENCES submissions(id) ON DELETE SET NULL,
  PRIMARY KEY (participation_id, question_id),
  -- composite FKs to participations and form_questions, both carrying org_id
);
```

- **Event tier.** Purged with the event, `event_data_days` after it ends.
  That is the retention the question's purpose implies: it was asked about
  this edition. No new sweep logic is needed, because the table hangs off
  `participations` like `availability_windows` does.
- **Pinned to `question_id`, not to a label.** An answer is read against the
  version that asked it (09 §2). A reworded question in a later version is a
  different `question_id`, and its answers are kept apart.
- **Replaced on resubmission**, scalar-style: a later submission's answer to
  the same question wins, and an answer left empty clears it.
- **Kinds that may be untargeted:** `short_text`, `long_text`, `single_choice`,
  `multi_choice` (without `skill_id`), `boolean`, `date`. `email` and `phone`
  always target the volunteer's contact columns. A second phone number nobody
  can SMS is a trap.
- **Sensitive by declaration.** A question may be marked `is_sensitive`. Its
  answers are then excluded from default exports and hidden from zone leads,
  as `dietary` already is ([09 §8](../09-volunteer-form.md#8-privacy)).

**Requiredness is the coordinator's, per question, with two fixed points.** The
form editor inserts the built-in questions: `first_name`, `last_name` and
`email` always, and `phone` offered. `first_name` and `email` are always
required, because the public route cannot reconcile without an address and
greeting needs a name. Every other built-in, `last_name` included, defaults
as its ADR says (`last_name` optional) and may be made required on a given
form. The consent rules of ADR-0025 are unchanged and remain enforced by
constraint and at publish.

## Alternatives considered

**Keep the payload as the only record.** Rejected: 30 days is shorter than a
recruitment campaign.

**Extend the payload's retention for festival forms.** Rejected: the payload
is the verbatim record of everything typed, including answers that were
mapped elsewhere. Keeping all of it longer to preserve a few answers is the
trade ADR-0026 already refused.

**A `volunteers.extra jsonb` column.** Rejected: that is the pool tier, so a
per-edition answer ("I'll be at the 2 September meeting") would survive
eighteen months, and a jsonb column on the person has no version to read an
answer against.

**Keep `last_name` fixed as optional.** Rejected on the organisations that
need it. Making it always required was rejected for the reason in ADR-0012.

## Consequences

- `form_question_target` is relaxed: an untargeted question is valid for the
  kinds above. Publish still refuses a version with no `first_name` and
  `email` targets.
- A festival-scoped submission writes its custom answers to each participation
  it creates ([ADR-0035](0035-a-form-can-cover-a-festival.md)), so the answers
  survive until the last of those events is purged. Duplicated rows, but each
  one follows its own event's clock with no special case.
- Coordinators can filter the submissions and assignments pages on these
  answers. That is the point.
