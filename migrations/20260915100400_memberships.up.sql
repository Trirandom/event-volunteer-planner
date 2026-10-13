-- What a user may do, and in which organisation. This is the tenant-scoped
-- half of identity, and the first table subject to the uniform policy.
CREATE TABLE memberships (
  id         uuid PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       member_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);
CREATE INDEX ON memberships (user_id);

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;

CREATE POLICY memberships_tenant_isolation ON memberships
  USING      (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

-- A second policy, and the reason it has to exist.
--
-- `GET /api/v1/auth/me` must answer "which organisations do you belong to?"
-- *before* the caller has chosen one — the whole point of docs/04's rule that
-- the org is never inferred from the session is that a user in two
-- organisations is asked which they mean. But the tenant policy above is keyed
-- to app.current_org_id, which at that moment is not set, so it matches
-- nothing and the answer would always be "none".
--
-- The alternative — a SECURITY DEFINER function, or letting the API read
-- memberships with RLS off — moves the decision out of the schema and into
-- code, where the next reader cannot see it. This keeps it here: a user may
-- read the rows that are about them, and nothing else. PostgreSQL ORs multiple
-- permissive policies, so this widens SELECT only, and only to self.
CREATE POLICY memberships_self_read ON memberships FOR SELECT
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

INSERT INTO retention_scope (table_name, tier, reason) VALUES
  ('memberships', 'accountability', 'who could act in this organisation, and as what');
