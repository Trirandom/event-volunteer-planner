# ADR-0008 — Volunteers do not authenticate in v1

**Status:** Accepted · **Date:** 2026-09-10
**Amends:** [ADR-0005](0005-magic-link-authentication.md)
**Amended by:** [ADR-0010](0010-first-party-form-as-primary-intake.md) — the
decision stands, but the cost recorded below ("volunteers cannot correct their
own data") is largely removed: per-volunteer form token links let them revise
their own answers without an account.
**Amended by:** [ADR-0027](0027-volunteer-self-service-rights.md) — that cost is
now removed entirely rather than mitigated. Volunteers still have no accounts
and no sessions; they read, correct and erase their own data through the
capability link, which is not authentication.

## Context

[ADR-0005](0005-magic-link-authentication.md) considered "no volunteer login at
all" and rejected it, on the grounds that volunteers need to *write* their
availability, and routing that through coordinators would recreate the
coordination overhead the project exists to remove.

That reasoning had a gap. It assumed the only way for a volunteer to supply
data is to log in and use our UI. In practice the organisation already collects
this by form — the volunteer fills in a Google Form once, and never needs an
account, a session, or a UI from us at all.

## Decision

**Only organisation members authenticate.** Owners, coordinators and zone leads
sign in with magic links exactly as ADR-0005 describes. Volunteers have no
accounts, no sessions and no authenticated surface.

Volunteer-supplied data arrives through the intake pipeline
([08 — Volunteer intake](../08-volunteer-intake.md)): an external form, a CSV
export, a webhook, or eventually a form of our own.

Two consequences follow directly:

- `member_role` loses its `volunteer` value. An unused role that appears in a
  permission matrix is actively misleading; it is a one-line
  `ALTER TYPE … ADD VALUE` to reinstate.
- `/api/v1/me/*` is removed entirely. The per-volunteer ICS feed survives,
  because it was never authenticated — it is a capability URL carrying an
  unguessable token, delivered in the schedule email.

`volunteers.user_id` stays in the schema, nullable and unused, as the
attachment point if this decision is revisited.

## Alternatives considered

**Magic-link volunteer portal** (the ADR-0005 position). Rejected now that the
form covers data capture. It would mean building and supporting a second
user-facing surface, for a population that logs in perhaps twice a year, to
collect data an existing form already collects. The support burden is real and
falls on the same person who maintains the software.

**Signed read-only schedule links.** Effectively what the ICS feed and the
schedule email already provide. Retained; no login needed.

**Volunteer accounts, but read-only.** The worst of both: all of the account
lifecycle — invitations, deliverability, "I never got the link", session
management — for none of the write capability that would justify it.

## Consequences

- The authenticated attack surface shrinks to organisation staff: a few dozen
  people who can be told things, rather than several hundred who cannot.
- No volunteer account lifecycle: no invitations to volunteers, no session
  support requests, no onboarding.
- Volunteers cannot correct their own data. A wrong phone number is a message
  to a coordinator, or a resubmission of the form. This is the real cost, and
  it is mitigated by the form's own edit-response link where the provider
  offers one ([08 §10](../08-volunteer-intake.md#10-volunteers-revising-their-own-answers)).
- Availability quality now depends on form design rather than on our UI. The
  slot-option catalogue exists partly to constrain that.
- Shift swapping between volunteers becomes strictly a v2 feature, requiring
  this decision to be revisited rather than merely extended.
