# ADR-0012 — Names: a verbatim display name, plus optional parts that are asked, never parsed

**Status:** Accepted · **Date:** 2026-09-10
**Supersedes:** [ADR-0011](0011-single-display-name-not-first-last.md)

## Context

[ADR-0011](0011-single-display-name-not-first-last.md) removed `first_name` and
`last_name`, on the evidence that the real pool contains mononyms, stage names,
emoji and four-token names, so splitting a combined "Prénom et nom" field is
wrong for most of it.

That evidence is sound, but the conclusion drawn from it was too broad. It
conflated two different things:

- **deriving** name parts by parsing a combined string — unsound, as shown; and
- **having** name parts at all — which ADR-0011 discarded without examining
  what they are for.

Two requirements make the parts genuinely necessary:

1. **Communication uses the first name alone.** "Bonjour Camille" is correct;
   "Bonjour MARCHAND Aurel" is not, and that is what greeting with
   `display_name` produces for any surname-first entry — which is a large
   fraction of the existing pool.
2. **The surname disambiguates.** In a pool of several hundred, two volunteers
   share a first name routinely. A coordinator picking "Camille" from the
   candidate panel needs the surname to know which Camille, and a printed
   roster needs it for the same reason.

ADR-0011 also missed that this cuts the other way for matching: a surname is a
*better* corroborating field than the birthdate or phone number it proposed,
because a form always asks for it and volunteers reliably fill it in.

The decisive change since ADR-0011 is [ADR-0010](0010-first-party-form-as-primary-intake.md):
we now own the form. Parts do not have to be parsed out of anything — the form
can simply ask two questions.

## Decision

Three name columns. The parts are **asked**, never derived.

```sql
-- The roster label and the truth of what this person calls themselves.
-- Stored verbatim, never parsed. Required.
display_name  text NOT NULL,
-- Generated, for search and fuzzy matching only. Never displayed.
display_name_norm text NOT NULL GENERATED ALWAYS AS (...) STORED,
-- What we call them in a greeting. Asked directly by the form.
first_name    text,
-- Disambiguation, and a corroborating field for reconciliation. Asked directly.
last_name     text,
-- Optional, so 'SURNAME Firstname' entries can sort sensibly.
sort_name     text,
```

Rules:

- **The form asks `first_name` and `last_name` as separate questions.** The
  first-name question is worded as "what should we call you", so a volunteer
  known by a scene name puts that, and it is the greeting. `last_name` is
  optional, because mononyms are real.
- `display_name` defaults to `first_name || ' ' || last_name` when the form
  supplied both, and is a stored, editable column rather than a generated one —
  so a coordinator can set it to `"Gibson"` or `"Chaumette Ludo (Ptilud)"`
  without that contradicting the parts.
- **Greeting** is `coalesce(first_name, display_name)`.
- **Rosters and the candidate panel** show `display_name`. Where two candidates
  share a `first_name`, the UI additionally shows `last_name` — this is the
  requirement that motivated keeping it.
- **Legacy CSV import leaves the parts `NULL`** and fills `display_name` only.
  A coordinator-confirmed split assistant may *suggest* parts over the imported
  pool, showing its guess per row; nothing is written without confirmation. No
  automatic splitting, ever — that part of ADR-0011 stands unchanged.
- `last_name`, when present on both sides, becomes a corroborating field in
  step 3 of the reconciliation ladder
  ([08 §6](../08-volunteer-intake.md#6-identity-reconciliation)).

## Alternatives considered

**Keep ADR-0011 as written** (display name only). Rejected: it makes every
greeting use the full stored string, which reads wrong for surname-first
entries, and it gives the candidate panel no way to distinguish two people with
the same first name — the two concrete problems raised against it.

**Parts canonical, `display_name` generated from them.** Rejected: it has
nowhere to put the imported pool, whose parts are unknown, and nowhere to put a
scene name that is neither a first nor a last name. It also makes
`display_name` unable to preserve `"Karim BELKACEM TERRIER"`, where whether
`BELKACEM` is a middle name or half a compound surname is not knowable.

**Parts only, no `display_name`.** Rejected for the same reasons, plus it
discards the verbatim value, which is the one thing that is certainly correct.

**Add a fourth `known_as` column for scene names.** Rejected as unnecessary:
wording the first-name question as "what should we call you" lets
`first_name` carry it, which is exactly where the greeting reads from.

**Structured name parts** (given/family/particle/suffix/preferred). Still
rejected as disproportionate, for the reasons in ADR-0011.

## Consequences

- Greetings read correctly, which was the point.
- The candidate panel and printed rosters can disambiguate two volunteers
  sharing a first name.
- Reconciliation gains a corroborating field that is more reliably present than
  birthdate or phone, so step 3 fires more often and the review queue shrinks.
- The imported legacy pool has `NULL` parts, so those volunteers are greeted by
  `display_name` until someone fills in a first name. Acceptable, visible in
  the pool list, and fixable in bulk with the split assistant.
- Three name columns can disagree with each other — `display_name` is not
  derived, so it can drift from the parts. Accepted deliberately: the
  alternative is a generated column that cannot represent the real pool.
- The form has one more question than it would otherwise. Trivial against the
  availability picker beside it.
