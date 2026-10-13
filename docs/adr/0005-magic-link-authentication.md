# ADR-0005 — Email magic links with server-side sessions

**Status:** Accepted · **Date:** 2026-09-10
**Amended by:** [ADR-0013](0013-google-oidc-without-an-identity-provider.md) — Google OIDC becomes the primary method for organisation members; magic links remain as fallback and break-glass. The session design here is unchanged.
**Amended by:** [ADR-0008](0008-no-volunteer-authentication-in-v1.md) — volunteers no longer authenticate at all; this ADR now governs organisation members only.

## Context

Two user populations with opposite characteristics. Coordinators log in
frequently during an event and rarely between. Volunteers log in perhaps twice
a year, to declare availability and check a schedule — the classic profile for
forgotten passwords, and the point at which a volunteer gives up and emails the
coordinator instead.

Email addresses are already required: the schedule is delivered by email
regardless.

## Decision

Passwordless authentication by emailed magic link, with opaque server-side
sessions in a cookie.

- Token: 32 bytes from a CSPRNG, base64url-encoded. Only its SHA-256 is stored.
- Valid 15 minutes, single use, invalidated on consumption.
- `POST /auth/magic-link` returns `202` for any address, known or not — a
  differentiated response is an account-enumeration oracle.
- Rate limited per email address *and* per source IP: without both, the
  endpoint is a mail relay for harassing a known address.
- Session: another opaque random token, stored hashed, in an
  `HttpOnly; Secure; SameSite=Lax` cookie. 30-day absolute expiry, 7-day idle
  expiry, revocable per device.
- CSRF: double-submit token on every unsafe method. `SameSite=Lax` alone is
  not treated as sufficient.

## Alternatives considered

**Email and password.** No mail dependency for login itself — though password
reset needs mail anyway, so the dependency is only deferred, not removed.
Rejected because it means storing password hashes (Argon2id, tuned, and a
liability in a breach), building reset and change flows, and accepting that
twice-a-year users will forget. It adds code and a support burden to make the
rare-login case worse.

**OIDC / social login.** Least credential handling. Rejected as the sole
method: it requires an identity provider, and volunteers are a general
population who cannot be assumed to have — or want to use — a Google account.
Reasonable as an *additional* method for coordinators later; the session layer
is independent of how identity was established, so adding it is additive.

**No volunteer login at all** — coordinators only, with volunteers receiving a
signed read-only schedule link. Materially smaller attack surface, and it was
close. Rejected because volunteers need to *write* their availability, and
funnelling that through coordinators recreates the coordination overhead the
project exists to remove. The signed-link idea survives for the ICS feed, where
it is exactly right.

**JWTs instead of server-side sessions.** Rejected: revocation is the whole
problem, statelessness buys nothing when every request already touches the
database, and the token would have to live somewhere in the browser. An opaque
cookie is a primary-key lookup on an indexed table.

## Consequences

- No passwords stored, so no password breach and no reset flow to build.
- Login requires working email delivery. If SMTP is down, nobody signs in —
  the single point of failure this introduces. Mitigated by a CLI escape hatch
  (`evp-cli issue-login-link`) that prints a valid link on the server, for
  recovery.
- One extra step per login, and a token that can be delayed by a mail queue or
  a greylisting relay.
- Magic links in email are a phishing-shaped pattern by nature. Mitigated by a
  short TTL, single use, showing the requesting IP and user agent in the email,
  and never embedding a destination the recipient did not initiate.
