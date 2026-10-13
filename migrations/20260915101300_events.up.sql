-- docs/03 §3.4, plus `festival_id`, which is new (ADR-0032). Nullable: a
-- standalone event with no festival is still the common case for a
-- single-day org, and requiring one would force every existing workflow
-- through a grouping it does not need.
CREATE TABLE events (
  id           uuid PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  festival_id  uuid,
  name         text NOT NULL,
  slug         citext NOT NULL,
  timezone     text NOT NULL,
  period       tstzrange NOT NULL,
  status       event_status NOT NULL DEFAULT 'draft',
  duplicated_from uuid REFERENCES events(id) ON DELETE SET NULL,

  max_hours_per_day       numeric(4,2) NOT NULL DEFAULT 10,
  min_rest_minutes        int          NOT NULL DEFAULT 480,
  max_consecutive_days    int          NOT NULL DEFAULT 5,
  night_starts_at         time         NOT NULL DEFAULT '22:00',
  night_ends_at           time         NOT NULL DEFAULT '06:00',
  availability_step_minutes int        NOT NULL DEFAULT 30
    CHECK (availability_step_minutes IN (15, 30, 60)),
  default_shift_pattern_id uuid,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  version      int NOT NULL DEFAULT 1,
  UNIQUE (org_id, slug),
  UNIQUE (id, org_id),
  CONSTRAINT events_period_valid CHECK (NOT isempty(period) AND lower(period) IS NOT NULL AND upper(period) IS NOT NULL),
  CONSTRAINT events_timezone_known FOREIGN KEY (timezone) REFERENCES timezones(name),
  FOREIGN KEY (festival_id, org_id) REFERENCES festivals(id, org_id) ON DELETE SET NULL (festival_id),
  FOREIGN KEY (default_shift_pattern_id, org_id)
    REFERENCES shift_patterns(id, org_id) ON DELETE SET NULL (default_shift_pattern_id)
);
CREATE INDEX ON events (festival_id) WHERE festival_id IS NOT NULL;

CREATE TRIGGER events_bump_version
  BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION bump_version();

ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE events FORCE ROW LEVEL SECURITY;
CREATE POLICY events_tenant_isolation ON events
  USING      (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

INSERT INTO retention_scope (table_name, tier, reason) VALUES
  ('events', 'accountability', 'the edition itself; outlives the event-tier data purged 30 days after it runs');
