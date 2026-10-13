-- docs/03 §3.4. One concern: the shift table plus the hard invariant that a
-- shift cannot fall outside its event (one of the six rules, docs/02 §5 and
-- docs/05 §2) — the two travel together because the invariant has nothing to
-- protect before the table exists.
CREATE TABLE shifts (
  id             uuid PRIMARY KEY,
  org_id         uuid NOT NULL,
  event_id       uuid NOT NULL,
  location_id    uuid NOT NULL,
  title          text,
  period         tstzrange NOT NULL,
  required_count smallint NOT NULL DEFAULT 1 CHECK (required_count >= 0),
  max_count      smallint CHECK (max_count IS NULL OR max_count >= required_count),
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  version        int NOT NULL DEFAULT 1,
  UNIQUE (id, org_id),
  FOREIGN KEY (event_id, org_id)    REFERENCES events(id, org_id)    ON DELETE CASCADE,
  FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id) ON DELETE CASCADE,
  CONSTRAINT shifts_period_valid CHECK (
    NOT isempty(period) AND lower(period) IS NOT NULL AND upper(period) IS NOT NULL
  ),
  CONSTRAINT shifts_period_sane CHECK (upper(period) - lower(period) <= interval '24 hours')
);
CREATE INDEX shifts_event_period ON shifts USING gist (event_id, period);
CREATE INDEX ON shifts (location_id);

CREATE TRIGGER shifts_bump_version
  BEFORE UPDATE ON shifts
  FOR EACH ROW EXECUTE FUNCTION bump_version();

-- HARD INVARIANT: a shift cannot fall outside its event (docs/03 §3.4).
-- Cannot be a CHECK — the bound compared against lives on another row — so
-- it is a constraint trigger in both directions: neither moving the shift nor
-- shrinking the event can produce a shift outside its event.
CREATE FUNCTION shifts_within_event() RETURNS trigger AS $$
DECLARE ev tstzrange;
BEGIN
  SELECT e.period INTO ev FROM events e WHERE e.id = NEW.event_id;
  IF NOT (NEW.period <@ ev) THEN
    RAISE EXCEPTION 'shift period % is outside event period %', NEW.period, ev
      USING ERRCODE = 'check_violation', CONSTRAINT = 'shift_outside_event';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER shifts_within_event_check
  AFTER INSERT OR UPDATE OF period, event_id ON shifts
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION shifts_within_event();

-- the other direction: an event's period may not shrink away from its shifts
CREATE FUNCTION events_period_covers_shifts() RETURNS trigger AS $$
DECLARE stray int;
BEGIN
  SELECT count(*) INTO stray FROM shifts s
   WHERE s.event_id = NEW.id AND NOT (s.period <@ NEW.period);
  IF stray > 0 THEN
    RAISE EXCEPTION '% shift(s) would fall outside the new event period', stray
      USING ERRCODE = 'check_violation', CONSTRAINT = 'shift_outside_event';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER events_period_covers_shifts_check
  AFTER UPDATE OF period ON events
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION events_period_covers_shifts();

ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE shifts FORCE ROW LEVEL SECURITY;
CREATE POLICY shifts_tenant_isolation ON shifts
  USING      (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

INSERT INTO retention_scope (table_name, tier, reason) VALUES
  ('shifts', 'accountability', 'the schedule grid for an edition; structural, not personal data');
