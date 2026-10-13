# ADR-0010 — A first-party form is the primary intake channel

**Status:** Accepted · **Date:** 2026-09-10
**Amends:** [ADR-0009](0009-form-agnostic-intake-pipeline.md) — the pipeline
stands; the source priority is inverted.
**Amended by:** [ADR-0027](0027-volunteer-self-service-rights.md) — the token
link's scope widens from revising answers to the full set of data rights, and
its lifetime is tied to the volunteer record rather than to the campaign.

## Context

[ADR-0009](0009-form-agnostic-intake-pipeline.md) chose external forms as the
starting point and deferred a first-party form as a large surface not worth
building yet. It treated the choice as being about *integration convenience*.

That framing missed the product constraint. **A general-purpose form cannot ask
for a time range.** Google Forms, Typeform and Tally offer text, choice,
checkbox and date questions; none offers "select the hours you can work on each
day". The workaround in ADR-0009 was a catalogue of coarse named windows
("Saturday morning") that checkbox labels resolve against, which means:

- A volunteer who can work 14:00–19:30 has to tick "afternoon" and hope, or
  write it in a free-text box nobody parses.
- Availability data is systematically less precise than the shifts it is
  checked against, so `outside_availability` fires on noise and gets ignored.
- The `outside_availability` rule — one of the main reasons to have a
  constraint engine — degrades to decoration.

The limitation is not in our pipeline. It is in what an external form can
express. No amount of mapping work fixes it.

Separately, controlling the questions dissolves the two hardest parts of
ADR-0009 outright: field mapping (the fields are ours, so mapping is identity)
and schema drift (a form we own can be *versioned*, so a submission is pinned
to the exact question set it answered, rather than fingerprinted and guessed
at).

## Decision

**A first-party form is the primary way volunteer data enters the system**, and
it ships in M1. Its defining feature is a real availability picker: per-day,
arbitrary ranges at 30-minute granularity, producing exact `tstzrange` values
rather than resolved labels.

The intake pipeline from ADR-0009 is kept in full — immutable raw submissions,
reconciliation ladder, review queue, replay, audit. It is the right shape
regardless of who authored the form, and it is what lets the first-party form
be *a source* rather than a special case.

What is demoted:

| Was | Now |
| --- | --- |
| CSV upload with a full mapping UI, M1 | **Migration tooling.** Used once to load the existing spreadsheet. Mapping is configuration, not a polished product surface. |
| Google Sheets poll, webhook, generic API, M5 | **Optional escape hatches.** The source abstraction keeps them possible; none is on the roadmap. |
| `intake_slot_options` as the required bridge | **Optional convenience.** Suggested chips in the picker, for volunteers who want to tap rather than drag. Not the only way to express availability. |
| Field and value mapping as core product | **Needed only for foreign sources**, so only for migration. |

Volunteers still do not authenticate ([ADR-0008](0008-no-volunteer-authentication-in-v1.md)).
The form is reached two ways, neither of which is a login:

- a **per-volunteer token link**, emailed to people already in the pool: an
  unguessable capability URL, the same primitive as the ICS feed. Identity is
  certain, so reconciliation is skipped entirely, the form is prefilled with
  what is already known, and it can be reopened to revise an answer.
- a **public link** for volunteers not yet in the pool. Identity is claimed by
  email and goes through the ADR-0009 reconciliation ladder into the review
  queue.

The token link delivers, in v1 and almost for free, the "let volunteers change
their own submission" capability that was previously filed as future work.

## Alternatives considered

**Keep external forms primary, accept coarse availability.** Rejected: it
concedes the precision of the single most valuable input, and it degrades a
constraint the engine exists to check.

**External form plus a separate first-party availability page.** Split the
problem: keep Google Forms for contact details and skills, build only the
availability picker. Genuinely tempting — it is the smallest build that fixes
the actual limitation. Rejected because it means two things to send volunteers,
two submissions to reconcile per person, and two places for a coordinator to
look. Once a form is being rendered and identity is being handled, the
remaining question types are the cheap part.

**A general form builder with conditional logic, i18n, computed fields.**
Rejected as scope. What ships is a fixed set of ten question types, no
branching, two locales. That covers the data described in
[01 — Product spec](../01-product-spec.md) and stops well short of a product in
its own right.

**Drop the intake pipeline now that the form is ours.** Rejected. The
migration still needs it, the review queue is still needed for public
submissions, and immutable raw payloads plus replay remain the reason a bad
interpretation is recoverable. The pipeline is also what keeps a future
external source from being a rewrite.

## Consequences

- Availability becomes precise, so `outside_availability` is worth trusting and
  the coverage picture reflects what volunteers actually said.
- The mapping-UI work drops out of M1: for our own fields, mapping is identity.
  Migration mapping can be a configuration file rather than an interface.
- Schema drift is *solved* rather than detected: `form_versions` pins every
  submission to the question set it answered. Editing a live form is safe.
- Volunteers can revise their own answers via the token link, with no login.
- New work that did not exist before: rendering a public form, an accessible
  and mobile-usable range picker, anti-spam on the public route, and two
  locales. See [09 — Volunteer form](../09-volunteer-form.md).
- A publicly reachable, unauthenticated write endpoint now exists. It is
  mitigated by rate limiting, a honeypot, optional captcha, and — the real
  defence — public submissions never reaching the pool without a coordinator
  resolving them from the review queue.
- The form is a second frontend bundle with a different security context. It
  must not ship the coordinator application's code.
- If an organisation insists on its own Google Form, the source abstraction
  still accommodates it, at coarse availability. That is now their trade-off
  to make rather than the default.
