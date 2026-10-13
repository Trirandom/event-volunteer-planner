# ADR-0001 — Record architecture decisions

**Status:** Accepted · **Date:** 2026-09-10

## Context

The stack for this project was chosen partly from preference and partly from
constraints that are obvious now and will not be in a year. Without a record,
the reasoning is lost and every choice gets relitigated, usually by the person
who made it.

## Decision

Record every architecturally significant decision as a numbered ADR in
`docs/adr/`. Significant means: hard to reverse, affects more than one
component, or has a plausible alternative someone will later ask about.

Format: Context, Decision, Alternatives considered, Consequences. Status is
one of Proposed, Accepted, Superseded by ADR-NNNN. ADRs are immutable once
accepted — a change of mind is a new ADR that supersedes the old one, never an
edit.

## Consequences

- The "why not X" question has an answer that does not depend on memory.
- Roughly thirty minutes of writing per decision.
- ADRs can become stale relative to the code. Superseding rather than editing
  keeps the history readable at the cost of requiring a reader to follow a
  chain.
