-- How a working window is cut into slots (docs/03 §3.4, ADR-0029). Comes
-- before `events` and `locations` because both reference one, and it is
-- org-scoped rather than event-scoped so the division survives from one
-- edition to the next — the reuse is the point.
CREATE TYPE pattern_repeat       AS ENUM ('tile', 'once');
CREATE TYPE pattern_segment_kind AS ENUM ('shift', 'gap');

CREATE TABLE shift_patterns (
  id         uuid PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name       text NOT NULL,
  repeat     pattern_repeat NOT NULL DEFAULT 'tile',
  on_remainder text NOT NULL DEFAULT 'drop'
    CHECK (on_remainder IN ('drop', 'truncate')),
  is_archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version    int NOT NULL DEFAULT 1,
  UNIQUE (org_id, name),
  UNIQUE (id, org_id)
);

CREATE TABLE shift_pattern_segments (
  pattern_id       uuid NOT NULL,
  org_id           uuid NOT NULL,
  position         smallint NOT NULL CHECK (position >= 0),
  kind             pattern_segment_kind NOT NULL DEFAULT 'shift',
  duration_minutes int NOT NULL CHECK (duration_minutes BETWEEN 5 AND 1440),
  label            text,
  PRIMARY KEY (pattern_id, position),
  FOREIGN KEY (pattern_id, org_id) REFERENCES shift_patterns(id, org_id) ON DELETE CASCADE
);

-- A pattern with no 'shift' segment, or with holes in its ordering, generates
-- either nothing or the wrong thing. DEFERRABLE INITIALLY DEFERRED so the
-- whole pattern is judged at COMMIT: inserting the pattern, then five
-- segments, then committing is the normal path and must not fail halfway.
CREATE FUNCTION shift_pattern_is_well_formed() RETURNS trigger AS $$
DECLARE pid uuid; n int; shifts int; top int;
BEGIN
  IF TG_OP = 'DELETE' THEN pid := OLD.pattern_id; ELSE pid := NEW.pattern_id; END IF;

  -- Deleting the pattern cascades to its segments and fires this trigger with
  -- nothing left to judge; without this guard no pattern could ever be deleted.
  PERFORM 1 FROM shift_patterns WHERE id = pid;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT count(*), count(*) FILTER (WHERE kind = 'shift'), coalesce(max(position), -1)
    INTO n, shifts, top
    FROM shift_pattern_segments WHERE pattern_id = pid;
  IF shifts = 0 THEN
    RAISE EXCEPTION 'shift pattern % has no shift segment', pid
      USING ERRCODE = 'check_violation', CONSTRAINT = 'pattern_empty';
  END IF;
  IF top <> n - 1 THEN
    RAISE EXCEPTION 'shift pattern % has gaps in its segment ordering', pid
      USING ERRCODE = 'check_violation', CONSTRAINT = 'pattern_positions_contiguous';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER shift_pattern_segments_well_formed
  AFTER INSERT OR UPDATE OR DELETE ON shift_pattern_segments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION shift_pattern_is_well_formed();

ALTER TABLE shift_patterns ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_patterns FORCE ROW LEVEL SECURITY;
CREATE POLICY shift_patterns_tenant_isolation ON shift_patterns
  USING      (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE shift_pattern_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_pattern_segments FORCE ROW LEVEL SECURITY;
CREATE POLICY shift_pattern_segments_tenant_isolation ON shift_pattern_segments
  USING      (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

INSERT INTO retention_scope (table_name, tier, reason) VALUES
  ('shift_patterns',         'accountability', 'how a working window is cut into slots; configuration, not personal data'),
  ('shift_pattern_segments', 'accountability', 'segment list of a shift pattern; configuration, not personal data');
