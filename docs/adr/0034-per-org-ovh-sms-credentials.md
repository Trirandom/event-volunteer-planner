# ADR-0034 — Per-org OVH SMS credentials, coordinator-managed, encrypted in Postgres

**Status:** Accepted · **Date:** 2026-09-18
**Amends:** narrows [06 §2](../06-local-development.md#2-configuration) for one
case — the OVH application secret and consumer key stop being a deployment-wide
file secret and become a per-organisation value, encrypted at rest.

## Context

`docs/02-architecture.md:54` puts SMS behind an `SmsSender` trait, OVH first —
ported from the spreadsheet workflow's `send-sms.js` /
`optimize-sms-text.js`. As configured today (`crates/evp-bin/src/config.rs`),
SMS credentials are `EVP_SMS_PROVIDER` / `EVP_SMS_CREDENTIALS_FILE` /
`EVP_SMS_SENDER`: one OVH account for the whole deployment, set once by
whoever runs `docker compose`, in the `FILE_ONLY` bucket alongside
`EVP_SESSION_KEY` and `EVP_SECRET_KEY`.

That convention is correct for `EVP_SESSION_KEY` and `EVP_SECRET_KEY`: those
are keys the *deployment* owns, rotating them is an operational act, and no
tenant should ever see them. It is the wrong shape for OVH credentials,
because this system is multi-tenant and OVH's SMS product is not — an OVH
`serviceName` and its keys belong to *one* organisation's OVH account. A
single-deployment file secret forces every organisation on an installation
onto the same OVH account and sender id, which is wrong the moment a second
organisation signs up, and it puts a coordinator's own credential in the
hands of whoever operates the server, requiring an ops round-trip (a file
mount, a container restart) for every organisation that wants to turn SMS on,
change sender id, or rotate a leaked key.

## Decision

**OVH SMS credentials move to Postgres, one row per organisation, encrypted;
`EVP_SECRET_KEY_FILE` stays a deployment-level file secret and becomes the key
that encrypts them.**

- `org_sms_settings` (migration `…_add_org_sms_settings`) carries, per
  `org_id`: `provider` (currently only `'ovh'`), `application_key` (OVH calls
  this an *Application Key* — an identifier paired with a secret, not a
  bearer credential on its own; still not returned to the frontend, but
  stored in plain text next to the tenant-isolated row rather than
  encrypted, consistent with how `intake_sources.api_key_hash` treats the
  paired-but-not-secret half of a credential), `application_secret_encrypted`
  and `consumer_key_encrypted` (`bytea`, ChaCha20-Poly1305-sealed — see
  below), `service_name`, `sender`, and `updated_by`/`updated_at` for audit
  clarity.
- Encryption reuses the mechanism `intake_sources.webhook_secret_encrypted`
  already reserves a column for (migration `20260917150000_intake_pipeline`)
  and the key `docs/17 §"Secrets and cryptography"` already reserves for it:
  `EVP_SECRET_KEY_FILE`, 32 bytes, file-only, deployment-wide. This ADR is
  what actually pins the algorithm — `docs/17` left it open ("not pinned
  yet… the choice is between `chacha20poly1305` 0.11.0 and `aes-gcm`
  0.11.1") pending a real caller, and this is the first one. `chacha20poly1305`
  is chosen: it needs no hardware AES-NI assumption (the API and worker
  containers are not guaranteed a specific CPU feature set), and its
  `Aead`/`KeyInit` API is the same shape either crate would present, so
  taking it costs nothing if a second AEAD use ever wants AES-GCM instead.
  A random 96-bit nonce is generated per encryption via `getrandom` (already
  in the tree) and stored alongside the ciphertext, never reused.
- A coordinator manages their org's own credentials through
  `GET`/`PUT /api/v1/orgs/{org}/sms-settings` (`evp-api`), gated by the
  `Owner` extractor — matching "Org settings, members, invites" in
  `docs/04 §4`'s permission table, not "Intake sources, secrets, mappings"
  (owner + coordinator): an OVH account is billed and can send to arbitrary
  numbers under the org's sender id, which is closer to "who runs this
  organisation's account" than to a per-source webhook secret.
- The response never carries `application_secret` or `consumer_key` back —
  only `has_application_secret` / `has_consumer_key` booleans, the same
  write-only shape `docs/04 §"Intake"` already uses for a webhook's signing
  secret ("returned once, never again").
- What stays exactly as it was: `EVP_SECRET_KEY_FILE` remains a file secret,
  set once per deployment, never in the database, never sent to a browser.
  Rotating it is still `evp-cli rotate-app-key`'s job — this ADR adds
  `org_sms_settings` to what that command re-encrypts, alongside
  `intake_sources.webhook_secret_encrypted` once that lands.
- `EVP_SMS_PROVIDER` / `EVP_SMS_CREDENTIALS_FILE` / `EVP_SMS_SENDER` become
  vestigial: no code path reads them for OVH credentials any more. They are
  left in `crates/evp-bin/src/config.rs` rather than removed in this change,
  because ripping out a `KNOWN`/`FILE_ONLY` entry is config-parsing surgery
  independent of this feature and is deferred to the outbox-wiring pass
  (below) that will actually delete them; `docs/06 §2` is annotated to say
  so rather than left silently wrong.

## What is *not* built here

The `SmsSender` trait and an OVH implementation (HMAC-style signature per
`send-sms.js`, GSM-7 transliteration per `optimize-sms-text.js`) are added in
`evp-worker`, unit-tested against a fixed clock with no network I/O. Wiring a
sender into the outbox consumer — enqueueing a message, retry/backoff,
recording delivery — is **future work**: it needs the outbox table (docs/02
§"Async work"), which does not exist yet, and a recipient-selection/template
feature this task does not attempt. `org_sms_settings` is read by that future
consumer to build the per-org `SmsSender`; nothing sends a real SMS as a
result of this change.

## Security tradeoff

A Postgres compromise now exposes every organisation's *encrypted* OVH
credentials, where before it exposed none (they lived in a file bind-mount
outside the database entirely). This is accepted because:

- The ciphertext is useless without `EVP_SECRET_KEY_FILE`, which is not in
  the database and not reachable through RLS or SQL injection — it lives only
  in the API/worker process's environment.
- `org_sms_settings` carries `ENABLE`/`FORCE ROW LEVEL SECURITY` with the
  standard `org_id` policy, so even a compromised `evp_api` session (not
  superuser, not `BYPASSRLS`) can only ever see one organisation's row.
- The endpoint never returns the secret values, so a compromised frontend
  session or a logged response cannot leak them either — only "is one set"
  is observable.
- Compared to the alternative (hashing, as `intake_sources.api_key_hash`
  does for API keys that are only ever *compared*), OVH's secret and
  consumer key must be *recovered* to sign every request, so hashing was
  never an option here — encryption is the correct primitive, not a weaker
  substitute for one.

## Alternatives considered

**Keep it a single deployment-wide file secret, and give every org the same
OVH account.** Rejected: this system is multi-tenant by design (docs/03),
and an OVH account is billed per organisation running its own events. One
shared account means one organisation's traffic, cost and sender id leak
into another's, and a leaked key affects every tenant on the installation at
once.

**Hash instead of encrypt.** Rejected: OVH's HMAC-style signature needs the
plaintext `applicationSecret` and `consumerKey` on every request; a hash
cannot be signed with.

**A secrets manager (Vault, cloud KMS) instead of an app-level key.**
Rejected for the same reason `docs/17` rejects one for session/webhook
secrets: it is real infrastructure this project does not otherwise need, and
`EVP_SECRET_KEY_FILE` already exists and is already the answer for exactly
this shape of problem (recoverable, not deployment infrastructure).

## Consequences

- A coordinator turns SMS on, off, or rotates a leaked OVH key for their own
  organisation with no ops involvement.
- `evp-cli rotate-app-key` gains a second table to touch when
  `EVP_SECRET_KEY_FILE` rotates.
- `chacha20poly1305` is now pinned in `docs/17`'s dependency register, no
  longer "not pinned yet" — this is that decision, made against a concrete
  caller rather than speculatively.
- `EVP_SMS_PROVIDER`/`EVP_SMS_CREDENTIALS_FILE`/`EVP_SMS_SENDER` are
  deprecated and their removal from `config.rs` is tracked as follow-up work
  alongside the outbox wiring.
