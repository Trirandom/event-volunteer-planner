# 12 — Security by design

Code-level standards are [11 — Engineering standards](11-engineering-standards.md).

## 1. The principle

**Secure by construction, not by review.** Wherever an invariant can be made
*impossible to violate* — by a database constraint, a type, or an extractor —
it goes there. Review catches what a careful person notices; a constraint
catches what nobody thought about, including future endpoints written by someone
who has not read this document.

This is the same principle as the hard/soft constraint split in
[ADR-0007](adr/0007-hard-vs-soft-scheduling-constraints.md), applied to
security. It is also why the answer to "did you remember to check the tenant?"
is "the query returns zero rows if I didn't".

## 2. Threat model

A control list with no attacker attached is a checklist. These are the actual
adversaries, in the order they are likely to matter.

| # | Adversary | Wants | Primary control |
| --- | --- | --- | --- |
| T1 | A coordinator of organisation A | To read or modify organisation B's data | RLS on every tenant table; composite FKs; `SET LOCAL` per transaction |
| T2 | A spam or scraping bot | To flood the public form, or harvest volunteer data | Rate limits, honeypot, timing floor, an always-on proof-of-work captcha ([ADR-0043](adr/0043-form-captcha-is-a-self-hosted-proof-of-work.md)) — and anything ambiguous is held for a coordinator rather than joining the pool inline ([ADR-0042](adr/0042-public-submissions-reconciled-inline.md)) |
| T3 | Someone with a leaked capability URL (ICS feed, form token link) | To read, overwrite or **delete** one volunteer's data | Single-purpose, unguessable, revocable, rotatable, scoped to one volunteer, never a session — and erasure additionally confirmed by mail to the address on record, so the link alone destroys nothing |
| T4 | A zone lead | To assign outside their delegated zones, or read sensitive fields | RLS policy on `assignments` keyed to `zone_lead_scopes`; field redaction in the serialiser |
| T5 | An attacker with a stolen session cookie | To act as that coordinator | `HttpOnly; Secure; SameSite=Lax`, idle + absolute expiry, per-device revocation, and an audit trail that attributes every action |
| T6 | A misconfigured or hostile OIDC provider | To claim an existing account by asserting its address | `trust_email_verified` defaults false; untrusted providers never link by email ([ADR-0014](adr/0014-pluggable-oidc-providers.md)) |
| T7 | A curious volunteer | To see other volunteers' assignments or dietary notes | Volunteers have no session at all ([ADR-0008](adr/0008-no-volunteer-authentication-in-v1.md)); capability URLs expose one person's data |
| T8 | Whoever obtains a database dump or backup | To log in, or to read secrets | Only hashes of tokens and secrets are stored; no provider tokens at all |
| T9 | A supply-chain compromise | To execute code in the build or at runtime | Pinned digests, `cargo-deny`, lockfiles committed, no `curl \| sh` in any Dockerfile |
| T10 | A malicious file or payload through intake | To exploit the parser or store hostile content | Size and shape limits before parsing; submissions stored as data and never evaluated |

**Explicitly out of scope:** a hostile database administrator, a compromised
host, and physical access. A self-hosted single-tenant deployment cannot defend
against its own operator, and pretending otherwise produces theatre.

## 3. The database boundary

Controls for **T1** and **T4**, and the strongest guarantees in the system.

- **RLS on every table carrying `org_id`**, with both `USING` and `WITH CHECK` —
  `USING` alone would still permit *writing* a row into another tenant.
- The API connects as a **non-owner role without `BYPASSRLS`**, and tables are
  `FORCE ROW LEVEL SECURITY`.
- `SET LOCAL app.current_org_id` per transaction. **`SET LOCAL`, never `SET`** —
  with a connection pool a plain `SET` persists onto whichever request borrows
  the connection next, which is precisely the cross-tenant leak the policy
  exists to prevent. This is the single most dangerous one-word mistake
  available in this codebase, and it is called out in review.
- **A test enumerates `pg_class`** for tables with an `org_id` column and
  fails if RLS is off or no policy exists, so a new table cannot forget.
  *Planned:* today the assertion covers the form tables only
  (`crates/evp-db/tests/forms.rs`); the others are covered by their own
  isolation tests.
- **Composite foreign keys** carrying `org_id`, so a cross-tenant reference is a
  foreign-key violation rather than a policy question.
- **No dynamic SQL.** Every value is a bound parameter — today through
  runtime `sqlx::query*` calls, with the compile-checked macros planned
  ([11 §4](11-engineering-standards.md#4-sql-and-migrations)); dynamic filters
  use `QueryBuilder`. A grep for SQL built by string formatting is planned;
  until then it is a review item (§9). Injection is not mitigated here, it is
  structurally unavailable.
- `audit_log` is append-only: the API role is granted `INSERT` and `SELECT` and
  nothing else, so a compromised handler cannot rewrite history.

Full mechanics: [03 §4](03-data-model.md#4-row-level-security).

## 4. Authorisation belongs in the type system

The strongest single technique available in this stack, and the reason
[ADR-0002](adr/0002-rust-axum-backend.md) chose Axum.

An authorisation check that a handler *performs* can be forgotten. An
authorisation check that a handler *requires as an argument* cannot:

```rust
/// Extractor. Fails the request before the handler runs unless the caller
/// holds coordinator-or-above in the organisation named in the path.
pub struct Coordinator {
    pub user_id: UserId,
    pub org_id:  OrgId,
}

async fn create_shift(
    caller: Coordinator,            // ← cannot be constructed without the check
    Path(org): Path<OrgId>,
    Json(body): Json<NewShift>,
) -> Result<Json<Shift>, ApiError> { … }
```

`Owner`, `Coordinator` and `ZoneLead { scopes }` are separate extractor types,
and there is no `fn require_role(...)` for anyone to forget to call. The check
therefore cannot be omitted *inside* a handler, and the caller identity arrives
already proven — which retires the classic vulnerability, a handler that reads
`org_id` from the path and never verifies membership.

Be precise about the limit, because it is easy to overclaim: **the type system
cannot catch a handler that asks for no extractor at all.** That handler
compiles. Nothing in Rust makes an omitted requirement a compile error.

So the second half is a test, not a hope: a table-driven suite asserts every
route against every role, and it is written to fail on a route it has never seen
rather than skipping it
([11 §5](11-engineering-standards.md#5-testing)). An unlisted route is a failure,
which is what makes the matrix complete instead of merely long.

### The frontend

Frontend checks are **UX, never security**. Every route guard and hidden button
exists so people are not confused; the API re-decides everything. This is
stated because it is the assumption that quietly rots — someone hides a button
and considers the endpoint protected.

- `v-html` is banned by lint. Vue escapes interpolation by default; `v-html` is
  the way out of that, and there is no legitimate use here.
- CSP with no `unsafe-inline`, `frame-ancestors 'none'`. An assertion that the
  built output contains no inline `<script>` is planned.
- The public form ships in a **separate bundle** with no admin code, no API
  client and no session — a distinct security context, not just a smaller one
  ([09 §6](09-volunteer-form.md#6-rendering-it)).

## 5. Not leaking things

### Secrets

- Secrets are **files**, never environment values — they otherwise appear in
  `docker inspect` and in any crash dump of the environment.
- Secret-bearing values use `secrecy::SecretString`, whose `Debug` and `Display`
  redact. `missing_debug_implementations` is a warning, so a struct holding a
  secret cannot quietly gain a derived `Debug` that prints it.
- **No provider tokens are stored at all.** OIDC ID tokens are verified and
  discarded; `offline_access` is never requested
  ([ADR-0013](adr/0013-google-oidc-without-an-identity-provider.md)).
- Only **hashes** of session tokens, magic-link tokens, invitation tokens, ICS
  tokens, form tokens and API keys are persisted. A database dump cannot be used
  to log in as anybody (**T8**).
- Webhook signing secrets are the exception and are stored **encrypted** with
  the application key (`EVP_SECRET_KEY_FILE`, [06 §2](06-local-development.md#2-configuration)),
  not hashed, because verifying an HMAC needs the secret itself. That asymmetry
  is documented where it is easy to get backwards
  ([08 §3](08-volunteer-intake.md#webhook-specifics)).
- HMAC and token comparison uses a constant-time primitive (`subtle`), not `==`.

### Personal data

The system holds names, phones, emails, and **dietary
requirements** — which can imply religion or health. Under GDPR that is the
most sensitive thing here.

- `Email` and `Phone` newtypes have redacting `Debug`, so they cannot reach a
  log by accident. `print_stdout` is denied; all output goes through `tracing`.
- Structured log fields are an **allowlist**. Identifiers and codes are logged;
  personal fields are not. "Log everything and scrub later" fails the first
  time someone forgets.
- Sensitive fields are redacted in the **DTO serialiser**, so "who may see
  dietary notes" is decided in exactly one place rather than per query.
- Exports exclude sensitive fields by default.
- **Raw form submissions are the largest concentration of personal data** in the
  schema — a verbatim copy of everything a volunteer typed. Anonymising a
  volunteer redacts their submissions too, rather than leaving the originals
  intact ([03 §3.10](03-data-model.md#310-intake)).

### Error responses

- `404` for both "not found" and "not yours". Distinguishing them confirms that
  another tenant's record exists.
- `POST /auth/magic-link` returns `202` for unknown addresses. Otherwise it is
  an account-enumeration oracle.
- An unknown OIDC provider id and a disabled one return identical responses.
- Internal error text never reaches a client. Exactly one mapper converts domain
  errors to `problem+json` with a stable `type` and a safe `detail`; the
  `request_id` is how an operator correlates it to the log that has the detail.

## 6. Bounding the untrusted

Every input has a limit, because an unbounded input is a denial of service
(**T2**, **T10**).

| Bound | Where |
| --- | --- |
| Request body size | `tower-http` `RequestBodyLimitLayer`, global |
| Request timeout | `tower-http` `TimeoutLayer`, global |
| String field lengths | Validated in the DTO, not only in the database |
| Array lengths | Availability ranges per day, bulk-assign size, batch writes |
| Upload size and row count | Intake CSV, before parsing rather than during |
| Rate limits | `tower_governor`, per route. Wired on `POST /auth/login` (ADR-0031): ten attempts per client address, one back every fifteen seconds. Magic links (per address *and* per IP, or it is a mail relay for harassing one person), the public form and the OIDC start endpoint get theirs as each lands |
| Concurrency | Database pool size caps in-flight work; the outbox worker has a fixed batch size |

Parsing order matters: **check the shape before parsing the content.** A 2 GB
CSV is rejected on its declared size, not after being read into memory.

**A rate limit is only as good as its key.** The API is reached through Caddy in
every deployment here, so the peer address is the proxy's and keying on it would
put every caller in the world in one bucket. The client address therefore comes
from `X-Forwarded-For` — read by counting `EVP_TRUSTED_PROXY_HOPS` entries from
the **right**. Caddy *appends* to whatever the client sent, so the left of that
header is attacker-controlled: an extractor that reads the first entry lets
anybody pick their own bucket, and therefore their own quota, by sending one
header. The bucket store is swept on a timer, because the key is chosen by the
caller and a keyed store that never forgets is an unbounded input like any
other.

## 7. Capability URLs

ICS feeds and volunteer form links are capability URLs — the bearer is
authorised by possession (**T3**).

That is a deliberate trade, and the terms are:

- High-entropy random tokens (≥ 32 bytes from a CSPRNG), stored hashed.
- **Single-purpose.** An ICS token reads one participation's calendar — one
  volunteer, one event — and stops working when that event's data is purged. A
  form token reads and writes one volunteer's own record: their answers, and
  their data rights ([ADR-0027](adr/0027-volunteer-self-service-rights.md)).
  Neither grants a session, and neither reaches anything else.
- **Destructive actions need a second proof.** Because the link is forwardable,
  erasure is only *initiated* by it; a confirmation to the address on record
  executes it. Non-destructive changes — a correction, an opt-out, withdrawing
  pool consent — need no confirmation, because stopping processing should be
  frictionless in a way deletion should not.
- Revocable individually and rotatable wholesale.
- Never returned by the API — only emailed — so they stay out of browser
  history, screenshots, and the audit log.
- `Referrer-Policy: no-referrer` on those responses, so the token is not leaked
  to third parties by an outbound link.

The residual risk is that a forwarded link works for whoever receives it. That
is accepted and documented rather than mitigated, because the alternative is
making volunteers hold accounts — which
[ADR-0008](adr/0008-no-volunteer-authentication-in-v1.md) rejected for good
reasons. Revocation, the mail confirmation on the one irreversible action, and
the audit trail are the compensating controls.

The form token is also the volunteer's route to erasure, so its **lifetime is
the record's lifetime**, not the campaign's
([ADR-0026](adr/0026-retention-scope-is-a-table-registry.md)). A token expiring
before the data it governs would leave the people whose data is kept longest
with no way to reach it.

## 8. Supply chain and runtime

- Lockfiles committed. Base images pinned by **digest**, not tag.
- No `curl | sh` in any Dockerfile. Ever.
- `cargo-deny` for advisories *and* the licence allowlist; `npm audit` and a
  licence check for the frontend ([CONTRIBUTING](../CONTRIBUTING.md#dependencies)).
- Runtime container: `distroless/cc`, non-root, read-only root filesystem,
  `cap_drop: ALL`, no shell to exec into.
- Migrations run as a **separate privileged role** in a separate step, so the
  long-lived API role cannot alter the schema — including the RLS policies that
  constrain it.
- The database port is not published in production compose.

## 9. Reviewing security-relevant change

A change touching any of these gets a deliberate second look, and the pull request
should say why it is safe:

1. Anything with `org_id`, or a new table (**does it have RLS and a policy?**)
2. A new authorisation extractor, or a handler that does not take one
3. `SET` versus `SET LOCAL`
4. Token generation, hashing, comparison, or lifetime
5. Account linking and the `trust_email_verified` path
6. Any new unauthenticated endpoint, and anything reachable by a capability
   token rather than a session
7. `SECURITY DEFINER` — there is exactly one function
   ([03 §4](03-data-model.md#4-row-level-security)), and a second one needs an
   argument
8. Anything logging a value that could be personal data
9. Raw SQL, or SQL assembled from strings
10. A new dependency
11. A migration that drops or rewrites data
12. A new table with no `retention_scope` row — which a test will fail on (planned; form tables today), but the tier it
   is given is a judgement worth reviewing
   ([ADR-0026](adr/0026-retention-scope-is-a-table-registry.md))

Items 1–3 are the ones where a mistake is silent, unbounded, and discovered by
someone else.

## 10. Reporting a vulnerability

Do not open a public issue. Email the address in the repository metadata with
enough detail to reproduce. Tenant isolation, the OIDC callback, the public form
endpoint, and the capability URLs are where a report is most valuable.
