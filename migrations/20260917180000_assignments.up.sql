-- Who is rostered where (docs/03 §3.6). One concern: the table, its
-- denormalised period and the trigger that keeps that period honest.
--
-- The invariants that make the table *safe* — no double-booking, no duplicate
-- placement, no assignment against a withdrawn participation — are the next
-- migration. They are the part a reviewer must read, and the README asks for
-- them on their own; the table is useless without them and they are applied in
-- the same deploy, so nothing runs on a schema that has one and not the other.
--
-- `period` is denormalised from `shifts.period` and it is not an optimisation.
-- PostgreSQL exclusion constraints operate on a single table, so preventing
-- double-booking requires the range to be physically present on the assignment
-- row (docs/03 §3.6). The trigger below is what stops that copy from drifting:
-- nothing in the application may set `period`, and nothing does.
CREATE TYPE assignment_status AS ENUM ('draft', 'published', 'cancelled');

CREATE TABLE assignments (
  id               uuid PRIMARY KEY,
  org_id           uuid NOT NULL,
  event_id         uuid NOT NULL,
  shift_id         uuid NOT NULL,
  participation_id uuid NOT NULL,
  -- Denormalised for the same reason `period` is: an exclusion constraint
  -- cannot join, and "one volunteer, one place at a time" is about the
  -- volunteer, not about the participation that happens to name them. The
  -- composite FK below is what guarantees the two agree.
  volunteer_id     uuid NOT NULL,
  period           tstzrange NOT NULL,
  status           assignment_status NOT NULL DEFAULT 'draft',

  assigned_by      uuid NOT NULL REFERENCES users(id),
  assigned_at      timestamptz NOT NULL DEFAULT now(),
  cancelled_at     timestamptz,
  -- Soft-constraint overrides the coordinator explicitly accepted, e.g.
  -- ["outside_availability"] (ADR-0007). Nothing writes one yet: the engine
  -- that computes warnings lands with the milestone that has rules to warn
  -- about. The column is here because `acknowledge_warnings` is part of the
  -- documented POST body (docs/04) and storing what was acknowledged is the
  -- only thing that makes an override auditable.
  acknowledged_warnings text[] NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          int NOT NULL DEFAULT 1,

  UNIQUE (id, org_id),
  FOREIGN KEY (event_id, org_id) REFERENCES events(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (shift_id, org_id) REFERENCES shifts(id, org_id) ON DELETE CASCADE,
  -- Guarantees `volunteer_id` really is this participation's volunteer, which
  -- is what makes the denormalised column safe to key an exclusion constraint
  -- off (docs/03 §3.6).
  FOREIGN KEY (participation_id, volunteer_id)
    REFERENCES participations(id, volunteer_id) ON DELETE CASCADE,
  FOREIGN KEY (participation_id, org_id)
    REFERENCES participations(id, org_id) ON DELETE CASCADE,

  -- A cancelled assignment is the record that somebody *was* on this shift, so
  -- it keeps its row; the timestamp is what says when it stopped counting, and
  -- the two must agree or the roster cannot be read back as of a date.
  CONSTRAINT assignments_cancelled_has_timestamp CHECK (
    (status = 'cancelled') = (cancelled_at IS NOT NULL)
  )
);

CREATE INDEX ON assignments (shift_id) WHERE status <> 'cancelled';
CREATE INDEX ON assignments (event_id, volunteer_id) WHERE status <> 'cancelled';

CREATE TRIGGER assignments_bump_version
  BEFORE UPDATE ON assignments
  FOR EACH ROW EXECUTE FUNCTION bump_version();

-- The copy, kept honest. `event_id` is taken from the shift as well, so an
-- assignment cannot be filed against one event and a shift of another — the
-- composite foreign keys above police tenancy, not which event a shift is in.
CREATE FUNCTION assignments_sync_period() RETURNS trigger AS $$
BEGIN
  SELECT s.period, s.event_id INTO NEW.period, NEW.event_id
    FROM shifts s WHERE s.id = NEW.shift_id AND s.org_id = NEW.org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shift % does not exist', NEW.shift_id
      USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'assignments_shift_id_fkey';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER assignments_period_sync
  BEFORE INSERT OR UPDATE OF shift_id ON assignments
  FOR EACH ROW EXECUTE FUNCTION assignments_sync_period();

ALTER TABLE assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY assignments_tenant_isolation ON assignments
  USING      (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

INSERT INTO retention_scope (table_name, tier, reason) VALUES
  ('assignments', 'accountability', 'who was rostered where');
