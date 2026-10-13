# ADR-0031 — A password credential for bootstrap, beside the magic link

**Status:** Accepted · **Date:** 2026-09-15
**Amends:** [ADR-0005](0005-magic-link-authentication.md) — its session design is
unchanged and is what this reuses; what changes is that "no password is stored
anywhere in this system" is no longer true.

## Context

[ADR-0005](0005-magic-link-authentication.md) chose passwordless authentication,
and [ADR-0013](0013-google-oidc-without-an-identity-provider.md) made Google
OIDC the primary method for organisation members. Both are still right for the
steady state, and neither is available on a deployment that has just started for
the first time:

- A magic link needs a working SMTP relay. `docker compose up` provides Mailpit,
  which is a mailbox a developer opens — not something an operator bringing up a
  real instance has configured yet.
- OIDC needs a provider, a client registration and a redirect URI, which is
  precisely the "external account" that ADR-0005 wanted a fresh clone not to
  need.
- `evp-cli create-org --owner-email` creates the owner but cannot sign them in.

So the first login on a new deployment had no route that did not depend on
something the operator had not set up yet. The documented answer — bring up
SMTP, then use a magic link — is a reasonable production answer and a poor
development one, and development is where a contributor meets it first.

## Decision

**A `'password'` provider in `identities`, and a bootstrap credential in the
environment that creates the first owner.**

- `identities` already carries one row per authentication method per user, keyed
  `(provider, subject)`, explicitly so that a user may have several
  ([ADR-0014](0014-pluggable-oidc-providers.md)). Passwords occupy the
  `'password'` slot. Magic links (`'email'`) and OIDC land beside them, on the
  same `users`, `identities` and `sessions` tables, and this does not move.
- `password_hash` is Argon2id, on `identities`, constrained by
  `CHECK ((provider = 'password') = (password_hash IS NOT NULL))` so that the
  column cannot be null where it is needed or set where it is meaningless.
- `EVP_BOOTSTRAP_USERNAME` and `EVP_BOOTSTRAP_PASSWORD` create an owner **only
  while `users` is empty**, at startup, before the listener binds.
- The session is exactly ADR-0005's: opaque token, SHA-256 in the database,
  `HttpOnly; SameSite=Lax`, idle and absolute expiry, revocable per device.
  Nothing about the session model is password-specific, which is what makes the
  other two methods drop-in.

### Why "only while `users` is empty"

The obvious guard is "create the account if that address has none". It is wrong.
An operator who edits `EVP_BOOTSTRAP_USERNAME` on a running deployment — a typo,
a handover, a copied `.env` — would mint a second owner on a system that already
holds real data, and an owner deleted on purpose would return at the next
restart. "No users at all" is the only state in which creating an owner from
configuration cannot grant access to somebody else's deployment. Past that
point, owners arrive by invitation.

### Why at startup rather than in the login handler

"If the user doesn't exist, create it" reads naturally as something the login
endpoint does. Putting it there means a *failed* login mutates the database, and
it puts account creation on the unauthenticated path — the one surface reachable
by anybody who can open a socket. At startup the same configuration produces the
same account, before any request is served, and a misconfiguration is a boot
failure rather than a surprise at first login.

## Consequences

**We now store a password**, which ADR-0005 avoided, and inherit what that
costs: a hash to keep current, a credential operators may reuse from elsewhere,
and a new brute-force surface on `POST /auth/login`. Specifically accepted, with
these mitigations and these gaps:

- Argon2id with the crate defaults, PHC-encoded, so parameters travel with each
  hash and can be raised without invalidating what is stored.
- A 12-character floor, length only. Composition rules produce `Password1!`
  across a deployment.
- Unknown addresses are verified against a dummy hash, so the unknown-address
  and wrong-password paths cost the same and login timing does not enumerate
  accounts.
- **Rate limited per client address**, by a `tower_governor` layer on that one
  route: ten attempts back to back, one back every fifteen seconds
  (`EVP_LOGIN_RATE_LIMIT_BURST`, `EVP_LOGIN_RATE_LIMIT_REPLENISH_SECONDS`),
  answering `429` with `Retry-After` in the same `problem+json` envelope as
  every other refusal. It bounds the guessing, and it bounds the *cost*: every
  attempt in flight is an Argon2 verification holding ~19 MiB, so before this
  the endpoint was a way to exhaust the host's memory before it was a way to
  guess a password. Without the layer, Argon2's own cost was the only bound and
  the defender paid it.
- **The key is the client address, and that is not the peer address.** The API
  is only ever reached through Caddy, so the peer address is the proxy's; the
  client's is in `X-Forwarded-For`, which Caddy *appends* to. Reading the
  leftmost entry — what a "smart IP" extractor does — would let anybody choose
  their own bucket by sending one header, so the key is taken by counting
  `EVP_TRUSTED_PROXY_HOPS` entries from the **right** and believing nothing
  further left. The default, `1`, is the topology both compose files ship.
- **Still not done: a per-address limit**, so a distributed attack on one
  account is bounded only by the per-client quota, the twelve-character floor
  and Argon2's cost. It is deliberately not "per email *and* per IP" the way
  magic links are ([ADR-0005](0005-magic-link-authentication.md)): a quota
  keyed on the submitted address is an account lockout wearing another hat —
  anybody who knows the owner's address could hold their bucket empty — and
  this ADR has already decided against lockout below. Magic links make that
  trade differently because what their quota protects is a mail relay.

**The environment holds a secret in plain form.** `EVP_BOOTSTRAP_PASSWORD` is
deliberately not in `config.rs`'s `FILE_ONLY` list, unlike `SESSION_KEY` and
`SECRET_KEY`. A bootstrap credential an operator cannot type into `.env` is one
nobody uses, and the failure mode of refusing it is that they pick a worse route
in. The `_FILE` form works and costs nothing, production should use it, and
startup warns when it is not used.

**This is not a general password login.** There is no registration, no reset, no
change-password endpoint and no account lockout. Adding any of them is a
decision this ADR does not make: the intended path for a second user is still an
invitation, and the intended path for a forgotten password is still a magic
link.

## Alternatives considered

**Bring up SMTP and use a magic link.** The documented answer, and still the
right one in production. Rejected as the *only* answer because it makes a fresh
clone depend on a mail relay to be usable at all.

**`evp-cli create-org` plus a printed one-time link.** Closest alternative, and
genuinely better on the secret-handling axis: nothing lands in the environment.
Rejected for now because it needs the magic-link machinery — token table,
expiry, consumption — which is M0 work not yet done. It is the natural
replacement for this ADR once that lands, at which point the bootstrap
credential can be deleted rather than deprecated.

**An unauthenticated first-run setup page.** A window between boot and first
configuration in which anybody who can reach the port becomes owner. The window
is small and the consequence is total.
