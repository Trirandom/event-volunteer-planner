# ADR-0027 — Volunteers read, correct and erase their own data at any time, through their capability link

**Status:** Accepted · **Date:** 2026-09-10
**Amends:** [ADR-0008](0008-no-volunteer-authentication-in-v1.md) — volunteers
still have no accounts and no sessions; the cost it recorded ("volunteers cannot
correct their own data") is now removed rather than merely mitigated.
**Amends:** [ADR-0010](0010-first-party-form-as-primary-intake.md), which gave
the token link revision of *answers*; this extends it to the full set of data
rights, and fixes their retention consequence.

## Context

Three documents already promise this and one denies it.

- [01 §6](../01-product-spec.md#6-privacy): volunteers can have their data
  erased "**at any time**, self-service from their form link".
- [15 §6](../15-privacy-and-retention.md#6-volunteer-rights-in-practice):
  erasure, access, portability, rectification, objection and withdrawal, each
  with a route that does not require an account.
- [ADR-0010](0010-first-party-form-as-primary-intake.md): the token link
  delivers "let volunteers change their own submission" in v1.
- [04](../04-api.md#public-and-unauthenticated): "There is **no**
  volunteer-facing write endpoint of any kind. Volunteers change their data by
  resubmitting the form."

The last statement is false in its own document — the public submission endpoint
is a volunteer-facing write, two paragraphs above it — and the rights it denies
have no endpoints anywhere in the API surface. A right with no route is not a
right, and "resubmit the form" does not erase anything, does not export
anything, and does not work at all once the campaign's form is closed.

There is also a retention interaction that made the promise hollow even where it
was believed. The sweep deleted `form_invite_tokens` at the event boundary,
while a consenting volunteer's record survives for eighteen months — so for
seventeen of those months the self-service route did not exist.

## Decision

**There is a volunteer surface. It is capability-scoped, not authenticated, and
it is a first-class part of the product.**

### The link is the identity, and it lasts as long as the record

A volunteer's `form_invite_token` is pool-tier and survives with their
`volunteers` row ([ADR-0026](0026-retention-scope-is-a-table-registry.md)). It
is revoked when the record is anonymised or deleted, rotatable wholesale, and
revocable individually. It grants exactly one volunteer's own data and nothing
else — the same terms as the ICS feed
([12 §7](../12-security.md#7-capability-urls)).

### What the link can do

```
GET    /api/v1/public/me                    ?t=   → what we hold, as the form shows it
PATCH  /api/v1/public/me                    ?t=   → correct pool fields (name parts, contact, size, dietary)
PATCH  /api/v1/public/me/preferences        ?t=   → notify_email, notify_sms, pool_retention consent
POST   /api/v1/public/me/export             ?t=   → 202; the full export is emailed, not returned inline
POST   /api/v1/public/me/erasure            ?t=   → 202; sends a confirmation to the address on record
POST   /api/v1/public/erasure/confirm       { token } → executes the erasure
```

Answering questions stays where it was —
`POST /api/v1/public/forms/{slug}/submissions?t=` — and remains the normal way
to give or revise availability. The `/me` routes exist because the rights must
work when no form is live, which is most of the year.

### The rules that keep it safe

- **Erasure needs two independent proofs**, as
  [ADR-0018](0018-purpose-based-retention.md) required: holding the link, and
  receiving mail at the recorded address. The link only ever *initiates* it.
- **Withdrawal and opt-out need no confirmation.** Stopping processing is not
  destructive, so it is frictionless in a way deletion is not. Withdrawing
  `pool_retention` runs the deletion the sweep would have performed
  ([ADR-0025](0025-two-consents-processing-and-pool-retention.md)).
- **Correction is bounded to the volunteer's own pool fields.** It cannot touch
  `locked_fields` a coordinator has corrected by hand
  ([08 §8](../08-volunteer-intake.md#8-revisions-and-precedence)) — a
  coordinator fixing a misspelling must not be undone by the same bad answer
  arriving again — and it cannot touch assignments, participation status, or
  anything about another person.
- **Event answers follow the event.** Availability and other per-edition
  answers are revisable while that event's intake is open. Once the event's data
  has been purged there is nothing to revise, and `/me` shows the pool record
  only. This is a consequence of retention, not a restriction, and the page says
  so.
- **The full export is emailed rather than returned to the browser**, because a
  forwarded link should not hand over a complete personal record in one request.
  What `GET /me` returns inline is what the prefilled form already showed.
- Rate limited per token and per IP; `Referrer-Policy: no-referrer`; every action
  written to `audit_log` with the token id as actor. A revoked token and an
  unknown one return the same generic response.

### What this is still not

No volunteer session, no password, no account lifecycle — ADR-0008 stands
entirely. No write to assignments, no shift swapping, no confirming attendance:
those need an identity stronger than a forwardable link and a proposal state
machine, and they remain the v2 features that revisit ADR-0008.

## Alternatives considered

**Leave it as "resubmit the form", as 04 said.** Rejected: it satisfies
rectification only while a form is live, and it satisfies erasure, access and
objection not at all. It also contradicts two other documents and a product
requirement.

**Route every request through a coordinator.** The ADR-0008 position. Rejected:
it is the coordination overhead the project exists to remove, it makes a
statutory response time depend on a volunteer's email being read, and it means a
volunteer must ask a human to delete their allergy from a spreadsheet-shaped
system. Coordinators keep the ability to act on request; they stop being the
only route.

**Give volunteers accounts for this.** Rejected, as in ADR-0008: the full
account lifecycle for a population that logs in twice a year, to do something a
capability URL already does safely.

**A one-time link per rights request** ("email me a link to delete my data").
Marginally tighter, and rejected as the primary route: it requires the volunteer
to already be able to reach a page that offers it, which is the problem being
solved. It is exactly what the erasure *confirmation* is, and that is where the
one-time link belongs.

**Immediate erasure on the link alone.** Rejected: the link is forwardable, so
one click by whoever received it would destroy someone else's record
irreversibly. The confirmation step is the compensating control that makes a
forwardable capability acceptable for a destructive action.

## Consequences

- Every right in [15 §6](../15-privacy-and-retention.md#6-volunteer-rights-in-practice)
  has a route, and the one-month statutory response window is met by the
  software rather than by someone remembering.
- The blanket claim in 04 is replaced by an accurate one: there is no volunteer
  *session*, and the volunteer's writes are capability-scoped to their own
  record.
- The form bundle grows a small "your data" surface beside the form itself. It
  is the same bundle, the same accessibility treatment, and no admin code.
- A forwarded link can still read and correct that volunteer's record. Accepted
  and unchanged from [ADR-0010](0010-first-party-form-as-primary-intake.md);
  destructive actions are the ones given a second proof.
- Coordinators lose nothing: they can still act on request, and the audit log
  now distinguishes a change the volunteer made from one a coordinator made on
  their behalf.
- `locked_fields` gains a second reason to exist, and the interaction needs
  stating in the UI: a field a coordinator has corrected is shown to the
  volunteer as needing a message rather than silently ignoring their edit.
