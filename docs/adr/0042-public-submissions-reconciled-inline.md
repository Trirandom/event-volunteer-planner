# ADR-0042: Public form submissions are reconciled inline, and strangers join the pool

**Status:** Accepted · **Date:** 2026-10-08
**Amends:** [ADR-0028](0028-one-volunteer-one-email.md) (the response to an
address already in use), docs/04 §"Public and unauthenticated" (no worker
step), docs/08 §6 and §9, and docs/09 §5 (a public submission can reach the
pool without a coordinator).

## Context

The public route stored each submission as `received` and stopped there.
Reconciliation was left to "the worker", which did not exist. The
coordinator's submissions page lists only submissions resolved to a
volunteer, so a volunteer who sent the form saw a thank-you page and the
coordinator saw nothing. M1's "done when" is the opposite: responses land in
the pool.

Two documents also disagreed with the ladder this pipeline was meant to run.

- docs/09 §5 said a public submission **never** reaches the pool without a
  coordinator resolving it. Step 5 of the ladder (docs/08 §6), *no candidate
  → create volunteer*, says the reverse.
- ADR-0028 said a second person on an address already in use is **refused with
  an explanation**. docs/04 says the response never confirms whether an
  address is known.

## Decision

**The public route reconciles a submission on the same transaction that
stores it, and runs the full ladder, including step 5.**

- **Where it runs.** `evp_db::intake::reconcile`, called by the submit
  handler after `record_submission`, inside its own savepoint. If it fails,
  it rolls back to that savepoint and leaves the submission stored and
  `received`. The volunteer's answers are never lost to a reconcile bug, and
  `evp-cli reconcile --org-id …` retries the submission.
- **What is decided, and where.** The ladder and the field mapping are pure
  functions in `evp-intake` (`reconcile::decide`, `internal_form::derive`).
  The database supplies only the address owner, the trigram candidates and
  the locked columns.
- **What is skipped.** A submission held by the timing floor is not
  reconciled. It waits for a coordinator, whoever it turns out to be.
- **Strangers join the pool.** No candidate creates a volunteer
  (`match_kind = 'new'`). Their participation is `confirmed` for every event
  they offered an `available` window for: they applied, nobody invited them.
- **An address in use is held, not refused.** The submitted address may
  belong to a volunteer whose name does not agree with it. "Agree" means the
  same first name, or a display name similar above the source's threshold. A
  shared last name is not enough, because a couple sharing an address
  usually shares that too. In that case the submission is `needs_review` with
  an `email_in_use` error and the owner as its only candidate. The response
  is `202`, like every other outcome, so the route reveals nothing about who
  is in the pool. The bundle's `email-in-use` branch stays unreached.
- **A revision replaces.** The volunteer's earlier `applied` submission to the
  same form becomes `superseded`, its submitted windows are replaced, and the
  coordinator's list shows each person once.

## Alternatives considered

**Keep docs/09 §5: every public stranger goes to review.** Rejected for now.
The review queue does not exist yet. Under this rule, every first-time
volunteer would vanish exactly as before, and that is the bug this fixes.
The spam defences stay in place (honeypot, timing floor, rate limit, payload
caps). Spam that gets past them now produces a volunteer row that a
coordinator deletes, instead of a review item they reject. That cost is
visible and cheap to undo.

**Reconcile in a background worker.** Rejected for now. There is no outbox
or job runner to build it on, and a poll loop over `received` rows would be
infrastructure built for one caller. The logic does not depend on where it
runs: moving it to the worker later means changing the one call site.

**Refuse an address in use with `409`, as ADR-0028 said.** Rejected: it
answers the question "is this address in your pool?" for anyone who asks,
which docs/04 and docs/12 §5 rule out.

## Consequences

- Responses land in the pool and on the submissions page as soon as they are
  sent.
- `needs_review` rows (ambiguous names, addresses in use) stay invisible
  until the review queue (docs/04 `…/intake/submissions`) is built. Their
  candidates are stored as ids and scores only, never names, because
  `submissions` outlives an anonymised volunteer.
- A spam submission that gets past the defences creates a volunteer. If that
  becomes a real problem, the fix is to send `new` from the public route to
  review once the queue exists. That is one branch in `evp_db::intake`.
- No `audit_log` row is written yet, the same as every other writer until M3.
