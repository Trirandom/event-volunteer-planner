# ADR-0014 — Any OIDC provider, declared in configuration

**Status:** Accepted · **Date:** 2026-09-10
**Amends:** [ADR-0013](0013-google-oidc-without-an-identity-provider.md) — the
decision not to run an identity provider stands. What changes is that the
provider is a configured entity rather than Google specifically.

## Context

ADR-0013 chose Google, implemented directly, and asserted that adding another
provider later would be "a row of configuration". It then specified
`/api/v1/auth/oidc/google/start` and `EVP_OIDC_GOOGLE_CLIENT_ID` — Google's
name baked into the URL space and the configuration surface. The claim and the
design did not match.

This project is intended to be open source. Other deployments will not be
Google-based: an association on Microsoft 365, a collective running Nextcloud
or Authentik, a university with Okta, someone who wants no external provider at
all. Hardcoding one provider makes the project unusable for them without a
patch, which is the worst possible outcome for a self-hosted tool.

## Decision

**One generic OIDC client. Providers are declared in configuration, and the
core knows nothing about any particular one.**

Any provider implementing OIDC Discovery works with no code: Google,
Microsoft Entra, Okta, Auth0, Keycloak, Zitadel, Authentik, Dex, GitLab,
Nextcloud, Kanidm.

### Configuration

A mounted file, because this is a list and environment variables are a poor fit
for lists. Secrets are referenced by path, never inlined.

```toml
# providers.toml
[auth]
magic_link_enabled = true      # the zero-dependency default; see below

[[auth.oidc]]
id                   = "google"        # URL segment and identities.provider value
display_name         = "Google"
issuer               = "https://accounts.google.com"
client_id            = "…apps.googleusercontent.com"
client_secret_file   = "/run/secrets/oidc_google"
scopes               = ["openid", "email", "profile"]
trust_email_verified = true            # may auto-link to an existing account
allowed_email_domains = []             # empty = any

[auth.oidc.claims]                     # providers disagree about these
subject        = "sub"
email          = "email"
email_verified = "email_verified"
display_name   = "name"
first_name     = "given_name"
last_name      = "family_name"
picture        = "picture"
```

Endpoints become provider-generic:

```
GET /api/v1/auth/providers                      → what this deployment offers
GET /api/v1/auth/oidc/{provider}/start
GET /api/v1/auth/oidc/{provider}/callback
```

The login page renders itself from `/auth/providers`. It has no build-time
knowledge of which providers exist, so a deployment adding one needs no
frontend change.

### Claim mapping is required, not optional

Providers genuinely disagree. `sub` is the only claim guaranteed by the spec.
Microsoft prefers `oid`; some providers send `preferred_username` and no
`name`; several omit `email_verified` entirely. Hardcoding Google's claim set
is precisely the mistake this ADR corrects, so the mapping is configurable with
spec defaults.

### The security rule that makes this safe

Account linking is the dangerous part of supporting arbitrary providers. An
IdP that lets a user set an unverified email address could otherwise assert
`owner@example.org` and take over that account.

- **`trust_email_verified` defaults to `false`.** A provider is trusted to
  vouch for email addresses only when a deployment operator says so
  explicitly.
- With an untrusted provider, a successful login **never** links to an existing
  account by address. It creates a distinct account, and linking requires being
  signed in through an already-trusted method first — proving control of both
  sides.
- `email_verified` absent is treated as `false`, never as "probably fine".
- `allowed_email_domains`, when set, is enforced server-side after claim
  extraction. It is a restriction, not an identity check.
- `issuer` must be `https` and must exactly equal the `issuer` in the fetched
  discovery document.
- `id` is **immutable once used**: it is stored in `identities.provider`, so
  renaming it orphans every identity that referenced it. Documented, and
  checked at startup against distinct values already present in the table.

### Magic links are the default, not the fallback

Reframed for the open-source case. A fresh `docker compose up` must work with
no external accounts, no OAuth client registration and no IdP — otherwise the
first thing a stranger meets is a Google Cloud Console detour.

So magic links are the out-of-the-box method, over Mailpit locally. Deployments
that want SSO add a provider; deployments that want SSO *only* set
`magic_link_enabled = false`.

### Non-OIDC providers: put an IdP in front

GitHub, Discord, plain OAuth2 services and LDAP are **not** supported in the
core, and will not be. Each needs its own quirks handled, and a registry of
per-provider adapters is exactly the maintenance burden this design avoids.

The supported answer is to run Dex or Keycloak in front and point us at it as
one OIDC provider. This is where an identity provider legitimately belongs —
it closes the loop with ADR-0013, which rejected an IdP for *our* deployment's
needs while leaving it available as the extension point for someone else's.

## Alternatives considered

**Keep Google-specific, let forks patch it.** Rejected: it is the change every
non-Google deployment would have to make, in the security-sensitive part of the
codebase, and it would fragment.

**Per-provider adapters** (`GoogleProvider`, `MicrosoftProvider`, …). Rejected:
OIDC Discovery plus configurable claim mapping covers every compliant provider
with one code path. Adapters would multiply the code that handles untrusted
input for no capability gain.

**Providers in the database, editable in the admin UI.** Better operator
experience, and the natural home for *per-organisation* providers in a
multi-tenant deployment. Rejected for v1: it puts client secrets in the
database, creates a bootstrapping problem (an authentication provider you must
sign in to configure), and per-org IdP brokering is not a v1 requirement. The
config file is version-controllable and reviewable, which suits the actual
users better. Noted as the natural extension if per-org SSO is ever wanted.

**Environment variables with numeric prefixes** (`EVP_OIDC_0_ISSUER`).
Rejected: unreadable, and claim maps make it worse.

**A full framework** (`oauth2-proxy` in front, or delegating to Keycloak
always). Rejected as the default for the reasons in ADR-0013 — but it is
exactly what the "put an IdP in front" escape hatch permits, for anyone who
wants it.

## Consequences

- The project is usable by any deployment with an OIDC provider, and by
  deployments with none.
- `docker compose up` works immediately with no external service.
- One code path handles every provider, so security review has one place to
  look.
- Untrusted providers cannot take over accounts by asserting an address.
- Costs: a config file to parse and validate at startup (invalid provider
  config must refuse to boot, not fail at first login), and a login page that
  renders from an API response rather than a fixed list.
- Discovery documents and JWKS are fetched at startup and cached with
  background refresh, so a provider's key rotation does not require a restart
  and its brief unavailability does not break login for other providers.
- **A fresh install needs a first owner**, and invitations require an existing
  one. That gap only becomes visible once strangers install this, so
  `evp-cli create-org --owner-email` is part of M0
  ([07](../07-roadmap.md#m0--walking-skeleton)).
