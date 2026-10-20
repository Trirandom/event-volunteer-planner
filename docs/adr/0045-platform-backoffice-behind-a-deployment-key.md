# ADR-0045 — A platform backoffice, behind a key the deployment holds

**Status:** Accepted · **Date:** 2026-10-20
**Amends:** [ADR-0031](0031-password-bootstrap-credential.md) — "this is not a
general password login" still holds for sign-in, but a password can now be set
by somebody other than the bootstrap.

## Context

A deployment can create exactly one organisation and one owner, once: the
bootstrap credential ([ADR-0031](0031-password-bootstrap-credential.md)) is read
only while `users` is empty. Past that point the documented paths are
`evp-cli create-org` and invitations, and neither exists — the CLI subcommand
is a stub that `bail!`s, and invitations need magic links, which need the
outbox (docs/07 M0). So the second organisation on a deployment, and the second
coordinator in any organisation, can today only be created by hand in
`just psql-admin`.

That is the gap Soundclash 26 falls into: one festival, run by an organisation
that is not the bootstrap one, with several coordinators who each need an
account. The operator needs to create organisations, create accounts, and say
who belongs where — without a shell on the database host, and without waiting
for M0's invitation flow.

Two things make this different from every route the API already has:

- **It is not tenant-scoped.** Listing organisations, or adding a member to one
  the caller does not belong to, is precisely what the RLS policies exist to
  forbid. Every existing policy keys on `app.current_org_id` or
  `app.current_user_id`, and neither describes "the operator of this
  deployment".
- **There is no user behind it.** The operator is whoever holds the deployment's
  configuration. On a fresh install that person has no account, and making them
  create one first would be the bootstrap problem again.

## Decision

**A backoffice under `/api/v1/backoffice/…`, authorised by a key in the
environment (`EVP_BACKOFFICE_KEY`), and switched off entirely when that key is
absent or blank.**

### The key

- `EVP_BACKOFFICE_KEY`, or `EVP_BACKOFFICE_KEY_FILE` like any other variable.
  Blank is absent — an unset Compose interpolation arrives as `""`, and that
  must mean "off", not "the empty key".
- **At least 32 characters**, refused at startup otherwise. It is a bearer
  credential for every tenant on the deployment, and unlike a password nobody
  has to remember it: `openssl rand -hex 32` is the expected source.
- Not in `FILE_ONLY`, for ADR-0031's reason: a key the operator cannot put in
  `.env` is a key nobody turns on. Startup warns when the plain form is used.
- Presented as `Authorization: Bearer <key>`. A standard header rather than an
  `X-…` one because Caddy's access log redacts `Authorization` by default and
  would log a custom header verbatim. And because no browser attaches it on its
  own, a header-borne credential has no CSRF exposure — which a cookie would.
- Held in memory as its SHA-256 and compared in constant time (`subtle`).
  Hashing first makes the comparison length-independent, so a wrong key's
  length is not measurable either.

### Off means absent

With no key configured, every backoffice route answers `404` — the same answer
as a path that does not exist. A deployment that has not opted in does not
advertise that it could. With a key configured, a missing or wrong one is
`401`.

The routes carry their own rate limit (a bucket store separate from login's
and the form's), keyed on the client address the same way
([ADR-0031](0031-password-bootstrap-credential.md)). A 32-character random key
is not guessable at any rate; the limit is what bounds the *cost* of somebody
trying.

### The database scope: `app.backoffice`

The extractor that checks the key opens the transaction and runs
`set_config('app.backoffice', 'on', true)` — `SET LOCAL`, for the reason every
GUC here is (docs/02 §3). A migration adds permissive policies keyed on it:

| Table | Commands | Why |
| --- | --- | --- |
| `organizations` | `SELECT`, `INSERT` | list and create. No `UPDATE`/`DELETE`: renaming is an owner's job, and deleting cascades through every event the tenant ran. |
| `memberships` | `SELECT`, `INSERT`, `UPDATE`, `DELETE` | assign, change role, unassign — the whole point. |

Nothing else is widened. Volunteers, events, forms and submissions stay
invisible to the backoffice: it administers *who may act*, not what they act
on. `users` and `identities` carry no RLS (docs/03) and need nothing.

**Why not `BYPASSRLS` or a second role.** A second pool as a role that bypasses
RLS would see *every* table, so "the backoffice cannot read volunteers" would
become a property of the handlers rather than of the schema — exactly the
inversion docs/02 §5 rules out. The GUC keeps the boundary where every other
one is: in a policy a reviewer can read.

**Why not `SECURITY DEFINER` functions.** For the reason migration
`20260915100600` gives: it moves the rule into a function body the next reader
of the policies will not think to look at.

**What makes the GUC safe to trust.** The same thing that makes
`app.current_org_id` safe: no SQL from outside reaches `evp_api`'s connections,
and only the backoffice extractor sets it, inside a transaction it owns. A
request that names an organisation never sets it, so the two scopes cannot
combine in one transaction.

### Accounts and passwords

The backoffice creates users with a `'password'` identity whose password the
operator chooses (Argon2id, the same twelve-character floor). This is the
amendment to ADR-0031: a password can now originate somewhere other than the
bootstrap. Still not added: self-registration, reset, change-password. When
magic links land, "create the account and let them sign in by link" replaces
the password field, and the field goes.

Roles are any `member_role` (`owner`, `coordinator`, `zone_lead`), defaulting to
`coordinator` in the interface. An organisation created here has no members and
no default shift pattern; the latter is seeded with an `operations` row, which
needs an actor this route does not have.

### Accountability: `audit_log`, not `operations`

Each backoffice write appends an `audit_log` row in the same transaction, with
`actor_id NULL` and `actor_label 'backoffice'`. The table was built for exactly
this (deployment-level rows, an actor that is not a user).

These writes do **not** record an inverse or return an operation id, which
ADR-0024 asks of new mutating endpoints. `operations` is a per-organisation
undo stack keyed on the user who acted (`actor_id NOT NULL`); the backoffice
has neither an undo surface nor a user, and an inverse nobody can replay is a
row that only looks like a guarantee.

### The interface

A `/backoffice` page in `apps/admin`, outside the `/:org` routes and outside the
session guard. The key is typed into it and held **in memory only** — not
`localStorage`, not `sessionStorage` — so reloading the tab forgets it. It is
used rarely; the inconvenience is cheaper than a deployment-wide credential at
rest in a browser profile.

It lives in the admin bundle rather than a third one because its audience is
the admin bundle's audience, and because the separation that matters — the
public form must not ship admin code — is unaffected.

## Consequences

- A deployment can be run without `psql`: organisations, accounts and
  memberships are a page.
- **The key is the most powerful credential on the deployment** after the
  database's own. Anyone holding it can make themselves owner of any
  organisation, and through that read every volunteer. It is opt-in for that
  reason, and the expected use is to set it, do the setup, and unset it.
- `audit_log` gets its first writer. The rest of "audit-log writes" (docs/07)
  is unchanged.
- `evp-cli create-org` remains a stub. The backoffice does not replace it — a
  CLI needs no running API — but it removes the urgency.

## Alternatives considered

**A platform-admin flag on `users`.** The steady-state answer for a hosted
multi-tenant service, and rejected for now because it reproduces the bootstrap
problem: somebody has to be made platform admin, by configuration or by hand in
SQL, before the backoffice can be used — and the flag is then a permanent
privilege on a session cookie, with CSRF and session theft in scope, where a
key that is unset after use is not.

**Finish `evp-cli create-org`.** Still worth doing, and not sufficient: it
creates organisations and owners but not "add these four people as
coordinators", and it needs a shell in the API container.

**Wait for invitations.** The intended M0 path for adding members. It needs
magic links, which need the outbox and a mail relay; the first festival does not
wait for both.
