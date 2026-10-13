# ADR-0002 — Rust and Axum for the backend

**Status:** Accepted · **Date:** 2026-09-10

## Context

The backend serves a small, well-understood API for at most a few dozen
concurrent users. It is self-hosted, so runtime footprint and patch burden fall
on the same person who writes the code. Rust was the stated preference.

## Decision

Rust, with Axum 0.8 on Tokio, SQLx for data access, and a Cargo workspace split
into `domain` / `db` / `api` / `worker` / `cli` / `bin`.

Axum specifically, over Actix Web, Rocket and Poem: it sits directly on
`tower`, so timeouts, tracing, rate limiting and body limits are existing
middleware rather than framework-specific features; its extractor model
expresses "this handler requires an authenticated coordinator scoped to an
organisation" as a type, which is exactly the invariant most worth encoding.

## Alternatives considered

**TypeScript (Node/Bun with Fastify or NestJS).** One language across the
stack, the largest ecosystem, and the fastest iteration. Rejected primarily
because the preference was stated, but there is a real argument for it: the
scheduling logic would be shareable between client and server verbatim. If
delivery speed had been the dominant constraint, this would have been the
right answer.

**Go.** Similar deployment story to Rust — a static binary, small image, low
memory — with a much gentler learning curve and faster compile times. Rejected
on the stated preference. Its weaker type system is a genuine but modest
disadvantage for the state machines here.

**Actix Web.** Marginally faster in benchmarks, which is irrelevant at this
scale, and its actor heritage makes middleware less composable than `tower`.

**An ORM (SeaORM, Diesel) instead of SQLx.** The interesting queries here —
coverage, overlap detection, availability matching — are set-based SQL using
range types and GiST indexes. An ORM would obscure them, and the schema is
where the correctness guarantees live, so the query layer should be transparent
about what it sends.

## Consequences

- Small static binary, distroless image, low idle memory, no runtime to patch.
- Compile-time-checked SQL and exhaustive enums catch a class of bugs before
  they run.
- Slower iteration than a scripting backend, especially early. `cargo-chef`
  and a persistent `target` volume mitigate but do not eliminate this.
- A smaller pool of contributors who can pick the project up. For a project of
  this size, with a known maintainer, that is an accepted cost.
