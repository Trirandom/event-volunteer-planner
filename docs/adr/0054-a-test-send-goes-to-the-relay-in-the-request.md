# ADR-0054 — A test send of the schedule email goes to the relay in the request, not through the outbox

**Status:** Accepted · **Date:** 2026-11-19
**Amends:** [ADR-0006](0006-postgres-backed-job-queue.md), docs/04 §"Publishing"

## Context

docs/04 §"Publishing" gives `publish` three modes. `test` sends the whole
run to one address and answers "does the rendered message look right",
which neither the page's preview nor a diff can. Of the three, it is the one
a coordinator needs first: the emails page (ADR-0046) previews every
message, and nobody has yet seen one arrive in a real mail client.

None of what `send` needs exists yet: no outbox table, no consumer, no
`schedule_snapshots`, no roster versions, no server-side template. The
template is a draft in the coordinator's browser. `SmtpMailSender` and
`evp_domain::schedule::plan::compose` are built and tested, but nothing
calls them.

ADR-0006 rejects sending email synchronously in the request because publish
latency would grow with the number of volunteers, a relay outage would fail
the whole publish, and nothing would retry. Each of those reasons is about a
send that must reach volunteers and must commit or roll back with the
roster. A test send is neither:

- It changes no data. Nothing has to be atomic with it, and it must **not**
  move the "last sent" baseline (docs/03 §3.7), or the first real send
  would compare against a schedule nobody received.
- Every message goes to one address that the coordinator typed a moment
  ago, and they are waiting to open it. A failure is something to tell them
  now ("the relay refused the address"), not something to retry in the
  background where they cannot see it.

## Decision

`test` is served on its own, before `send` and `dry_run`, as two routes:

```
POST /api/v1/orgs/{org}/events/{event}/publish/test
POST /api/v1/orgs/{org}/festivals/{festival}/publish/test
     { test_recipient, locale, template: { subject, body_html } }
     → { sent, skipped_opted_out, no_address[], failed[] }
```

- **The relay is called from the handler**, one message after another
  through the shared `MailSender`, after the read transaction has committed.
  No outbox row and no snapshot are written.
- **The template travels in the body**, because it has no server-side home
  yet. It is rendered by the same `compose` the outbox will use, so the test
  exercises the real renderer and not the page's copy of it.
- **The run is the one `send` would make**: participations `invited` or
  `confirmed` in scope, lines from the live assignments merged by
  `merge_adjacent`. Opted-out volunteers are counted and those with no
  address are listed, as `send` will report them, and neither is mailed.
  Every message is the `First` kind, which is what `send` would send while
  nobody has been sent anything.
- **Each message says whose it is.** Its subject starts with `[Test: <name>]`,
  so a few hundred messages in one inbox can be told apart.
- Coordinator or above, like every plan write.

## Alternatives considered

**Build the outbox first and enqueue test messages on it.** This is the
eventual shape for `send`, and test messages could travel the same way. It
was rejected for now because the outbox, the consumer and snapshots are each
a change of their own, and the coordinator would then have to watch a queue
to learn that the relay refused their address. When the outbox lands, `test`
can stay synchronous or move onto it; nothing here makes either choice
harder.

**One `publish` route that accepts `mode: "test"` and refuses the other
two.** That is closer to docs/04's single route. It was rejected because
`test` has its own body (the template) and its own response (no
`roster_version`), so the mode would choose between two contracts. A route
that refuses two of its three documented modes would also be a route that
does half its job.

**Render on the page and post finished messages.** That would be less code,
and it would also make the test prove nothing about the server. It would send
whatever HTML the browser produced to any address, which is a relay anyone
with a coordinator session could use for any content.

## Consequences

- A coordinator can see the real messages in a real client now. In
  development they land in Mailpit.
- `evp-api` depends on `evp-worker` for `MailSender`. The dependency points
  the same way the composition root already wires them, and `evp-worker`
  depends on nothing in `evp-api`.
- A large run holds the request open for as long as the relay takes, which
  is about a few hundred SMTP transactions over one pooled connection. That
  is acceptable for a button the coordinator presses deliberately and then
  waits on. It is not acceptable for `send`, which stays on ADR-0006.
- The route does write to the outside world, but it records no operation and
  has no inverse (ADR-0024), because a sent email cannot be unsent and the
  route changed no data. That is the reason the route sends only to
  `test_recipient`.
