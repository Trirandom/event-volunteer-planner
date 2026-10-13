# 17 — Backend stack

The dependency register. Every third-party crate the backend links, the version
it is pinned to, why it and not the obvious alternative, and its licence.

Versions are declared once, in `[workspace.dependencies]` in the root
`Cargo.toml`; member crates say `workspace = true`. This document is the
reasoning behind that file, and the two are expected to move together.

All versions were checked against crates.io on **2026-09-11**. Where a crate's
last release is old enough to matter, it says so — staleness is evidence, not a
verdict, and this document distinguishes "finished" from "abandoned" case by
case.

Licences are checked against the AGPL-compatible allow-list in
[CONTRIBUTING.md](../CONTRIBUTING.md#dependencies) and enforced by `cargo-deny`
through [`deny.toml`](../deny.toml). Nothing here is source-available.

## 1. The choices that were already made

[02 §2](02-architecture.md#2-technology-choices) named the load-bearing
libraries and the ADRs carry the reasoning. This section re-checks them against
today rather than re-arguing them.

### Axum, against Actix Web and Rocket

Asked directly, because it is the choice everything else hangs off.

**Axum 0.8.9 stands, and it is not close.**

- **Rocket is out on maintenance alone.** Its last stable release is **0.5.1,
  23 May 2024** — more than two years. A web framework that has not shipped in
  two years is not a framework you build a five-year self-hosted application
  on, whatever its merits.
- **Actix Web is genuinely alive** — 4.15.0, 21 August 2026 — so the question
  is real rather than rhetorical, and the answer is still Axum. The argument is
  not throughput: Actix's benchmark lead is irrelevant at a few dozen
  concurrent coordinators, and [ADR-0002](adr/0002-rust-axum-backend.md)
  already says so. The argument is that Axum *is* a `tower` service. Timeouts,
  body limits, request ids, tracing spans, rate limiting and panic catching are
  `tower-http` and `tower_governor` layers that this project does not write and
  does not maintain. Actix has equivalents, but they are Actix's, so every one
  of them is a second implementation to learn and a second place for a bug to
  live.
- **The extractor argument is the decisive one**, and it is specific to this
  application. [12 §4](12-security.md#4-authorisation-belongs-in-the-type-system)
  makes authorisation a *type*: `Coordinator` cannot be constructed without the
  membership check, so a handler that takes one has had the check run. Actix's
  `FromRequest` can express the same shape. Axum's is the one the project's
  security model was designed against, and re-deriving that model against a
  different extractor system to gain nothing measurable is work with a negative
  return.
- Poem, Salvo and ntex were not seriously considered: smaller ecosystems, and
  the `tower` argument applies against all three.

No ADR is overturned. [ADR-0002](adr/0002-rust-axum-backend.md) stands as
written.

### The rest, confirmed

| Choice | Version | Still right because |
| --- | --- | --- |
| Tokio | 1.53.1 | Unchallenged. Every crate here targets it. |
| SQLx | 0.9.0 | Released 21 May 2026. Compile-time-checked SQL against a real schema, and the interesting queries are set-based SQL an ORM would obscure (ADR-0002). Raises the MSRV to 1.94, which is the highest floor in the tree. |
| jiff | 0.2.35 | The reason it was chosen — `Zoned` makes the instant/wall-clock distinction unignorable ([ADR-0019](adr/0019-time-discipline.md)) — has become less of a gamble, not more: released 25 July 2026, and the SQLx bridge below now exists. |
| utoipa | 5.5.0 | OpenAPI 3.1 from the handlers. Alive (4 May 2026). |
| thiserror / tracing | 2.0.20 / 0.1.44 | Unchallenged, and both are effectively infrastructure. |
| openidconnect | 4.0.1 | **Confirmed with a caveat** — see §7. It is the only maintained generic OIDC client in Rust, and ADR-0014 needs a generic one. |
| lettre | 0.11.23 | SMTP with no SaaS. Alive (3 August 2026). |
| minijinja | 2.24.0 | Jinja syntax, small, no build step. Alive (12 August 2026). |
| figment | 0.10.19 | **Confirmed with a caveat** — see §7. Last release 17 May 2024. |
| tower_governor | 0.8.0 | Rate limiting as a layer, which is the `tower` argument again. |
| Typst / printpdf | — | **Deferred, and one of them conflicts with a stated constraint** — see §7. |

## 2. The register

### HTTP and runtime

| Crate | Version | Why this one | Rejected | Licence |
| --- | --- | --- | --- | --- |
| `axum` | 0.8.9 | §1. `default-features = false`; `form` is off because nothing here accepts `application/x-www-form-urlencoded` — the public form posts JSON. | `actix-web` 4.15.0, `rocket` 0.5.1, `poem` 3.1.12 | MIT |
| `tokio` | 1.53.1 | The runtime everything else assumes. Feature-selected, not `full`: `fs` is on for reading secret files, `process` is off until the PDF renderer needs it. | — | MIT |
| `tower` | 0.5.3 | `ServiceBuilder`, and the trait the layers below implement. | — | MIT |
| `tower-http` | 0.7.1 | `trace`, `request-id`, `timeout`, `limit`, `catch-panic`, `cors`, `sensitive-headers`, `normalize-path`, `set-header`. Every middleware in the request lifecycle ([02 §3](02-architecture.md#request-lifecycle)) is one of these; none is written here. | Hand-rolled middleware | MIT |
| `tower_governor` | 0.8.0 | GCRA rate limiting keyed by extractor, so "per email *and* per IP" on magic links ([12 §6](12-security.md#6-bounding-the-untrusted)) is a key function rather than a bespoke store. `default-features = false`: `tonic` is a default and this is not a gRPC server. `tracing` is not a default and is not optional here — it is what logs an exceeded quota, and `evp-api`'s key extractor implements the two trait methods that feature gates. Its own `SmartIpKeyExtractor` is *not* used: it reads the leftmost `X-Forwarded-For` entry, which behind an appending proxy is the one the client wrote. | `governor` directly — same crate underneath, plus the glue this saves | MIT OR Apache-2.0 |
| `axum-extra` | 0.12.6 | `cookie` for the `evp_session` and `evp_csrf` jars; `typed-header` for `If-Match`. | `tower-cookies` 0.11.0 — an extra middleware for what an extractor already does | MIT |

**`compression` is deliberately off.** Caddy terminates TLS and serves static
assets, so it compresses. Compressing twice costs CPU in the process that has
the database pool.

### Database

| Crate | Version | Why this one | Rejected | Licence |
| --- | --- | --- | --- | --- |
| `sqlx` | 0.9.0 | ADR-0002. `default-features = false` — the default pulls MySQL, SQLite and `any`, none of which this project will ever have. | `sea-orm` 2.0.2, `diesel` 2.3.13 | MIT OR Apache-2.0 |
| `jiff-sqlx` | 0.2.0 | **The gap the architecture document left.** SQLx has `chrono` and `time` features and no `jiff` feature, so `timestamptz` ↔ `jiff::Timestamp` needs a bridge. Without one, every query would round-trip through `time::OffsetDateTime` — the exact type [11 §2](11-engineering-standards.md#2-rust) bans. This crate is by jiff's author and requires `sqlx ^0.9`. | A local newtype implementing `Encode`/`Decode` — thirty lines we would then own, for `Timestamp`, `Zoned`, `Span` and `PgRange` of each | Unlicense OR MIT |

**Feature matrix**, since it is load-bearing and easy to get wrong:

```
runtime-tokio                  one runtime, matching the server
tls-rustls-ring-native-roots   see below
postgres macros migrate        the driver, query!/query_as!, sqlx migrate
uuid json rust_decimal         type bridges for the schema's column types
```

`tls-rustls-ring-native-roots`, not the default `tls-rustls`. The default
expands to `tls-rustls-ring-webpki`, which pulls `webpki-roots` —
**CDLA-Permissive-2.0**, which is *not* on the allow-list in CONTRIBUTING.md.
Native roots come from the image's `ca-certificates`, which distroless
provides. `ring` rather than `aws-lc-rs` because `aws-lc-sys` wants `cmake` and
a C toolchain in the builder stage for a TLS implementation this deployment
barely uses — the database is on the same Compose network.

**Pooling** lives in `evp-db::connect` and is not configurable. The pool *is*
the system's concurrency limit ([12 §6](12-security.md#6-bounding-the-untrusted)),
and the number that matters is PostgreSQL's `max_connections` divided by the
replica count. 16 is generous for a few dozen coordinators. It becomes an
environment variable the day there is a second replica, not before. The
after-connect hook issues `SET TIME ZONE 'UTC'`, which is
[16 §2](16-i18n-and-time.md#2-storage) rule 2 and the reason it is in the pool
builder rather than in a helper somebody can forget to call.

### Domain vocabulary

| Crate | Version | Why this one | Rejected | Licence |
| --- | --- | --- | --- | --- |
| `jiff` | 0.2.35 | ADR-0019. Default features read the platform tzdb from `/usr/share/zoneinfo` rather than bundling one, so a tzdata update arrives with a base-image rebuild and the API stays on comparable data to PostgreSQL's. The cost is a runtime dependency on the image, so the process resolves a zone at startup and refuses to boot without a tzdb. | `chrono` + `chrono-tz`, `time` (no tzdb at all), `tzdb-bundle-always` | Unlicense OR MIT |
| `uuid` | 1.26.1 | **UUIDv7 needs no separate crate.** `uuid` has had a stable `v7` since 1.10; it is the crate SQLx, utoipa and serde already integrate with, so a dedicated generator would mean converting at every boundary. | `uuid7` 1.8.0 (its own `Uuid` type), `ulid` 3.0.0 (not a UUID, so not a `uuid` column) | Apache-2.0 OR MIT |
| `rust_decimal` | 1.43.0 | Hours are `numeric(4,2)` ([11 §2](11-engineering-standards.md#2-rust)). 96-bit fixed point maps exactly onto that range and is `Copy`, which matters in a constraint engine that sums hours in a loop. | `bigdecimal` 0.4.10 — arbitrary precision, heap-allocating, and solving a problem `numeric(4,2)` does not have; `f64`, which gives `9.999999999999998 > 10` | MIT |

### API contract

| Crate | Version | Why this one | Rejected | Licence |
| --- | --- | --- | --- | --- |
| `utoipa` | 5.5.0 | 02 §2. `axum_extras` for path/query inference, `preserve_order` so a regenerated `openapi.json` diffs as a change of content rather than a change of key order — which matters because the document is to be snapshot-tested ([06 §4](06-local-development.md#4-testing-strategy)). | Hand-written OpenAPI, `aide`, `okapi` | MIT OR Apache-2.0 |
| `utoipa-axum` | 0.2.0 | Router-and-schema in one registration, so a route cannot exist without a document entry. Last released January 2025 and that is fine: it targets `utoipa 5` and `axum 0.8`, which is exactly what is pinned here. A version that never needs to change is finished, not abandoned. | Registering paths by hand | MIT OR Apache-2.0 |
| `serde` / `serde_json` | 1.0.229 / 1.0.151 | Not a decision. | — | MIT OR Apache-2.0 |

**TypeScript client generation** is `openapi-typescript` 7.13.0 with
`openapi-fetch` 0.17.0 (both MIT), output to **`packages/api-client/`**. See
[ADR-0030](adr/0030-backend-dependency-selection.md) for why, and note that the
frontend consumes this, so it is a cross-team fact rather than a backend one.
**Not built yet:** neither package is installed and nothing emits
`openapi.json`; the admin's `apps/admin/src/api/` modules are hand-written
valibot schemas in the meantime ([11 §3](11-engineering-standards.md#3-typescript)).

### Errors, observability and configuration

| Crate | Version | Why this one | Rejected | Licence |
| --- | --- | --- | --- | --- |
| `thiserror` | 2.0.20 | Libraries. Meaningful variants, one place mapping them to `problem+json`. | — | MIT OR Apache-2.0 |
| `anyhow` | 1.0.104 | `main` and the CLI only ([11 §2](11-engineering-standards.md#2-rust)). | `eyre`/`color-eyre` — prettier reports, another dependency, no difference to an operator reading a JSON log | MIT OR Apache-2.0 |
| `tracing` | 0.1.44 | Spans carry request id and org id ([02 §2](02-architecture.md#2-technology-choices)). | `log` | MIT |
| `tracing-subscriber` | 0.3.23 | `json` for production, `fmt`+`ansi` for `EVP_LOG_FORMAT=pretty`, `env-filter` for `EVP_RUST_LOG`. | — | MIT |
| `figment` | 0.10.19 | Layers defaults, environment and TOML into one typed struct, and names the provider a bad value came from — which is the difference between "invalid socket address" and "EVP_BIND, from the environment, is not a socket address". **Stale: no release since May 2024** (§7). | `config` 0.15.25 — more active, weaker provenance in errors, and a larger surface than the two providers used here; `envy`, which does not do files | MIT OR Apache-2.0 |
| `metrics`, `metrics-exporter-prometheus`, `axum-prometheus` | 0.24.6, 0.18.3, 0.10.1 | Registered, not yet wired: `/metrics` is not one of M0's three routes. `axum-prometheus` gives per-route latency and status histograms with a matched-path label, which is the thing a bespoke middleware gets wrong. | `prometheus` (the older client), bespoke middleware | MIT / MIT AND Apache-2.0 / MIT |

### Secrets and cryptography

| Crate | Version | Why this one | Rejected | Licence |
| --- | --- | --- | --- | --- |
| `secrecy` | 0.10.3 | `SecretString` redacts in `Debug` and `Display` and zeroises on drop ([12 §5](12-security.md#5-not-leaking-things)). Needs the `serde` feature to deserialise straight out of the config. | Newtypes with hand-written `Debug` | Apache-2.0 OR MIT |
| `getrandom` | 0.4.3 | Capability tokens are ≥ 32 bytes straight from the OS CSPRNG ([12 §7](12-security.md#7-capability-urls)). This is a syscall wrapper with no PRNG state to seed wrongly, reseed wrongly, or fork across. | `rand` — a general-purpose PRNG framework where the requirement is "give me OS entropy"; it will arrive when `evp-cli seed` needs a *seeded, reproducible* generator, which is the opposite requirement | MIT OR Apache-2.0 |
| `sha2` | 0.11.0 | Session, magic-link, invitation, ICS and form tokens are stored as SHA-256 of a ≥ 32-byte random secret. | `argon2`, `bcrypt` — see below | MIT OR Apache-2.0 |
| `hmac` | 0.13.0 | Webhook signature verification ([08 §3](08-volunteer-intake.md)). | Hand-rolled HMAC | MIT OR Apache-2.0 |
| `subtle` | 2.6.1 | Constant-time comparison of token hashes and HMACs, named by [12 §5](12-security.md#5-not-leaking-things). | `constant_time_eq` 0.6.0 — equivalent, and `subtle` is already in the tree under `openidconnect` | BSD-3-Clause |

**No password hashing, deliberately.** `argon2` would be the right answer to a
different question. A password is *low*-entropy and human-chosen, so hashing it
must be slow. Every secret in this system is ≥ 32 bytes from a CSPRNG, which
cannot be brute-forced at any work factor, and the cost of a deliberately slow
hash would be paid on every request that carries a session cookie. SHA-256 over
a high-entropy secret is correct here, and would be negligent for a password.
Nothing in this system stores a password
([ADR-0005](adr/0005-magic-link-authentication.md),
[ADR-0013](adr/0013-google-oidc-without-an-identity-provider.md)), which is why
the question does not arise.

Symmetric encryption for `EVP_SECRET_KEY_FILE`-protected values — webhook
signing secrets, and now per-org OVH SMS credentials
([ADR-0034](adr/0034-per-org-ovh-sms-credentials.md)), which must be
recoverable rather than hashed — is `chacha20poly1305` 0.11.0, pinned by
ADR-0034 against its first real caller (`org_sms_settings`), rather than
speculatively. Rejected: `aes-gcm` 0.11.1, equivalent, but assumes AES-NI is
worth relying on and this deployment gives no such guarantee. A random 96-bit
nonce per value, generated with `getrandom` (already in the tree), stored
alongside the ciphertext.

| Crate | Version | Why this one | Rejected | Licence |
| --- | --- | --- | --- | --- |
| `chacha20poly1305` | 0.11.0 | AEAD for values that must be recoverable, not hashed. No AES-NI assumption. | `aes-gcm` 0.11.1 | Apache-2.0 OR MIT |
| `sha1` | 0.10.6 | OVH's SMS API signs requests with a plain (non-HMAC) SHA-1 digest over `secret+consumer+method+url+body+timestamp` — this is OVH's own scheme, not a choice this project made, so SHA-1 is used only here, never for anything this project designs itself. | Hand-rolled SHA-1 | MIT OR Apache-2.0 |

### Outbound: mail, templates, SMS, calendars

| Crate | Version | Why this one | Rejected | Licence |
| --- | --- | --- | --- | --- |
| `lettre` | 0.11.23 | 02 §2. `default-features = false` because the default enables `native-tls`, which means OpenSSL, a C toolchain in the builder and an OpenSSL CVE cadence in a distroless image. **Pinned but not yet linked** — its only rustls feature combination pulls a licence that needs a decision first (§7). | `mail-send`, an SMTP SaaS SDK | MIT |
| `minijinja` | 2.24.0 | Jinja syntax, so an email template is readable by someone who has never written Rust, and templates load at runtime rather than at compile time — which is what lets a deployment override one. | `askama` (compile-time, so a template change is a rebuild), `tera` (larger), `handlebars` | Apache-2.0 |
| `reqwest` | 0.12.28 | The SMS provider behind `SmsSender`, and `openidconnect`'s HTTP client. **Held on 0.12, not 0.13**: `openidconnect` 4 reaches reqwest through `oauth2` 5, which requires `^0.12`. Taking 0.13 here would compile two reqwest trees and two TLS stacks into one binary for nothing. It costs one duplicate — reqwest 0.12 depends on `tower-http` 0.6 while the server is on 0.7 — which is the cheaper of the two duplications. | `ureq`, `hyper` directly | MIT OR Apache-2.0 |
| `deunicode` | 1.6.2 | GSM-7 transliteration, in part. See below. | `any_ascii` 0.3.3 (larger tables, same job), `unicode-normalization` + hand-rolled folding | BSD-3-Clause |
| `ics` | 0.5.8 | RFC 5545 writer: 75-octet line folding, `\` `,` `;` and newline escaping, CRLF. Those are the parts of ICS that are actually easy to get wrong. It has no dependencies and takes `&str`, so jiff formats the instants. **Last released September 2022** — accepted, because RFC 5545 is from 2009 and has not moved, the crate is small enough to vendor in an afternoon, and the alternative is worse. | `icalendar` 0.17.13 — maintained, and it hard-depends on `chrono`. Taking it would put a second date library in the tree and make *our own* ICS code construct `chrono::DateTime` values, which [11 §2](11-engineering-standards.md#2-rust) forbids. A maintained crate that forces the wrong type is not the safer choice | MIT OR Apache-2.0 |

**GSM-7 is not a codec problem.** The obvious move is `gsm7` 0.4.1, which
encodes and decodes packed septets. That is not what is needed: the OVH and
Twilio HTTP APIs take UTF-8 text and do their own packing. What the application
needs is *"is this message representable in GSM 03.38, and how many septets is
it"* — because a schedule that spills into a second segment costs twice
([10 §4](10-prior-art-spreadsheet.md)). That is a 128-entry table plus a
10-entry extension table, and characters outside both are transliterated. So
the alphabet table and the septet count live in this repository, where they are
table-driven tests, and `deunicode` handles only the fallback for characters
GSM 03.38 genuinely cannot express. Note that French accented characters split
across both cases — `é` and `à` are in the basic alphabet, `â` and `ê` are not
— which is precisely why this cannot be "strip to ASCII".

### Authentication

| Crate | Version | Why this one | Rejected | Licence |
| --- | --- | --- | --- | --- |
| `openidconnect` | 4.0.1 | [ADR-0014](adr/0014-pluggable-oidc-providers.md) needs *one* generic client: discovery, JWKS, authorization-code with PKCE, ID-token validation including `iss`/`aud`/`exp`/`nonce`. This is the only maintained crate that does all of it. `default-features = false` with `reqwest` + `rustls-tls`, so the blocking client is not compiled. | `oauth2` alone (no discovery, no ID-token validation — the half that is security-critical), `jsonwebtoken` + hand-rolled discovery. Rolling your own OIDC validation is how `alg: none` gets shipped | MIT |

### Command line

| Crate | Version | Why this one | Rejected | Licence |
| --- | --- | --- | --- | --- |
| `clap` | 4.6.6 | `derive` + `env`. The CLI's arguments are documented in [06 §3](06-local-development.md#3-day-to-day) as a user-facing surface — `just bootstrap` is somebody's first five minutes with this project — so generated `--help`, subcommand suggestions and shell completion are the product, not decoration. | `argh`, `bpaf`, `lexopt`, `pico-args` — all smaller, all reasonable for a tool with three flags, none of which this stays | MIT OR Apache-2.0 |

`clap` is also in `evp-bin`, because the server binary carries two subcommands
that are not a server: `evp healthcheck` and `evp migrate`. Both exist because
the production image is distroless — no shell, no `curl` — so a compose
healthcheck and a migration step either go through the binary or drag a package
manager into the runtime image.

### Intake

| Crate | Version | Why this one | Rejected | Licence |
| --- | --- | --- | --- | --- |
| `csv` | 1.4.0 | The spreadsheet migration path ([08](08-volunteer-intake.md)). Google Sheets exports CSV. | `calamine` 0.36.1 — reads `.xlsx` directly, which is a format this project has decided not to accept | Unlicense OR MIT |

### Testing and tooling

None of these are linked into the binary; they are pinned because a gate that
moves under you is not a gate.

| Tool | Version | What it is for | Licence |
| --- | --- | --- | --- |
| `cargo-nextest` | 0.9.144 | The test runner in `just test`. Process-per-test isolation, which is what makes "no test depends on another test's data" ([13 §8](13-testing-and-tdd.md#8-determinism-and-the-flaky-test-policy)) true rather than hoped. It has no retry mechanism to disable. | Apache-2.0 OR MIT |
| `sqlx::test` | (in `sqlx`) | Chosen for a transaction-scoped database per test, built from `migrations/`. **Not used:** it needs `CREATEDB`, which neither database role has on purpose, so the suites instead run each test in one rolled-back transaction against the Compose database ([13 §6](13-testing-and-tdd.md#6-do-not-mock-the-database)). | MIT OR Apache-2.0 |
| `insta` | 1.48.0 | Snapshots of `openapi.json` (once one is generated) and of `problem+json` bodies, so an unintended contract change fails the build ([06 §4](06-local-development.md#4-testing-strategy)). Reviewed with `cargo insta review`, which is the part that stops a snapshot suite becoming a rubber stamp. | Apache-2.0 |
| `proptest` | 1.11.0 | The four properties in [13 §11](13-testing-and-tdd.md#11-property-based-testing-where-it-pays) — availability merging, range arithmetic, engine-versus-constraint agreement, schedule round-trips. | MIT OR Apache-2.0 |
| `rstest` | 0.27.0 | Table-driven cases for the route × role matrix and the failure catalogues, which [13 §7](13-testing-and-tdd.md#7-what-makes-a-test-good-here) asks for by name. | MIT OR Apache-2.0 |
| `cargo-mutants` | 27.1.0 | The efficacy gate ([13 §9](13-testing-and-tdd.md#9-mutation-testing-the-efficacy-gate)). Zero survivors on `evp-domain`, `evp-intake` and the authorisation extractors. | MIT |
| `cargo-llvm-cov` | 0.9.1 | The coverage ratchet ([13 §10](13-testing-and-tdd.md#10-coverage-a-ratchet-not-a-target)). Needs `llvm-tools-preview`, which `rust-toolchain.toml` installs. | Apache-2.0 OR MIT |
| `cargo-deny` | 0.20.2 | RUSTSEC advisories and the licence allow-list ([`deny.toml`](../deny.toml)). | MIT OR Apache-2.0 |
| `cargo-chef` | 0.1.78 | Dependency-layer caching in the production image ([02 §9](02-architecture.md#9-deployment-topology)). | Apache-2.0 OR MIT |
| `sqlx-cli` | 0.9.0 | `migrate add`, `prepare --check`. Installed with `--no-default-features --features postgres,rustls,sqlx-toml`; the default drags in MySQL, SQLite and `native-tls`. | MIT OR Apache-2.0 |
| `watchexec-cli` | 2.7.2 | Rebuild-on-change in the development image. **This replaces `cargo-watch`**, which [06 §1](06-local-development.md#service-notes) names: cargo-watch's last release is October 2024 and its own README points here. `watchexec --restart -- cargo run` is the exact equivalent. | Apache-2.0 |

## 3. The contested decisions

Most of the register was not a close call. Six were, and they have their own
record: [ADR-0030 — Backend dependency selection](adr/0030-backend-dependency-selection.md).

## 4. Crates deliberately not used

Worth writing down, because each of these is something a competent person would
otherwise add by reflex.

| Not used | Why not |
| --- | --- |
| `validator`, `garde` | Derive-based validation is the wrong model here. [11 §2](11-engineering-standards.md#2-rust) says parse, do not validate: `Email`, `Phone`, `Slug`, `TimeZone` are newtypes with fallible constructors, so a DTO that deserialises has *already* been checked and downstream code cannot receive an invalid one. A `#[validate(email)]` attribute leaves the field a `String` afterwards, which is the bug the newtypes exist to prevent. Lengths and array bounds are `TryFrom` on the DTO. |
| `mockall`, `wiremock` | [13 §6](13-testing-and-tdd.md#6-do-not-mock-the-database) — the invariants live in PostgreSQL, so a mocked repository tests a fiction. The genuine external boundaries each get a real thing or a hand-written fake: Dex for OIDC, Mailpit for SMTP, an `SmsSender` fake that records messages. None of those needs a mocking framework. |
| `axum-test` | API contract tests run against a live server bound to port 0 ([06 §4](06-local-development.md#4-testing-strategy)). An in-process harness skips the layer stack, which is where the request id, the body limit and the panic catcher are — exactly the things worth testing. |
| `vergen` | Wraps `git describe` in a build dependency that pulls `git2` or `gix`, and still would not solve the case that matters: the production build context has no `.git`, so the commit arrives as a build argument regardless. `build.rs` does it in twenty lines with no dependency. |
| `dotenvy` | Configuration comes from the process environment, put there by Compose ([02 §8](02-architecture.md#8-cross-cutting-concerns)). A `.env` file read by the application is a second, undocumented source that behaves differently in development and production. `.env` is already gitignored for the tooling that wants it. |
| `async-trait` | Rust 2024 has async functions in traits. The crate solved a language gap that closed. |
| `once_cell`, `lazy_static` | `std::sync::LazyLock`. |
| `tokio-cron-scheduler` | The retention sweep is one job on a daily interval reading its period from the organisation's policy ([15 §5](15-privacy-and-retention.md#5-the-one-month-sweep)). `tokio::time::interval` plus the outbox is the whole requirement; a cron parser is a DSL nobody asked for. |
| `redis`, `deadpool-redis` | [ADR-0006](adr/0006-postgres-backed-job-queue.md). One stateful component is enough — and Redis's licence would fail `deny.toml` anyway, which is a coincidence rather than the reason. |
| `chrono`, `time` | [ADR-0019](adr/0019-time-discipline.md). Both arrive transitively — `chrono` under `openidconnect` — and `deny.toml` permits it there and nowhere else. |
| `bigdecimal` | See `rust_decimal`. |
| `icalendar`, `calamine`, `gsm7` | See the outbound and intake tables. Each is a good crate that solves an adjacent problem. |

## 5. Adding a dependency

A new runtime dependency is item 10 on the security review list
([12 §9](12-security.md#9-reviewing-security-relevant-change)). The steps:

1. **Say what it replaces.** Either code this project would otherwise write, or
   another dependency. "It would be convenient" is not an answer; convenience
   is what a twenty-line module also provides, without a supply chain.
2. **Check the licence against
   [CONTRIBUTING.md](../CONTRIBUTING.md#dependencies).** Anything outside the
   allow-list needs discussion *before* the code is written, not after.
   `cargo deny check licenses` gives the answer in seconds, including for the
   transitive tree, which is where the surprise usually is.
3. **Look at its last release, its maintainer count and its own dependency
   tree.** A crate with one maintainer and forty dependencies is forty-one
   risks. State what the crate being abandoned would cost — if the answer is
   "an afternoon", that is a reason to accept it, and if the answer is "a
   rewrite", it needs to be load-bearing enough to justify that.
4. **Pin the exact minor version** in `[workspace.dependencies]`, with
   `default-features = false` unless every default feature is wanted. Defaults
   are where a second TLS stack, a second async runtime and a C toolchain get
   in.
5. **Add a row to §2**, including the alternative that was rejected. A register
   that records only what was chosen loses the reasoning the moment the person
   who chose it leaves.
6. **Run `cargo deny check`.** Advisories, licences, and duplicate majors.

Removing one needs no ceremony. It needs its row moved to §4 with the reason.

## 6. What is not pinned yet

Stated so that the gaps are visible rather than discovered.

| Thing | When | Why not now |
| --- | --- | --- |
| PDF rendering | M5 | See §7 — one of the two candidates conflicts with the image-size constraint, and the decision needs that resolved first. |
| Symmetric encryption for recoverable secrets | M1 | `chacha20poly1305` or `aes-gcm`. The choice follows the key-rotation design, not the other way round. |
| A seeded PRNG for `evp-cli seed` | M2 | `rand` 0.10, when there is something to seed. |
| ICU collation / message formatting in Rust | M3 | Server-rendered mail and SMS format with the recipient's locale ([16 §6](16-i18n-and-time.md#6-localisation)). The frontend's ICU story is settled; the backend's is not, and guessing now would pin a large dependency for an unwritten template. |

## 7. Known tensions

Five things in this document are honest problems rather than settled answers.

**`lettre` cannot reach a TLS relay without a licence decision.** Its feature
graph is `tokio1-rustls-tls → rustls-tls → webpki-roots`, and there is no
native-roots path: `webpki-roots` is the *only* root store lettre 0.11 knows
how to build. `webpki-roots` is **CDLA-Permissive-2.0**, which is not on the
allow-list in [CONTRIBUTING.md](../CONTRIBUTING.md#dependencies), so
`cargo-deny` refuses it. That list exists precisely so this question gets asked
rather than answered by a transitive feature flag, and the answer is probably
"add CDLA-Permissive-2.0" — it is a permissive *data* licence over Mozilla's
root store, it imposes nothing on the software that reads it, and the
alternative is an OpenSSL dependency in a distroless image. But it is a licence
decision under AGPL and it belongs to whoever owns that call, so `lettre` is
pinned here and deliberately not yet a dependency of `evp-worker`. It has to be
settled before M3, and the three options are: extend the allow-list; supply a
`rustls::ClientConfig` built from `rustls-native-certs` and use lettre's bare
`tokio1-rustls`; or accept `tokio1-native-tls` and the OpenSSL that comes with
it.

**`figment` has not released since May 2024.** It is a single-maintainer crate
(Rocket's author) and Rocket itself has not released since 2024 either, so this
is not obviously "finished". It is kept because the surface used here is about
thirty lines — `Env::prefixed`, `Toml::file`, `extract` — and because its error
provenance is the specific feature that makes a malformed value a legible
startup failure rather than a serde message with no context. If it needs
replacing, `config` 0.15.25 is the target and the work is a day. That is a
cheap enough exit to accept the risk.

**`openidconnect` 4.0.1 has not released since July 2025** and holds part of
the tree back: `thiserror` 1, `rand` 0.8, `sha2` 0.10, `getrandom` 0.2,
`base64` 0.21 and `chrono` 0.4 all appear only because of it, alongside the
current majors the rest of the workspace uses. `deny.toml` treats duplicate
majors as a warning for exactly this reason. It is kept because
[ADR-0014](adr/0014-pluggable-oidc-providers.md) requires a generic OIDC client
and this is the only maintained one — and because the alternative, hand-rolling
ID-token validation, is the single worst place in this codebase to be original.
This is the dependency to watch.

**PDF rendering has a constraint conflict that needs a decision, not a
crate.** [02 §9](02-architecture.md#9-deployment-topology) requires the API
image to be "well under 50 MB". The Typst CLI binary is tens of megabytes on
its own — it embeds fonts and a full typesetting engine — so `distroless/cc` +
`evp` + `evp-cli` + `typst` is unlikely to fit, and `typst` as a *library* has
an explicitly unstable API, which is a poor thing to pin a release artefact to.
`printpdf` 0.12.8 (MIT) keeps rendering in-process at a far smaller cost, at
the price of imperative layout code for
what [02 §2](02-architecture.md#2-technology-choices) correctly calls
typographic documents. The three ways out — relax the image budget, render PDFs
in a separate worker image, or accept `printpdf` — are a product decision
before they are a dependency one, and M5 is soon enough to take it.

**`cargo-watch` is named in [06 §1](06-local-development.md#service-notes) and
is not what the development image installs.** It has not released since October
2024 and its own README directs users to `watchexec`. The command in
`docker/api/Dockerfile.dev` is behaviourally identical. This document and that
Dockerfile are the current answer; 06 §1 should be corrected.
