-- The tenant itself.
--
-- `organizations` carries `id`, not `org_id`, so it is outside the uniform
-- tenant policy and outside the CI check that enumerates `org_id` columns
-- (docs/03). It still gets RLS, because "which organisations exist" is itself
-- tenant-visible information: without a policy, any authenticated session could
-- enumerate every tenant on a shared deployment.
CREATE TABLE organizations (
  id          uuid PRIMARY KEY,
  slug        citext NOT NULL UNIQUE,
  name        text   NOT NULL,
  -- Default for events created under this organisation, not a display setting.
  -- Storage is always UTC (ADR-0019); this is what a naive local time is
  -- interpreted against.
  timezone    text   NOT NULL DEFAULT 'Europe/Paris',
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organizations_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$')
);

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
-- ENABLE alone still exempts the table owner, and evp_migrator owns every
-- table here. FORCE is what makes the policy apply to the owner too.
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;

-- Keyed on `id` rather than `org_id`, which is the same predicate spelled for
-- this one table. WITH CHECK as well as USING: USING alone would let a handler
-- INSERT a row for another tenant and simply not be able to read it back.
CREATE POLICY organizations_tenant_isolation ON organizations
  USING      (id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (id = current_setting('app.current_org_id', true)::uuid);

INSERT INTO retention_scope (table_name, tier, reason) VALUES
  ('organizations', 'accountability', 'the tenant itself; outlives every event it ran');
