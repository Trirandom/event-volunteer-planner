# ADR-0006 — Transactional outbox in PostgreSQL, no broker

**Status:** Accepted · **Date:** 2026-09-10

## Context

Work happens outside the request cycle: schedule emails on publish, magic-link
and invitation emails, PDF generation, ICS regeneration. Volume is modest —
a few hundred emails at a publish, a handful the rest of the time.

There is a specific correctness requirement. Publishing a roster writes
assignments *and* sends email. If the transaction rolls back after the mail is
sent, volunteers hold schedules that do not exist. If mail is sent before the
commit, the same. The two must be atomic.

## Decision

A transactional outbox table in PostgreSQL, consumed by a worker running in the
API process.

Enqueue happens in the same transaction as the business change, so a rollback
un-sends the not-yet-sent message. The worker claims rows with
`FOR UPDATE SKIP LOCKED`, which is safe for any number of workers, so scaling
out later requires no change. `LISTEN/NOTIFY` wakes the worker on enqueue; a
5-second poll is the fallback so a missed notification costs latency, not
delivery. Retries back off exponentially on `run_after`; after `max_attempts`
the row is parked with its error and surfaced in an admin view rather than
dropped.

Delivery is at-least-once, so handlers must be idempotent. For email that means
a deduplication key per `(roster_version, participation)`.

## Alternatives considered

**Redis with a queue library.** The reflexive choice. Rejected: it adds a
stateful component with its own persistence configuration, backup story and
failure modes, and — decisively — it cannot participate in the PostgreSQL
transaction, so the atomicity requirement above would need an outbox in
PostgreSQL *anyway*, with Redis as a redundant second hop.

**RabbitMQ / NATS.** Real queueing semantics, at real operational cost. Correct
for high throughput or multiple independent consumers. Neither applies.

**`pg_cron` or a database-side scheduler.** Puts application logic in the
database, where it cannot be tested or version-controlled with the rest.

**Send email synchronously in the request.** Simplest, and wrong: it makes
publish latency proportional to the number of volunteers, fails the whole
publish if the SMTP server is briefly unreachable, and has no retry.

**`apalis` with its PostgreSQL backend.** A reasonable off-the-shelf version of
this decision. Rejected narrowly: the required behaviour is about 150 lines,
the transactional-enqueue guarantee is the part that must be exactly right, and
owning it avoids depending on a library's transaction semantics matching the
requirement.

## Consequences

- Email and data changes commit or roll back together.
- No extra infrastructure. The queue is backed up with the database, by the
  same mechanism, at the same point in time.
- Polling costs one indexed query every 5 seconds — negligible, and bounded by
  the partial index on pending rows.
- Throughput is limited to roughly thousands of jobs per minute. Two to three
  orders of magnitude above what this workload needs.
- Handlers must be idempotent, and the worker's `locked_at` lease means a
  crashed worker's jobs are retried after 5 minutes rather than instantly.
