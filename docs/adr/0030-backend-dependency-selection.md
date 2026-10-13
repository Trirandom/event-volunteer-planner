# ADR-0030 — Backend dependencies: the six choices where the alternative had a case

**Status:** Accepted · **Date:** 2026-09-11

## Context

[02 §2](../02-architecture.md#2-technology-choices) named the load-bearing
backend libraries and the ADRs behind them. Standing the workspace up required
deciding everything it did not name: the UUIDv7 source, the decimal type, the
SQLx feature matrix, argument parsing, the test stack, transliteration, ICS
generation, token hashing, the TypeScript client generator, and how migrations
actually run in a container with no shell.

Most of those were not decisions. `uuid` already has a stable `v7`;
`rust_decimal` maps onto `numeric(4,2)` and `bigdecimal` does not; `clap` is
what a user-facing CLI uses. Recording them would be recording a register, and
the register is [17 — Backend stack](../17-backend-stack.md).

Six were genuine, in the specific sense that the losing option had an argument
a reasonable person would make, and in three cases the loser is what an
existing document already says. Those are here, because in a year the question
will be "why on earth did they use an unmaintained ICS crate", and the answer
needs to be findable.

## Decision

**1. `ics` 0.5.8 for RFC 5545, not `icalendar` 0.17.13.** `icalendar` is
maintained and hard-depends on `chrono`. `ics` has no dependencies, takes
`&str`, and has not been released since September 2022.

**2. SHA-256 for token storage, and no password hasher anywhere.** Session,
magic-link, invitation, ICS and form tokens are ≥ 32 bytes from the OS CSPRNG,
stored as their SHA-256. `argon2` is not a dependency.

**3. No derive-validation crate.** DTO constraints are expressed as newtypes
with fallible constructors and `TryFrom` on the DTO, not as `#[validate(...)]`
attributes.

**4. `openapi-typescript` + `openapi-fetch`, output to `packages/api-client/`,**
for the generated TypeScript client.

**5. SQLx and reqwest take TLS roots from the operating system**
(`tls-rustls-ring-native-roots`, `rustls-tls-native-roots`), not from
`webpki-roots`.

**6. The `migrate` container runs `evp migrate`, not `sqlx migrate run`,** and
the development image watches with `watchexec` rather than `cargo-watch`.

## Alternatives considered

**`icalendar` for ICS.** The maintained choice, actively released, and the one
a dependency-hygiene checklist would pick. Rejected because it hard-depends on
`chrono`: taking it would put a second date library in the tree *and* require
our own ICS code to construct `chrono::DateTime` values, which
[11 §2](../11-engineering-standards.md#2-rust) forbids in as many words — "one
date library is enough". A maintained crate that forces the wrong type into the
most correctness-critical part of the codebase is not the safer choice, it is
the safer-*looking* one. The risk accepted in exchange is real and bounded:
`ics` is small, has no dependencies, and implements a specification frozen in
2009. If it breaks, it is vendored in an afternoon. Writing the folding and
escaping by hand was the third option and was rejected because those are
exactly the two parts of ICS that are subtly easy to get wrong.

**`argon2` for token hashing.** The reflexive answer, and it is right for
passwords. Rejected because the premise does not hold: a slow hash exists to
make brute force expensive against a *low-entropy, human-chosen* secret. Every
secret here is ≥ 32 bytes from a CSPRNG and cannot be brute-forced at any work
factor, so the only thing a work factor would buy is latency on every request
carrying a session cookie. The reason the question does not really arise is
structural — nothing in this system stores a password
([ADR-0005](0005-magic-link-authentication.md),
[ADR-0013](0013-google-oidc-without-an-identity-provider.md)) — and that is
worth stating so nobody adds one later "for consistency".

**`garde` 0.23 or `validator` 0.21 for DTO validation.** Both are good, both
integrate with Axum, and `validator` is widely used. Rejected because they
solve the problem the type discipline in
[11 §2](../11-engineering-standards.md#2-rust) already solves, and they solve
it worse: `#[validate(email)]` on a `String` leaves a `String` afterwards, so
the checked value and the unchecked value have the same type and nothing stops
the wrong one flowing downstream. `Email::try_from` produces a value that
cannot be invalid. The cost is that length and array bounds are written by hand
in `TryFrom`; that is a few lines per DTO and it keeps one validation model
instead of two.

**`@hey-api/openapi-ts` 0.99 for the TypeScript client.** The strongest
alternative, and it has a real advantage: a first-party TanStack Query plugin,
and the frontend uses TanStack Query ([02 §2](../02-architecture.md#2-technology-choices)).
Rejected on two grounds. It generates a runtime SDK — a function per operation,
plus its own client — which is a large generated surface to review on every
regeneration, and `api-client-fresh` in CI
([06 §5](../06-local-development.md#5-ci)) fails on any diff, so the size of
that diff is a recurring cost. And it is pre-1.0 at 0.99 with a history of
breaking output changes, which for a file that CI compares byte-for-byte is a
poor property. `openapi-typescript` emits **types only** — one `.d.ts`, no
runtime — and `openapi-fetch` is a small typed `fetch` wrapper that reads those
types. The generated artefact is therefore a type declaration, which diffs
meaningfully and cannot drift behaviourally from the server. `orval` and
`@openapitools/openapi-generator-cli` were also considered; the latter needs a
JVM in CI, which is a large thing to install for a code generator.

**`webpki-roots` for TLS trust.** The default for both SQLx's rustls feature
and lettre's, and it has a genuine advantage: the root store is compiled in, so
it works in an image with no `ca-certificates` and cannot be broken by one. It
is also **CDLA-Permissive-2.0**, which is not on the allow-list in
[CONTRIBUTING.md](../../CONTRIBUTING.md#dependencies). That list is not
decoration — under AGPL, discovering an incompatible licence after publication
is the failure mode it exists to prevent — so a licence outside it is a
discussion, not a default that arrives through a feature flag. Native roots
cost a runtime dependency on the image providing `ca-certificates`, which
`distroless/cc` does. The allow-list is left unchanged and `deny.toml` is what
stops the default creeping back in through a transitive feature.

**`sqlx migrate run` in the migrate container, and `cargo-watch` in the
development one.** Both are what [06 §1](../06-local-development.md#service-notes)
says, which is the strongest argument for them and why they are here rather
than in the register. `sqlx migrate run` was rejected on the `_FILE` convention:
production passes `EVP_MIGRATION_DATABASE_URL_FILE` because a connection URL
embeds a password ([06 §2](../06-local-development.md#the-_file-suffix)),
`sqlx-cli` knows only `DATABASE_URL`, and the image has no shell to translate
one into the other. The options were a second implementation of "exactly one of
the two forms may be set" — in shell, in an image that would then need a shell
— or routing the migration through the binary that already implements it.
A rule that must not drift should not have two implementations. `sqlx` remains
on `PATH` in that image, so `migrate add` is unaffected. `cargo-watch` was
rejected on maintenance: last released October 2024, with its own README
directing users to `watchexec`. A project that pins base images by digest
(§[12 §8](../12-security.md#8-supply-chain-and-runtime)) should not depend on
an abandoned build tool, and `watchexec --restart -- cargo run` is the same
command.

## Consequences

- The tree contains exactly one date library that this project's own code
  touches. `chrono` is present transitively under `openidconnect` and
  `deny.toml` permits it there and nowhere else, so the boundary is enforced
  rather than remembered.
- One unmaintained runtime dependency is accepted knowingly (`ics`), with a
  stated exit. That is the only one; the register's other maintenance
  observations — `figment`, `openidconnect`, `utoipa-axum` — are about release
  *cadence*, not abandonment, and are recorded in
  [17 §7](../17-backend-stack.md).
- The generated TypeScript client is a type declaration rather than an SDK, so
  the frontend writes its own thin query wrappers over `openapi-fetch`. That is
  more frontend code than `@hey-api` would generate, and it is code a person
  chose rather than code a generator emitted. This one needs agreeing with the
  frontend before either side builds on it.
- The API image depends on its base providing `ca-certificates` and
  `/usr/share/zoneinfo`. `distroless/cc` provides both, and the process asserts
  the time zone database is resolvable at startup rather than discovering it is
  not at an event.
- Two documents now disagree with [06 §1](../06-local-development.md#service-notes):
  the migrate command and the development watcher. 06 should be corrected; this
  ADR is the reasoning it should point at.
- Every DTO writes its own length and array bounds. If that becomes repetitive
  enough to be skipped, the right answer is a macro over the newtypes, not a
  validation framework — the failure this avoids is a checked value and an
  unchecked value sharing a type.
