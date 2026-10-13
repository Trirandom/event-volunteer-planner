-- What a participation declared about one event (docs/03 §3.5, docs/09 §3):
-- the availability picker's whole reason for existing. One concern: the
-- table plus the hard invariant that a participation cannot declare two
-- windows that overlap at all — the two travel together because the
-- invariant has nothing to protect before the table exists (the same
-- reasoning `shifts` and `shift_outside_event` were migrated together under).
CREATE TYPE availability_kind AS ENUM ('available', 'unavailable');

CREATE TABLE availability_windows (
  id               uuid PRIMARY KEY,
  org_id           uuid NOT NULL,
  participation_id uuid NOT NULL,
  kind             availability_kind NOT NULL,
  period           tstzrange NOT NULL,
  note             text,
  -- Provenance: exactly one of these, and the CHECK says exactly. A
  -- coordinator entered it by hand, or it was derived from a form submission
  -- (ADR-0009). Volunteers cannot log in, so there is no third case.
  declared_by      uuid REFERENCES users(id),
  source_submission_id uuid REFERENCES submissions(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (participation_id, org_id) REFERENCES participations(id, org_id) ON DELETE CASCADE,
  CONSTRAINT availability_period_valid CHECK (NOT isempty(period)),
  CONSTRAINT availability_has_provenance CHECK (
    (declared_by IS NOT NULL) <> (source_submission_id IS NOT NULL)
  ),
  -- A participation cannot declare two windows that overlap AT ALL, whatever
  -- their kind: "available 10:00-14:00" and "unavailable 12:00-16:00" on the
  -- same day is not a preference, it is a contradiction, and the engine would
  -- have to arbitrate it. The picker merges on input (09 §3); this is the
  -- backstop.
  EXCLUDE USING gist (participation_id WITH =, period WITH &&)
);
CREATE INDEX availability_lookup ON availability_windows USING gist (participation_id, period);

ALTER TABLE availability_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE availability_windows FORCE ROW LEVEL SECURITY;
CREATE POLICY availability_windows_tenant_isolation ON availability_windows
  USING      (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

INSERT INTO retention_scope (table_name, tier, reason) VALUES
  ('availability_windows', 'event', 'what someone said about one edition');
