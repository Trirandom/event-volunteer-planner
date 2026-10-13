# ADR-0024 — Server-side undo, and bulk operations report per item

**Status:** Accepted · **Date:** 2026-09-10
**Amends:** [ADR-0017](0017-accessibility-target-wcag22-aa.md), which recorded
"bulk endpoints must return an operation id and record an inverse" as a
consequence without specifying the mechanism. This is that mechanism. It also
replaces the all-or-nothing bulk convention previously stated in
[04 §1](../04-api.md#1-conventions).

## Context

[ADR-0017](0017-accessibility-target-wcag22-aa.md) treated accessibility and
mass modification as one programme, and concluded that bulk editing without
undo is bulk editing nobody dares to do. It then left two things unspecified,
and the documentation drifted into contradicting itself:

- [14 §4](../14-accessibility-and-interaction.md#4-mass-modification) describes
  bulk operations as returning a **per-item** result — "assign these 3 to these
  12 shifts" reports the two that clashed and applies the rest — while
  [04 §1](../04-api.md#1-conventions) stated that bulk endpoints are
  all-or-nothing.
- Undo was described as a backend requirement in two documents, and the API
  surface had no endpoint, no operation id, and no table behind it.

Both gaps are in the part of the product that decides whether a coordinator
prefers this to a spreadsheet, so neither can stay a sentence of intent.

## Decision

### 1. Every mutating request is an operation

One row in `operations` per mutating request, written in the same transaction as
the change it describes:

```sql
CREATE TABLE operations (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL,
  actor_id    uuid NOT NULL REFERENCES users(id),
  kind        text NOT NULL,          -- 'assignment.bulk_create', 'shift.update', …
  summary     jsonb NOT NULL,         -- counts and entity labels, for the undo affordance
  inverse     jsonb NOT NULL,         -- the compensating command, replayable by the domain
  entity_ids  uuid[] NOT NULL,        -- what it touched; used to refuse a stale undo
  undoable    boolean NOT NULL DEFAULT true,
  undo_of     uuid REFERENCES operations(id),
  undone_at   timestamptz,
  undone_by   uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

`inverse` is a command, not a diff: the compensating action is executed through
the same domain service as the original, so it goes through the constraint
engine and cannot itself produce an invalid state. An undo that would violate a
hard constraint is refused with the same `violations` payload as any other
write, which is the correct outcome — the world moved on.

### 2. Undo is a real endpoint, not a client-side rewind

```
GET  /api/v1/orgs/{org}/operations            ?limit=      → the caller's recent undoable operations
POST /api/v1/orgs/{org}/operations/{id}/undo               → applies the inverse as a new operation
```

- Undo survives a page reload, and works from a different device, because the
  stack is server state.
- It is refused `409` when a later operation has touched an overlapping
  `entity_ids` set, when the operation is already undone, and when the change
  has been published — publication has already sent email, so the correction is
  a new change and a republish
  ([14 §4](../14-accessibility-and-interaction.md#4-mass-modification)).
- An undo is itself an operation, with `undo_of` set, so redo is undoing the
  undo and history stays append-only. `audit_log` rows carry `operation_id`.

### 3. Bulk endpoints are per-item; configuration replacement is atomic

The two kinds of bulk endpoint were being described by one rule, which is why
the documents disagreed. They are separated:

| Shape | Semantics | Endpoints |
| --- | --- | --- |
| **Per-item bulk** — a set of independent domain actions | Each item is evaluated independently inside one transaction; successes commit, failures are reported with their `violations`. Response carries `operation_id` and a per-item outcome. | bulk assign, clear, copy-day, paste roster, replace volunteer, bulk enrol, invite issuing |
| **Atomic replacement** — one document submitted whole | All or nothing. There are no per-item semantics because there are no items, only a new value. | `PUT …/availability`, `PUT …/mappings`, `PUT …/questions`, `PUT …/requirements`, `PUT …/skills` |

Partial success is therefore normal for the first kind and impossible for the
second, and a reader no longer has to guess which rule applies.

## Alternatives considered

**All-or-nothing bulk, as originally written.** Rejected on the concrete case:
assigning twelve shifts and having the whole action refused because one
volunteer is now busy is exactly the behaviour that sends a coordinator back to
a spreadsheet. The clash is information, not a failure of the batch.

**Client-side undo over optimistic state.** Rejected: it cannot survive a
reload, cannot be used by the coordinator who did not make the change, and
would be undoing a UI state rather than a domain action. It is also the version
that quietly stops working when a mutation happens outside the board.

**Storing a row-level diff and reversing it directly.** Simpler to write, and
wrong: applying a stored diff bypasses the constraint engine, so an undo could
reinstate a double-booking that became impossible in the meantime. Replaying an
inverse *command* through the domain keeps every invariant in force.

**Reconstructing the inverse from `audit_log`.** Tempting, since the before/after
values are already there. Rejected: the audit log is append-only evidence and
must stay a record rather than becoming an execution input, and a bulk operation
is many audit rows whose grouping would have to be inferred.

**No undo; rely on the audit log.** Rejected. The audit log answers "what
happened"; it does not put the roster back, and the fear of an irreversible
bulk edit is what stops bulk edits being used at all.

## Consequences

- Mass modification becomes usable in practice, which is the whole point of
  [ADR-0017](0017-accessibility-target-wcag22-aa.md).
- One extra table, one extra row per mutating request, and every domain service
  must be able to describe its own inverse. That last part is real work and is
  the reason this is an ADR rather than a footnote.
- Operations are org-scoped and RLS-protected like any tenant table, so an undo
  cannot reach another organisation.
- `operations.inverse` can name entities that no longer exist. Undo therefore
  validates against the current state and fails cleanly rather than resurrecting
  rows.
- Publication is the boundary of reversibility, and the UI must say so before a
  publish rather than after an attempted undo.
- `operations` carries a nullable `event_id` and sits in the **event** tier
  ([ADR-0026](0026-retention-scope-is-a-table-registry.md)): rows go when their
  event is purged, and in any case once they age past the undo window, which is
  short by purpose. An `inverse` payload is therefore never a durable second
  copy of personal data.
