-- docs/03 §3.4. `location_kind` is declared here, where it is first used.
CREATE TYPE location_kind AS ENUM ('zone', 'post');

CREATE TABLE locations (
  id         uuid PRIMARY KEY,
  org_id     uuid NOT NULL,
  event_id   uuid NOT NULL,
  parent_id  uuid,                                  -- posts point at their zone
  kind       location_kind NOT NULL,
  name       text NOT NULL,
  sort_order int NOT NULL DEFAULT 0,
  colour     text,
  shift_pattern_id uuid,
  version    int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (event_id, parent_id, name),
  FOREIGN KEY (event_id, org_id)  REFERENCES events(id, org_id)    ON DELETE CASCADE,
  FOREIGN KEY (parent_id, org_id) REFERENCES locations(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (shift_pattern_id, org_id)
    REFERENCES shift_patterns(id, org_id) ON DELETE SET NULL (shift_pattern_id),
  CONSTRAINT locations_hierarchy CHECK (
    (kind = 'zone' AND parent_id IS NULL) OR (kind = 'post' AND parent_id IS NOT NULL)
  )
);
CREATE INDEX ON locations (event_id, sort_order);

CREATE TRIGGER locations_bump_version
  BEFORE UPDATE ON locations
  FOR EACH ROW EXECUTE FUNCTION bump_version();

ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations FORCE ROW LEVEL SECURITY;
CREATE POLICY locations_tenant_isolation ON locations
  USING      (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

INSERT INTO retention_scope (table_name, tier, reason) VALUES
  ('locations', 'accountability', 'the zone/post tree for an edition; structural, not personal data');
