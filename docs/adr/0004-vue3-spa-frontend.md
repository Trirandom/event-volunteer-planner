# ADR-0004 — Vue 3 SPA, with TanStack Query for server state

**Status:** Accepted · **Date:** 2026-09-10

## Context

The core surface is a dense, interactive planning board: locations on one axis,
time on the other, drag-and-drop assignment, live constraint feedback. That is
a client-heavy application, not a document. Vue was the stated preference.

## Decision

Vue 3 with `<script setup>` and TypeScript, built by Vite, served as static
assets. **TanStack Query** for all server state; **Pinia** only for genuinely
client-side state (current org and event, board zoom, selection, filters).
Tailwind for styling, with local primitives rather than a component library.

The server/client state split is the decision that matters. Almost everything
on screen is a cache of server data, and hand-rolling invalidation, refetching,
retry and optimistic rollback in Pinia stores is how frontends rot. Query does
it, and optimistic updates with automatic rollback are precisely what drag-and-
drop against a constraint-checking server needs.

## Alternatives considered

**Nuxt.** SSR, file routing, a batch of conventions. Rejected: the application
is behind a login and has no SEO or first-paint-of-content requirement, so SSR
buys nothing here and adds a Node process to the production deployment — which
would undo the single-static-binary property that motivated the backend choice.

**React.** Larger ecosystem, and a stronger set of virtualisation and DnD
libraries. Rejected on the stated preference.

**Server-rendered HTML with htmx or Leptos.** Very appealing for the CRUD
screens, and it would remove the API-client generation step entirely. Rejected
because the board needs client-side geometry: pixel↔time mapping, drag preview,
virtualised scrolling. That is a round trip per pointer move, or a large amount
of bespoke JavaScript inside a paradigm that does not want it.

**A scheduler component library** (`vue-cal`, FullCalendar, a Gantt library).
Evaluated and rejected: the board's rows are a two-level location hierarchy,
its blocks carry per-assignment warning state, and the drop target must be
computed from the same time scale used for layout. Bending a general library to
that is more work than a purpose-built CSS-grid component, and it would fight
the keyboard-accessibility requirement, which those libraries handle poorly.

## Consequences

- Static assets, served by Caddy. No Node in production.
- A generated TypeScript client from OpenAPI: the API contract cannot drift
  from the client silently.
- The board is bespoke, and therefore ours to maintain — including its
  virtualisation and its accessibility. Explicitly budgeted for in M2.
- Tailwind without a component library means building form controls, modals and
  tables. Slower at the start; avoids fighting someone else's abstractions in a
  dense, unusual UI.
