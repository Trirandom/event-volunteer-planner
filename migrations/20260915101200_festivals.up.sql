-- A festival groups several events that share one production (ADR-0032):
-- "Soundclash 26" is one festival containing an Open Air day, two club
-- nights, an after, and its own montage/démontage days — each with its own
-- period and its own locations, but one thing coordinators plan and one thing
-- volunteers apply to. `festivals` is new relative to docs/03 as written; this
-- migration and ADR-0032 are what add it, and docs/03 is updated to describe
-- it as a living document (ADR-0001 governs the ADR itself, not the schema
-- doc).
--
-- `event_status` is declared here rather than with `events`, because the two
-- tables share the same lifecycle vocabulary and a festival is the first of
-- the pair to need it. Adding a status to `events` later is one column and an
-- ALTER TYPE ... ADD VALUE if the set itself needs to grow.
CREATE TYPE event_status AS ENUM ('draft', 'planning', 'published', 'running', 'archived');

CREATE TABLE festivals (
  id         uuid PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name       text NOT NULL,
  slug       citext NOT NULL,
  timezone   text NOT NULL,
  period     tstzrange NOT NULL,           -- the outer window; member events may run outside office hours but not outside this
  status     event_status NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version    int NOT NULL DEFAULT 1,
  UNIQUE (org_id, slug),
  UNIQUE (id, org_id),                     -- anchor for events.festival_id
  CONSTRAINT festivals_period_valid CHECK (NOT isempty(period) AND lower(period) IS NOT NULL AND upper(period) IS NOT NULL),
  CONSTRAINT festivals_timezone_known FOREIGN KEY (timezone) REFERENCES timezones(name)
);

-- version bump on UPDATE, matching the optimistic-concurrency convention
-- described in docs/03 §2 for events/shifts/assignments/locations.
CREATE FUNCTION bump_version() RETURNS trigger AS $$
BEGIN
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER festivals_bump_version
  BEFORE UPDATE ON festivals
  FOR EACH ROW EXECUTE FUNCTION bump_version();

ALTER TABLE festivals ENABLE ROW LEVEL SECURITY;
ALTER TABLE festivals FORCE ROW LEVEL SECURITY;
CREATE POLICY festivals_tenant_isolation ON festivals
  USING      (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

INSERT INTO retention_scope (table_name, tier, reason) VALUES
  ('festivals', 'accountability', 'the grouping of a production''s events; outlives any single edition''s personal data');
