# ADR-0013 — Sign in with Google, implemented directly, without running an identity provider

**Status:** Accepted · **Date:** 2026-09-10
**Amended by:** [ADR-0014](0014-pluggable-oidc-providers.md) — the provider is now
generic and declared in configuration; Google is one entry rather than the
hardcoded case. Not running an identity provider is unchanged.
**Amends:** [ADR-0005](0005-magic-link-authentication.md) — magic links move
from primary method to fallback and break-glass. Sessions are unchanged.

## Context

[ADR-0005](0005-magic-link-authentication.md) chose emailed magic links as the
only way in, reasoning that coordinators log in rarely and that passwords are a
liability. [ADR-0008](0008-no-volunteer-authentication-in-v1.md) then narrowed
authentication to organisation members only — a few dozen people, not several
hundred.

Two things have changed since.

**Google login is evidence-backed, not a preference.** The prior system runs
entirely on Google: Sheets, Forms, Drive, `MailApp`, and a send guard that
compares `Session.getActiveUser().getEmail()` against the association's own
account ([10 — Prior art](../10-prior-art-spreadsheet.md)). Every coordinator
already has a Google account and uses it daily for this exact task. "Sign in
with Google" removes the emailed-link round trip for all of them.

**The proposal on the table was Keycloak.** Which raises the real question: is
an identity provider warranted here at all?

## Decision

**Implement Google as an OIDC provider directly in the API. Do not run an
identity provider.**

- Authorization Code flow with PKCE, against Google's discovery document,
  requesting only `openid email profile`. No other scopes.
- The ID token is verified (signature via Google's JWKS, `iss`, `aud`, `exp`,
  `nonce`) and then **discarded**. We are using Google to learn *who this is*,
  once, at login — not to call Google APIs on their behalf.
- **No `offline_access`, no refresh tokens requested, none stored.** There is
  no long-lived Google credential at rest anywhere in the system.
- Identity is keyed on the `sub` claim, not the email address. Emails change;
  `sub` does not.
- **Sessions stay exactly as ADR-0005 specified**: our own opaque random token,
  stored hashed in Postgres, in an `HttpOnly; Secure; SameSite=Lax` cookie.
  Google's token is never the session.
- **Magic links are retained** as a second method and as break-glass: for a
  coordinator without a Google account, for an organisation that is not
  Google-based, and for the case where OAuth configuration is broken and
  somebody has to get in. `evp-cli issue-login-link` remains.
- Adding a second provider later (Microsoft, an organisation's own OIDC) is a
  row of configuration, because OIDC discovery means the flow code is already
  generic.

### Why not Keycloak

Keycloak is a good product solving a problem this project does not have. Its
value is centralising **authentication and authorisation across several
applications**. Here there is one application, and its authorisation model
cannot live in an IdP:

- `memberships.role` is per `(user, organisation)`. One person is an owner of
  organisation A and a zone lead in B, simultaneously. Encoding that as token
  claims means the database can no longer enforce it — and tenant isolation is
  enforced by Row-Level Security reading `app.current_org_id`
  ([ADR-0003](0003-postgresql-with-row-level-security.md)), which is set from
  our own membership lookup.
- `zone_lead_scopes` is a set of per-location rows. That is data, not claims.
- Roles change while a session is live (someone is promoted mid-event), and a
  database lookup reflects that on the next request. A token reflects it on the
  next refresh.

So Keycloak would only ever assert "this is person X" — which is the part that
takes roughly two hundred lines with the `openidconnect` crate. We would pay
the full operational price for a fraction of the value:

| Cost | |
| --- | --- |
| Memory | Keycloak alone typically uses more than every other container in this stack put together, against a stated target of under 512 MB for the whole thing ([01 §5](../01-product-spec.md#5-non-functional-requirements)) |
| A second upgrade treadmill | JVM and Keycloak release cadence, with a history of disruptive major migrations |
| Configuration that resists version control | Realm definitions live in the IdP; exporting and re-importing realm JSON is a poor substitute for migrations in git |
| A second admin surface to secure | The Keycloak admin console is itself something to lock down and keep patched |
| A second thing that can be down | If it is down, nobody administers the event — during the event |
| Two user directories | Keycloak's users plus our `users`/`memberships`, to be kept in step |

For roughly twenty coordinators, that is not a favourable trade.

## Alternatives considered

**Keycloak.** As above. Genuinely the right answer under conditions stated in
*Revisit when*, below.

**Zitadel.** Much lighter than Keycloak (Go, not JVM), Apache-2.0, and
multi-tenant natively. That last property is the problem: its "organizations"
would sit alongside our `organizations`, giving two authorities for the same
concept and a synchronisation job nobody wants. Rejected for conceptual
duplication rather than weight.

**Authentik.** Rejected: Python/Django with a mandatory Redis, and
[ADR-0006](0006-postgres-backed-job-queue.md) deliberately avoided adding
Redis. Heavier than Keycloak for our purposes.

**Ory Kratos + Hydra.** API-first and light, but it is two services and you
build every screen yourself — more total work than implementing the OIDC flow
directly, for the same outcome.

**Auth0 / Clerk / WorkOS.** Rejected: an external dependency on the login path
for a self-hosted association tool, a recurring cost, and tenant identity data
held off-site.

**Google as the *only* method, dropping magic links.** Tempting — it is one
code path instead of two. Rejected: it makes Google a hard dependency for
administering the system, leaves no way in when OAuth is misconfigured, and
assumes every future organisation on the deployment is Google-based. Magic
links are already specified and built in M0, so retaining them is nearly free.

**Google's `hd` (hosted domain) claim for automatic org membership** — "anyone
with a `@example.org` address joins this organisation as a coordinator".
Attractive, and deferred: it is only safe when the deployment can verify that
the organisation controls that domain, and without that check it is a
privilege-escalation path. Invitations already cover the need.

## Consequences

- Coordinators sign in with one click, using the account they already use for
  this work.
- No identity provider to run, patch, back up, or debug at 2 a.m. during an
  event.
- No Google refresh tokens at rest, because none are requested.
- Sessions, revocation and per-device sign-out keep working exactly as
  specified — instant revocation, because the session is a row we own.
- Authorisation stays in one place: `memberships`, `zone_lead_scopes`, and RLS.
- Two authentication paths to test, and a new `identities` table for account
  linking ([03 §3.2](../03-data-model.md#32-tenancy-and-identity)).
- **Account linking is a security-relevant join** and is treated as one: an
  existing user is matched to a Google identity only when `email_verified` is
  true *and* the address matches. Both paths already prove control of the
  address — magic link by delivery, Google by assertion — so linking on a
  verified match is sound. Linking is recorded in `audit_log`.
- Local development needs either magic links (which work offline) or a mock
  OIDC provider; see [06 §2](../06-local-development.md#2-configuration).
- Google's consent screen and publishing status must be configured once.
  Requesting only non-sensitive scopes (`openid email profile`) is what keeps
  this simple — confirm Google's current verification policy at implementation
  time, since it changes.

## Revisit when

Any one of these makes an identity provider the right answer, and at that point
Keycloak is the sound choice:

- A second application needs single sign-on against the same users.
- An organisation on the deployment requires SAML, or brings its own corporate
  IdP that must be brokered.
- User federation against LDAP or Active Directory is needed.
- Centrally managed MFA policy is required beyond what Google enforces.
