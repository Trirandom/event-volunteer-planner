-- The join between a volunteer and an event (docs/03 §3.5). One concern: the
-- skeleton — identifiers, the link, the status, timestamps — nothing
-- personal beyond the fact that this person volunteered, which the roster
-- records anyway.
--
-- `participation_details` is NOT here: nothing in this vertical slice reads
-- or writes a t-shirt override, a meal plan, an arrival time or the
-- `is_adult` declaration, and a half-populated table is worse than an
-- honestly absent one (docs/13 §2). It lands with the milestone that needs
-- one of those columns.
CREATE TYPE participation_status AS ENUM ('invited', 'confirmed', 'declined', 'withdrawn');

CREATE TABLE participations (
  id                uuid PRIMARY KEY,
  org_id            uuid NOT NULL,
  event_id          uuid NOT NULL,
  volunteer_id      uuid NOT NULL,
  status            participation_status NOT NULL DEFAULT 'invited',

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, volunteer_id),
  UNIQUE (id, volunteer_id),                    -- anchor for the assignment composite FK
  UNIQUE (id, event_id),                        -- anchor for the details composite FK
  UNIQUE (id, org_id),
  FOREIGN KEY (event_id, org_id)     REFERENCES events(id, org_id)     ON DELETE CASCADE,
  FOREIGN KEY (volunteer_id, org_id) REFERENCES volunteers(id, org_id) ON DELETE CASCADE
);
CREATE INDEX ON participations (event_id, status);

ALTER TABLE participations ENABLE ROW LEVEL SECURITY;
ALTER TABLE participations FORCE ROW LEVEL SECURITY;
CREATE POLICY participations_tenant_isolation ON participations
  USING      (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

INSERT INTO retention_scope (table_name, tier, reason) VALUES
  ('participations', 'accountability', 'the link; pseudonymous once anonymised');
