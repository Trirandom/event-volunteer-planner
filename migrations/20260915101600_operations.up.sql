-- One row per mutating request, in the same transaction as the change it
-- describes (ADR-0024, docs/03 §3.9). `inverse` is a compensating COMMAND,
-- replayed through the domain service on undo, not a stored diff — so an
-- undo goes through the constraint engine and cannot reinstate a state that
-- has since become impossible.
--
-- This migration brings the table itself and what `evp-db` needs to record
-- "this endpoint's inverse, and its id" for the festival/event endpoints
-- landing alongside it. `POST …/operations/{id}/undo` — actually replaying an
-- inverse — is not built here; see the migration's companion Rust code for
-- what is and is not implemented.
CREATE TABLE operations (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id    uuid,
  actor_id    uuid NOT NULL REFERENCES users(id),
  kind        text NOT NULL,
  summary     jsonb NOT NULL,
  inverse     jsonb NOT NULL,
  entity_ids  uuid[] NOT NULL,
  undoable    boolean NOT NULL DEFAULT true,
  undo_of     uuid REFERENCES operations(id),
  undone_at   timestamptz,
  undone_by   uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (event_id, org_id) REFERENCES events(id, org_id) ON DELETE CASCADE,
  CONSTRAINT operations_undone_together CHECK (
    (undone_at IS NULL) = (undone_by IS NULL)
  )
);
CREATE INDEX operations_undo_stack ON operations (org_id, actor_id, created_at DESC)
  WHERE undoable AND undone_at IS NULL;
CREATE INDEX operations_entities ON operations USING gin (entity_ids);

ALTER TABLE operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE operations FORCE ROW LEVEL SECURITY;
CREATE POLICY operations_tenant_isolation ON operations
  USING      (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

INSERT INTO retention_scope (table_name, tier, reason) VALUES
  ('operations', 'event', 'undo payloads name entities and people');
